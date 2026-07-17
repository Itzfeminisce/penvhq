import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PenvError } from "./errors.js";
import type { Keychain } from "./keys.js";
import {
  createEnvKeySource,
  createKeychainKeySource,
  KEY_BYTES,
  nullKeySource,
  resolveKeySource,
  setKeychain,
} from "./keys.js";
import type { KeyConfig, PenvConfig } from "./types.js";

/** A keychain backed by a plain map, so a test never touches the real OS keychain. */
function mapKeychain(entries: Readonly<Record<string, string>> = {}): Keychain {
  const store = new Map(Object.entries(entries));
  return {
    getPassword: (_service, account) => store.get(account) ?? null,
    setPassword: (_service, account, password) => void store.set(account, password),
  };
}

/** A keychain that cannot be consulted at all — a locked keychain, or a missing binding. */
function lockedKeychain(): Keychain {
  return {
    getPassword() {
      throw new Error("the keychain is locked");
    },
    setPassword() {
      throw new Error("the keychain is locked");
    },
  };
}

/**
 * Every variable this file sets, restored after each case. A test that leaked a
 * `PENV_KEY_*` into the runner would make a later test pass on a key it never
 * exported — and the failure would land in whichever file happened to run next.
 */
const touched = new Set<string>();
const original = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!touched.has(name)) {
    touched.add(name);
    original.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of touched) {
    const value = original.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  touched.clear();
  original.clear();
  // No test leaks a registered keychain backend into the next; the default is
  // "none registered", which a keychain source reports as `unavailable`.
  setKeychain(undefined);
});

/** A key of `length` bytes, exported the way a deploy exports one. */
function exportedKey(length: number): string {
  return Buffer.alloc(length, 7).toString("base64");
}

const prod: KeyConfig = { source: "env", id: "prod" };

const config: PenvConfig = {
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
};

