import { describe, expect, it } from "vitest";
import {
  decryptValue,
  KeyUnavailableError,
  openValue,
  sameKey,
  sealValue,
  UndecryptableValueError,
} from "./crypto.js";
import { formatEnvelope, parseEnvelope, TAG_BYTES } from "./envelope.js";
import type { KeySource } from "./keys.js";
import { KEY_BYTES, nullKeySource } from "./keys.js";
import type { ParameterRef, Scope, ValueFile } from "./types.js";

/**
 * A source holding exactly one key, standing in for `createEnvKeySource` without
 * touching `process.env` — these tests are about the cipher, and a source that
 * read the ambient environment would make them pass or fail on what the runner
 * exported.
 */
function fixedKeySource(keyId: string, seed: number): KeySource {
  const key = new Uint8Array(KEY_BYTES).fill(seed);
  const found = { kind: "found", keyId, key } as const;
  return {
    type: "fixed",
    lookup: (asked) =>
      asked === keyId
        ? found
        : { kind: "absent", detail: `this source holds \`${keyId}\`, not \`${asked}\`` },
    current: () => found,
  };
}

/** Records every id asked for, so a test can assert a decision never touched a key. */
function spyingKeySource(inner: KeySource): { source: KeySource; lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    source: {
      type: inner.type,
      lookup(keyId) {
        lookups.push(keyId);
        return inner.lookup(keyId);
      },
      current: () => inner.current(),
    },
  };
}

const keys = fixedKeySource("prod-key", 7);
const otherKeys = fixedKeySource("prod-key", 9);

const password: ParameterRef = { namespace: ["redis"], name: "password" };

function valueFile(scope: Scope, encrypted = true, ref: ParameterRef = password): ValueFile {
  return { namespace: ref.namespace, name: ref.name, scope, encrypted };
}

const production: Scope = { kind: "environment", environment: "production" };
const unscoped: Scope = { kind: "unscoped" };

function seal(file: ValueFile, value: string, source: KeySource = keys): string {
  return sealValue(file, value, source, "redis.password", "production");
}

/** Rewrites an envelope's sealed bytes, leaving every other field intact. */
function withSealed(text: string, change: (sealed: Uint8Array) => Uint8Array): string {
  const envelope = parseEnvelope(text);
  if (envelope === undefined) {
    throw new Error("fixture is not an envelope");
  }
  return formatEnvelope({ ...envelope, sealed: change(new Uint8Array(envelope.sealed)) });
}

describe("sealValue and decryptValue round-trip", () => {
  /*
   * Values are opaque: whatever went in comes out byte for byte. These mirror the
   * cases the provider contract pins, because encryption sits below the provider
   * — a value that survived storage but not the cipher is the same outage.
   */
  const cases: readonly (readonly [string, string])[] = [
    ["an empty value", ""],
    ["a single character", "x"],
    ["leading and trailing spaces", "  padded  "],
    ["an embedded newline", "line one\nline two"],
    ["a trailing newline", "trailing\n"],
    ["several trailing newlines", "trailing\n\n\n"],
    ["a lone carriage return", "crlf\r\nvalue"],
    ["unicode", "clé-privée-🔐-Ω"],
    ["quotes and escapes", `{"a":"b\\n"} 'single' "double"`],
    ["a base64-shaped value", "aGVsbG8gd29ybGQ=\n"],
  ];

  for (const [label, value] of cases) {
    it(`preserves ${label} byte-exactly`, () => {
      const file = valueFile(production);

      const result = decryptValue(file, seal(file, value), keys);

      expect(result).toEqual({ kind: "plaintext", value });
    });
  }

  it("never writes the plaintext into the envelope", () => {
    const file = valueFile(production);

    expect(seal(file, "hunter2")).not.toContain("hunter2");
  });

  it("seals the same value differently each time, so equal secrets are not visibly equal", () => {
    // A fresh nonce per seal. Without one, two files holding the same secret
    // would be byte-identical in the repository, which is a disclosure.
    const file = valueFile(production);

    expect(seal(file, "hunter2")).not.toBe(seal(file, "hunter2"));
  });

  it("names the key in the envelope, so every file says what opens it", () => {
    const file = valueFile(production);

    expect(parseEnvelope(seal(file, "hunter2"))?.keyId).toBe("prod-key");
  });
});

/*
 * The scope-widening leak, closed at the one layer that could reintroduce it.
 * The cascade keeps `<name>.production` from serving every environment, but the
 * cascade only sees filenames — without the address in the AAD, copying the
 * production ciphertext over the unscoped default would silently promote a
 * production secret to the value every environment falls back to.
 */