describe("createEnvKeySource", () => {
  it("finds a 32-byte key exported under its variable", () => {
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));

    const lookup = createEnvKeySource(prod).lookup("prod");

    expect(lookup.kind).toBe("found");
    expect(lookup.kind === "found" && lookup.keyId).toBe("prod");
    expect(lookup.kind === "found" && lookup.key).toEqual(new Uint8Array(KEY_BYTES).fill(7));
  });

  it("ignores surrounding whitespace, so an exported key with a newline still reads", () => {
    setEnv("PENV_KEY_PROD", `\n${exportedKey(KEY_BYTES)}\n`);

    expect(createEnvKeySource(prod).lookup("prod").kind).toBe("found");
  });

  it("answers the same key from current() as from lookup()", () => {
    // The write path and the read path must agree; two answers to one question
    // would seal under a key the other cannot find.
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));
    const source = createEnvKeySource(prod);

    expect(source.current()).toEqual(source.lookup("prod"));
  });

  it("reports the type it is", () => {
    expect(createEnvKeySource(prod).type).toBe("env");
  });

  /*
   * A key of the wrong size is not a key penv can use, and it is never padded or
   * truncated into one — either would seal values under a key nobody chose. The
   * detail names the length it actually got, because the user's next question is
   * "then what did I export?".
   */
  it("refuses a 16-byte key, naming the byte length it actually decoded", () => {
    setEnv("PENV_KEY_PROD", exportedKey(16));

    const lookup = createEnvKeySource(prod).lookup("prod");

    expect(lookup.kind).toBe("absent");
    expect(lookup.kind === "absent" && lookup.detail).toContain("16 bytes");
    expect(lookup.kind === "absent" && lookup.detail).toContain("PENV_KEY_PROD");
  });

  it("refuses a 64-byte key too — a long key is never truncated", () => {
    setEnv("PENV_KEY_PROD", exportedKey(64));

    const lookup = createEnvKeySource(prod).lookup("prod");

    expect(lookup.kind).toBe("absent");
    expect(lookup.kind === "absent" && lookup.detail).toContain("64 bytes");
  });

  /*
   * `Buffer.from(text, "base64")` ignores characters outside the alphabet, so a
   * typo'd key decodes to *something*. Checking the shape first makes the typo
   * say it is a typo, rather than surfacing later as an unexplained
   * `undecipherable` on a value that was sealed correctly.
   */
  it("refuses a value that is not base64, saying so rather than decoding it anyway", () => {
    setEnv("PENV_KEY_PROD", "this is definitely not a key!");

    const lookup = createEnvKeySource(prod).lookup("prod");

    expect(lookup.kind).toBe("absent");
    expect(lookup.kind === "absent" && lookup.detail).toContain("not base64");
  });

  it("says the variable is not set when it is unset or blank", () => {
    setEnv("PENV_KEY_PROD", undefined);
    expect(createEnvKeySource(prod).lookup("prod")).toMatchObject({
      kind: "absent",
      detail: "PENV_KEY_PROD is not set",
    });

    setEnv("PENV_KEY_PROD", "   ");
    expect(createEnvKeySource(prod).lookup("prod")).toMatchObject({
      kind: "absent",
      detail: "PENV_KEY_PROD is not set",
    });
  });

  it("reads `prod-key` from PENV_KEY_PROD_KEY", () => {
    // The transform is a compatibility surface: it is how a deploy knows what to
    // export, so a change to it silently stops finding every key already set.
    setEnv("PENV_KEY_PROD_KEY", exportedKey(KEY_BYTES));

    expect(createEnvKeySource({ source: "env", id: "prod-key" }).lookup("prod-key").kind).toBe(
      "found",
    );
  });

  it("uppercases and replaces every non-alphanumeric character", () => {
    setEnv("PENV_KEY_TEAM_A_2024_KEY", exportedKey(KEY_BYTES));

    expect(
      createEnvKeySource({ source: "env", id: "team.a-2024_key" }).lookup("team.a-2024_key").kind,
    ).toBe("found");
  });

  /*
   * An env source holds exactly one key. Returning it for another id would claim
   * to open a value sealed under a key penv no longer has — and GCM would then
   * report the mismatch as an unexplained `undecipherable` instead of a missing
   * key.
   */
  it("is absent for a keyId other than the one it holds, even with the key exported", () => {
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));

    const lookup = createEnvKeySource(prod).lookup("staging");

    expect(lookup.kind).toBe("absent");
    expect(lookup.kind === "absent" && lookup.detail).toContain("`prod`");
    expect(lookup.kind === "absent" && lookup.detail).toContain("`staging`");
  });
});

/*
 * Never `absent`. penv was never told where to look, so it has not looked, and
 * reporting "no such key" would send the user to create one when the fix is to
 * declare where keys live.
 */
describe("nullKeySource", () => {
  it("is unavailable for any keyId, never absent", () => {
    const source = nullKeySource("production");

    for (const id of ["prod", "staging", ""]) {
      const lookup = source.lookup(id);
      expect(lookup.kind).toBe("unavailable");
      expect(lookup.kind).not.toBe("absent");
    }
  });

  it("is unavailable from current() too, so the write path refuses rather than invents", () => {
    expect(nullKeySource("production").current().kind).toBe("unavailable");
  });

  it("names the environment and the `keys` block in its detail", () => {
    const lookup = nullKeySource("production").lookup("prod");

    expect(lookup.kind === "unavailable" && lookup.detail).toContain("production");
    expect(lookup.kind === "unavailable" && lookup.detail).toContain("`keys` block");
  });
});