describe("decryptValue binds a value to its address", () => {
  it("refuses a production ciphertext copied over the unscoped default", () => {
    const sealed = seal(valueFile(production), "hunter2");

    const result = decryptValue(valueFile(unscoped), sealed, keys);

    expect(result).toEqual({
      kind: "failed",
      failure: { reason: "undecipherable", detail: expect.stringContaining("redis/password") },
    });
  });

  it("refuses a ciphertext copied between two environments", () => {
    const sealed = seal(valueFile(production), "hunter2");

    const result = decryptValue(
      valueFile({ kind: "environment", environment: "staging" }),
      sealed,
      keys,
    );

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "undecipherable" } });
  });

  it("refuses a ciphertext copied from a personal override onto the shared scope", () => {
    const sealed = seal(valueFile({ kind: "environment-local", environment: "production" }), "h");

    const result = decryptValue(valueFile(production), sealed, keys);

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "undecipherable" } });
  });

  it("refuses a ciphertext copied onto a different parameter", () => {
    const sealed = seal(valueFile(production), "hunter2");

    const result = decryptValue(
      valueFile(production, true, { namespace: ["redis"], name: "username" }),
      sealed,
      keys,
    );

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "undecipherable" } });
  });

  it("opens at the address it was sealed for", () => {
    // The stays-quiet half: the binding must refuse a move, not every read.
    const file = valueFile(production);

    expect(decryptValue(file, seal(file, "hunter2"), keys)).toEqual({
      kind: "plaintext",
      value: "hunter2",
    });
  });
});

describe("decryptValue failures", () => {
  it("reports undecipherable for the wrong key", () => {
    const file = valueFile(production);
    // Same key id, different bytes: the id names a key, it does not prove one.
    const sealed = seal(file, "hunter2", otherKeys);

    expect(decryptValue(file, sealed, keys)).toMatchObject({
      kind: "failed",
      failure: { reason: "undecipherable" },
    });
  });

  it("reports undecipherable for a flipped byte in the ciphertext", () => {
    // GCM is authenticated: a damaged credential fails to open rather than
    // opening as something else, which would be an outage with no error on it.
    const file = valueFile(production);
    const damaged = withSealed(seal(file, "hunter2"), (sealed) => {
      const first = sealed[0];
      if (first === undefined) {
        throw new Error("fixture has no sealed bytes");
      }
      sealed[0] = first ^ 0xff;
      return sealed;
    });

    expect(decryptValue(file, damaged, keys)).toMatchObject({
      kind: "failed",
      failure: { reason: "undecipherable" },
    });
  });

  it("reports undecipherable for a truncated ciphertext that still carries a tag", () => {
    const file = valueFile(production);
    const truncated = withSealed(seal(file, "a much longer secret value"), (sealed) =>
      sealed.subarray(0, TAG_BYTES + 1),
    );

    expect(decryptValue(file, truncated, keys)).toMatchObject({
      kind: "failed",
      failure: { reason: "undecipherable" },
    });
  });

  it("names the file and the key it did not open under", () => {
    const file = valueFile(production);

    const result = decryptValue(file, seal(file, "hunter2", otherKeys), keys);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") {
      throw new Error("expected a failure");
    }
    expect(result.failure.detail).toContain("redis/password.production.enc");
    expect(result.failure.detail).toContain("prod-key");
  });

  /*
   * Deciding that bytes are not an envelope must not touch a key. A plaintext
   * value that landed in an `.enc` file is a rename, not a key problem, and
   * reporting it as one sends the user hunting for a key that would not help.
   */
  it("reports malformed-envelope without ever consulting the key source", () => {
    const spy = spyingKeySource(keys);

    const result = decryptValue(valueFile(production), "not-an-envelope", spy.source);

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "malformed-envelope" } });
    expect(spy.lookups).toEqual([]);
  });

  it("reports malformed-envelope for a truncated envelope, still without a key", () => {
    const spy = spyingKeySource(keys);
    const file = valueFile(production);
    const cut = seal(file, "hunter2").slice(0, 20);

    expect(decryptValue(file, cut, spy.source)).toMatchObject({
      kind: "failed",
      failure: { reason: "malformed-envelope" },
    });
    expect(spy.lookups).toEqual([]);
  });

  /*
   * The tri-state's whole point. "I was never told where to look" and "I looked
   * and there is no such key" have opposite remedies: one says declare a `keys`
   * block, the other says export the key. Collapsing them would tell a developer
   * "no key" when the truth is that penv never looked.
   */
  it("reports key-source-unavailable, never key-absent, when there is no key source", () => {
    const file = valueFile(production);

    const result = decryptValue(file, seal(file, "hunter2"), nullKeySource("production"));

    expect(result).toMatchObject({
      kind: "failed",
      failure: { reason: "key-source-unavailable" },
    });
    expect(result.kind === "failed" && result.failure.reason).not.toBe("key-absent");
  });

  it("reports key-absent when a source was consulted and holds no such key", () => {
    const file = valueFile(production);
    const sealed = seal(file, "hunter2");

    const result = decryptValue(file, sealed, fixedKeySource("other-key", 7));

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "key-absent" } });
  });

  it("asks only for the key the envelope names", () => {
    const spy = spyingKeySource(keys);
    const file = valueFile(production);

    decryptValue(file, seal(file, "hunter2"), spy.source);

    expect(spy.lookups).toEqual(["prod-key"]);
  });
});