describe("resolveKeySource", () => {
  it("returns the null source for an environment with no keys block", () => {
    expect(resolveKeySource(config, "production").type).toBe("none");
  });

  it("returns the null source for an environment absent from a keys block that exists", () => {
    const withKeys: PenvConfig = { ...config, keys: { development: prod } };

    expect(resolveKeySource(withKeys, "production").type).toBe("none");
  });

  it("returns an env source for a declared env key", () => {
    const withKeys: PenvConfig = { ...config, keys: { production: prod } };

    expect(resolveKeySource(withKeys, "production").type).toBe("env");
  });

  /*
   * The load-bearing non-downgrade. `keychain` resolves to a keychain source and
   * never to the env source — even when a key is exported under the name the env
   * source would read, so a downgrade would succeed and go unnoticed. Sealing
   * under a key the user never chose while the config said `keychain` is exactly
   * the silent downgrade this module exists to make impossible.
   */
  it("resolves `keychain` to a keychain source, never downgrading to env", () => {
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));
    const withKeys: PenvConfig = {
      ...config,
      keys: { production: { source: "keychain", id: "prod" } },
    };

    const source = resolveKeySource(withKeys, "production");

    expect(source.type).toBe("keychain");
    // With no keychain backend registered it answers `unavailable` — never the
    // env key sitting in PENV_KEY_PROD.
    expect(source.current().kind).toBe("unavailable");
  });

  /*
   * The silent downgrade this module exists to make impossible.
   *
   * `KeyConfig.source` is a two-member union, and at this line that union is a
   * fiction: `loadConfigFrom` casts a user's TypeScript file unchecked, so
   * `source` is whatever they typed. A check that refused only `keychain` would
   * let every name penv has never heard of fall through to the env source, and
   * `source: "vault"` would seal production secrets under `PENV_KEY_PROD` while
   * the config still said Vault. `validateConfig` names it too, but only for
   * someone who ran `penv validate`; sealing a value must not depend on that.
   *
   * The cast is the test, not a shortcut around one: TypeScript does not protect
   * this line at runtime, so the runtime must protect itself.
   */
  it("throws KEY_SOURCE_UNSUPPORTED for `vault` rather than downgrading to env", () => {
    // Exported under the name an env source reads, so a downgrade would succeed
    // and nothing would ever say penv had chosen the key itself.
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));
    const withKeys = {
      ...config,
      keys: { production: { source: "vault", id: "prod" } },
    } as unknown as PenvConfig;

    const error = ((): unknown => {
      try {
        return resolveKeySource(withKeys, "production");
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    // Asserted as "not a source" before it is asserted as an error: a test that
    // only matched the message would keep passing on the broken code if the
    // throw were later moved behind the fall-through it is meant to prevent.
    expect(error).not.toMatchObject({ type: "env" });
    expect(error).toBeInstanceOf(PenvError);
    if (!(error instanceof PenvError)) {
      throw new Error("expected a PenvError, not a key source");
    }
    expect(error.code).toBe("KEY_SOURCE_UNSUPPORTED");
    expect(error.message).toContain("production");
    // The bad source is named back: the user's next question is "then what did
    // I declare?", and a message that omitted it could not answer.
    expect(error.message).toContain("vault");
    expect(error.remedy).toContain("`vault` is not a key source penv knows");
    // The remedy points at the source that does work, and at the variable the
    // key must be exported under — the two facts that unblock the user.
    expect(error.remedy).toContain('source: "env"');
    expect(error.remedy).toContain("PENV_KEY_PROD");
  });

  /*
   * The junk `source` is unbounded — a typo, a copied example, a source from a
   * later release. Every one of them refuses, because the allow-list is the one
   * source that works rather than the ones penv happens to have heard of.
   */
  it.each([
    ["a plausible-looking service", "aws-kms"],
    ["a near miss for `env`", "ENV"],
    ["a typo", "environment"],
    ["the empty string", ""],
  ])("throws KEY_SOURCE_UNSUPPORTED for %s", (_label, source) => {
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));
    const withKeys = {
      ...config,
      keys: { production: { source, id: "prod" } },
    } as unknown as PenvConfig;

    const error = ((): unknown => {
      try {
        return resolveKeySource(withKeys, "production");
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).not.toMatchObject({ type: "env" });
    expect(error).toBeInstanceOf(PenvError);
    expect(error instanceof PenvError && error.code).toBe("KEY_SOURCE_UNSUPPORTED");
  });

  /*
   * `env` is case-sensitive and exact, so the stays-quiet half is narrow: only
   * the literal string is a source. Without this, the refusal above could be
   * satisfied by a check that refused everything.
   */
  it("still returns an env source for the one source that works", () => {
    setEnv("PENV_KEY_PROD", exportedKey(KEY_BYTES));
    const withKeys: PenvConfig = { ...config, keys: { production: prod } };

    const source = resolveKeySource(withKeys, "production");

    expect(source.type).toBe("env");
    expect(source.current().kind).toBe("found");
  });

  it("resolves each declared source independently — env and keychain side by side", () => {
    const withKeys: PenvConfig = {
      ...config,
      keys: {
        development: { source: "env", id: "dev" },
        production: { source: "keychain", id: "prod" },
      },
    };

    expect(resolveKeySource(withKeys, "development").type).toBe("env");
    expect(resolveKeySource(withKeys, "production").type).toBe("keychain");
  });
});