describe("openValue", () => {
  /*
   * Every walker calls this unconditionally. An `if (file.encrypted)` at each
   * call site would be four places that must agree about what encryption means,
   * and the fourth one is where the bug lives.
   */
  it("returns a plaintext file's contents verbatim without consulting the key source", () => {
    const spy = spyingKeySource(keys);
    const file = valueFile(production, false);

    const result = openValue(file, "  hunter2\n", spy.source);

    expect(result).toEqual({ kind: "plaintext", value: "  hunter2\n" });
    expect(spy.lookups).toEqual([]);
  });

  it("returns a plaintext file's contents verbatim even when they look like an envelope", () => {
    // The filename decides, not the contents: an unencrypted file holding
    // envelope-shaped text is a value, and decrypting it would be penv guessing.
    const spy = spyingKeySource(keys);
    const encrypted = valueFile(production);
    const stored = seal(encrypted, "hunter2");

    const result = openValue(valueFile(production, false), stored, spy.source);

    expect(result).toEqual({ kind: "plaintext", value: stored });
    expect(spy.lookups).toEqual([]);
  });

  it("decrypts an .enc file", () => {
    const file = valueFile(production);

    expect(openValue(file, seal(file, "hunter2"), keys)).toEqual({
      kind: "plaintext",
      value: "hunter2",
    });
  });

  it("reports a failure for an .enc file rather than throwing", () => {
    const file = valueFile(production);

    expect(() => openValue(file, "not-an-envelope", keys)).not.toThrow();
  });
});

describe("sealValue refuses rather than writing plaintext", () => {
  it("throws KeyUnavailableError naming the parameter and the environment", () => {
    const file = valueFile(production);

    const error = ((): unknown => {
      try {
        return sealValue(
          file,
          "hunter2",
          nullKeySource("production"),
          "redis.password",
          "production",
        );
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(KeyUnavailableError);
    if (!(error instanceof KeyUnavailableError)) {
      throw new Error("expected a KeyUnavailableError");
    }
    expect(error.code).toBe("KEY_UNAVAILABLE");
    expect(error.parameter).toBe("redis.password");
    expect(error.environment).toBe("production");
    expect(error.message).toContain("redis.password");
    expect(error.message).toContain("production");
  });

  it("explains that penv will not invent a key rather than suggesting one", () => {
    const file = valueFile(production);

    expect(() =>
      sealValue(file, "hunter2", nullKeySource("production"), "redis.password", "production"),
    ).toThrow(/will not invent a key/);
  });

  it("throws when the source was consulted and holds no key", () => {
    const absent: KeySource = {
      type: "fixed",
      lookup: () => ({ kind: "absent", detail: "PENV_KEY_PROD is not set" }),
      current: () => ({ kind: "absent", detail: "PENV_KEY_PROD is not set" }),
    };

    expect(() =>
      sealValue(valueFile(production), "hunter2", absent, "redis.password", "production"),
    ).toThrow(KeyUnavailableError);
  });
});

describe("UndecryptableValueError", () => {
  it("names the parameter, the environment and the location, with a remedy per reason", () => {
    const error = new UndecryptableValueError(
      "redis.password",
      "production",
      "redis/password.production.enc",
      {
        reason: "key-absent",
        detail: "PENV_KEY_PROD is not set",
      },
    );

    expect(error.code).toBe("VALUE_UNDECRYPTABLE");
    expect(error.message).toContain("redis.password");
    expect(error.message).toContain("production");
    expect(error.message).toContain("redis/password.production.enc");
    expect(error.remedy).toContain("PENV_KEY_PROD is not set");
  });

  it("tells a key-source-unavailable reader to declare a keys block, not to find a key", () => {
    // The remedies differ per reason because the fixes are not the same fix.
    const error = new UndecryptableValueError(
      "redis.password",
      "production",
      "redis/password.enc",
      {
        reason: "key-source-unavailable",
        detail: "no `keys` block",
      },
    );

    expect(error.remedy).toContain("`keys` block");
  });

  it("names all three causes for undecipherable rather than guessing one", () => {
    const error = new UndecryptableValueError(
      "redis.password",
      "production",
      "redis/password.enc",
      {
        reason: "undecipherable",
        detail: "did not open",
      },
    );

    expect(error.remedy).toContain("wrong key");
    expect(error.remedy).toContain("damaged");
    expect(error.remedy).toContain("copied");
  });
});

describe("sameKey", () => {
  it("is true for equal key material and false for different material", () => {
    expect(sameKey(new Uint8Array(KEY_BYTES).fill(7), new Uint8Array(KEY_BYTES).fill(7))).toBe(
      true,
    );
    expect(sameKey(new Uint8Array(KEY_BYTES).fill(7), new Uint8Array(KEY_BYTES).fill(9))).toBe(
      false,
    );
  });

  it("is false for keys of different lengths rather than throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a
    // comparison into a crash on the one input it most needs to answer for.
    expect(sameKey(new Uint8Array(KEY_BYTES).fill(7), new Uint8Array(16).fill(7))).toBe(false);
  });
});