describe("createKeychainKeySource", () => {
  const prodKeychain: KeyConfig = { source: "keychain", id: "prod" };

  it("finds a 32-byte base64 key stored in the keychain under its id", () => {
    const source = createKeychainKeySource(
      prodKeychain,
      mapKeychain({ prod: exportedKey(KEY_BYTES) }),
    );

    const lookup = source.lookup("prod");
    expect(lookup.kind).toBe("found");
    expect(lookup.kind === "found" && lookup.keyId).toBe("prod");
    expect(lookup.kind === "found" && lookup.key).toEqual(new Uint8Array(KEY_BYTES).fill(7));
  });

  it("answers the same key from current() as from lookup(), so seal and open agree", () => {
    const source = createKeychainKeySource(
      prodKeychain,
      mapKeychain({ prod: exportedKey(KEY_BYTES) }),
    );
    expect(source.current()).toEqual(source.lookup("prod"));
  });

  it("returns `absent` for a lookup of any id but its own, never its key under the wrong name", () => {
    const source = createKeychainKeySource(
      prodKeychain,
      mapKeychain({ prod: exportedKey(KEY_BYTES) }),
    );
    expect(source.lookup("staging").kind).toBe("absent");
  });

  it("returns `absent` when the keychain is readable but holds no such key", () => {
    const source = createKeychainKeySource(prodKeychain, mapKeychain({}));
    expect(source.current().kind).toBe("absent");
  });

  it("returns `unavailable`, not `absent`, when the keychain cannot be consulted", () => {
    const source = createKeychainKeySource(prodKeychain, lockedKeychain());
    expect(source.current().kind).toBe("unavailable");
  });

  it("returns `unavailable` when no keychain binding is registered", () => {
    const source = createKeychainKeySource(prodKeychain);
    expect(source.current().kind).toBe("unavailable");
  });

  it("uses the registered binding when none is injected", () => {
    setKeychain(mapKeychain({ prod: exportedKey(KEY_BYTES) }));
    expect(createKeychainKeySource(prodKeychain).current().kind).toBe("found");
  });

  it("rejects a stored value that is not a 32-byte key as `absent`, never a wrong-length key", () => {
    const source = createKeychainKeySource(prodKeychain, mapKeychain({ prod: exportedKey(16) }));
    const lookup = source.current();
    expect(lookup.kind).toBe("absent");
    expect(lookup.kind === "absent" && lookup.detail).toContain("16 bytes");
  });
});

/*
 * The invariant the whole keychain design rests on: core carries no native
 * module. The runtime depends on core and `load` runs in every deploy, so a
 * native binding in core's tree would be a build failure in someone's container —
 * which is why the keychain binding lives in the CLI and is injected. The
 * runtime's own dep test pins the runtime's DIRECT deps, but a native module
 * added to core would enter the deploy tree transitively and slip past it. This
 * pins core itself.
 */
describe("the native-free invariant core depends on", () => {
  it("declares no native or keychain dependency in @penv/core", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    const { dependencies } = manifest as { dependencies: Readonly<Record<string, string>> };

    expect(Object.keys(dependencies)).toEqual(["jiti"]);
    // Belt and braces: no keychain/napi module by any name, now or later.
    expect(Object.keys(dependencies).some((name) => /keyring|keytar|napi/i.test(name))).toBe(false);
  });
});
