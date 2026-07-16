import { describe, expect, it } from "vitest";
import { PenvError } from "./errors.js";
import { formatValueFile, parseFilename } from "./grammar.js";
import { candidatesFor, resolveAll, resolveParameter } from "./resolve.js";
import type { Meta, ParameterRef, PenvConfig, Provider, ValueFile } from "./types.js";

const config: PenvConfig = {
  environments: ["development", "test", "staging", "production"],
  providers: { development: { type: "filesystem" } },
};

/** An in-memory provider keyed by `formatValueFile`, standing in for the filesystem. */
function fakeProvider(entries: Readonly<Record<string, string>>): Provider {
  const values = new Map<string, string>(Object.entries(entries));
  return {
    type: "fake",
    read: (file: ValueFile) => Promise.resolve(values.get(formatValueFile(file))),
    write: (file: ValueFile, value: string) => {
      values.set(formatValueFile(file), value);
      return Promise.resolve();
    },
    list: () =>
      Promise.resolve(
        [...values.keys()].map((key) => {
          const parsed = parseFilename(key, config);
          if (parsed.kind !== "value") {
            throw new Error(`fixture ${key} is not a value file`);
          }
          const { namespace, name, scope, encrypted } = parsed;
          return { namespace, name, scope, encrypted };
        }),
      ),
    remove: (file: ValueFile) => {
      values.delete(formatValueFile(file));
      return Promise.resolve();
    },
    readMeta: () => Promise.resolve(undefined),
    writeMeta: (_ref: ParameterRef, _meta: Meta) => Promise.resolve(),
  };
}

const password: ParameterRef = { namespace: ["redis"], name: "password" };
const apiUrl: ParameterRef = { namespace: [], name: "api-url" };

describe("candidatesFor", () => {
  it("orders local, then the environment, then the unscoped default", () => {
    expect(candidatesFor(password, "production").map(formatValueFile)).toEqual([
      "redis/password.local",
      "redis/password.local.enc",
      "redis/password.production",
      "redis/password.production.enc",
      "redis/password",
      "redis/password.enc",
    ]);
  });

  it("omits the local scope entirely in test", () => {
    expect(candidatesFor(password, "test").map(formatValueFile)).toEqual([
      "redis/password.test",
      "redis/password.test.enc",
      "redis/password",
      "redis/password.enc",
    ]);
  });
});

describe("resolveParameter precedence", () => {
  it("prefers .local over .<env> over the unscoped default", async () => {
    const provider = fakeProvider({
      "redis/password.local": "from-local",
      "redis/password.production": "from-production",
      "redis/password": "from-default",
    });

    const resolution = await resolveParameter(password, "production", provider);

    expect(resolution.value).toBe("from-local");
    expect(resolution.winner?.location).toBe("redis/password.local");
    expect(resolution.parameter).toBe("redis.password");
  });

  it("prefers .<env> over the unscoped default when no local override exists", async () => {
    const provider = fakeProvider({
      "redis/password.production": "from-production",
      "redis/password": "from-default",
    });

    const resolution = await resolveParameter(password, "production", provider);

    expect(resolution.value).toBe("from-production");
    expect(resolution.winner?.location).toBe("redis/password.production");
  });

  it("ignores .local in the test environment while .<env> still wins there", async () => {
    const provider = fakeProvider({
      "redis/password.local": "from-local",
      "redis/password.test": "from-test",
      "redis/password": "from-default",
    });

    const resolution = await resolveParameter(password, "test", provider);

    expect(resolution.value).toBe("from-test");
    expect(resolution.winner?.location).toBe("redis/password.test");
  });

  it("falls back past a skipped .local to the unscoped default in test", async () => {
    const provider = fakeProvider({
      "redis/password.local": "from-local",
      "redis/password": "from-default",
    });

    const resolution = await resolveParameter(password, "test", provider);

    expect(resolution.value).toBe("from-default");
  });

  it("replaces a lower-precedence value wholesale rather than merging it", async () => {
    const provider = fakeProvider({
      "redis/password": '{"host":"localhost","port":6379}',
      "redis/password.production": '{"host":"redis.internal"}',
    });

    const resolution = await resolveParameter(password, "production", provider);

    // Values are opaque: the default's `port` does not survive into the winner.
    expect(resolution.value).toBe('{"host":"redis.internal"}');
  });

  it("returns undefined value and winner when the parameter is absent everywhere", async () => {
    const resolution = await resolveParameter(password, "production", fakeProvider({}));

    expect(resolution.value).toBeUndefined();
    expect(resolution.winner).toBeUndefined();
    expect(resolution.viaUnscopedFallback).toBe(false);
    expect(resolution.candidates.every((c) => !c.present)).toBe(true);
  });
});

describe("resolveParameter fallback reporting", () => {
  it("reports viaUnscopedFallback when a real environment resolves to the default", async () => {
    const provider = fakeProvider({ "api-url": "https://example.test" });

    const resolution = await resolveParameter(apiUrl, "production", provider);

    expect(resolution.value).toBe("https://example.test");
    expect(resolution.viaUnscopedFallback).toBe(true);
  });

  it("does not report a fallback when the environment-specific value is present", async () => {
    const provider = fakeProvider({
      "api-url.production": "https://api.example.com",
      "api-url": "https://example.test",
    });

    const resolution = await resolveParameter(apiUrl, "production", provider);

    expect(resolution.viaUnscopedFallback).toBe(false);
  });

  it("does not report a fallback when a local override wins", async () => {
    const provider = fakeProvider({ "api-url.local": "http://localhost:3000", "api-url": "x" });

    const resolution = await resolveParameter(apiUrl, "development", provider);

    expect(resolution.viaUnscopedFallback).toBe(false);
  });
});

describe("resolveParameter candidates", () => {
  it("lists every candidate in precedence order with the reason each lost", async () => {
    const provider = fakeProvider({
      "redis/password.production": "from-production",
      "redis/password": "from-default",
    });

    const { candidates } = await resolveParameter(password, "production", provider);

    expect(candidates.map((c) => [c.location, c.present, c.skippedReason])).toEqual([
      ["redis/password.local", false, undefined],
      ["redis/password.local.enc", false, undefined],
      ["redis/password.production", true, undefined],
      ["redis/password.production.enc", false, undefined],
      ["redis/password", true, "lower-precedence"],
      ["redis/password.enc", false, undefined],
    ]);
  });

  it("says the local candidate was skipped rather than omitting it in test", async () => {
    const provider = fakeProvider({ "redis/password.local": "from-local", "redis/password": "d" });

    const { candidates } = await resolveParameter(password, "test", provider);

    expect(candidates.map((c) => [c.location, c.present, c.skippedReason])).toEqual([
      ["redis/password.local", false, "local-skipped-in-test"],
      ["redis/password.local.enc", false, "local-skipped-in-test"],
      ["redis/password.test", false, undefined],
      ["redis/password.test.enc", false, undefined],
      ["redis/password", true, undefined],
      ["redis/password.enc", false, undefined],
    ]);
  });
});

describe("resolveParameter and .enc", () => {
  it("lets an encrypted candidate compete at its scope's precedence", async () => {
    const provider = fakeProvider({
      "redis/password.production.enc": "ciphertext",
      "redis/password": "from-default",
    });

    // The encrypted production file outranks the plaintext default, so it wins
    // and the unsupported-decryption error is what surfaces.
    await expect(resolveParameter(password, "production", provider)).rejects.toMatchObject({
      code: "ENCRYPTED_VALUE_UNSUPPORTED",
    });
  });

  it("does not let an encrypted default outrank a plaintext environment value", async () => {
    const provider = fakeProvider({
      "redis/password.production": "from-production",
      "redis/password.enc": "ciphertext",
    });

    const resolution = await resolveParameter(password, "production", provider);

    expect(resolution.value).toBe("from-production");
    expect(resolution.candidates.find((c) => c.location === "redis/password.enc")).toMatchObject({
      present: true,
      skippedReason: "lower-precedence",
    });
  });

  it("throws ENCRYPTED_VALUE_UNSUPPORTED naming the parameter and the file", async () => {
    const provider = fakeProvider({ "redis/password.production.enc": "ciphertext" });

    const error = await resolveParameter(password, "production", provider).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PenvError);
    if (!(error instanceof PenvError)) {
      throw new Error("expected a PenvError");
    }
    expect(error.code).toBe("ENCRYPTED_VALUE_UNSUPPORTED");
    expect(error.message).toContain("redis.password");
    expect(error.message).toContain("production");
    expect(error.message).toContain("redis/password.production.enc");
  });

  it("never returns ciphertext as the value", async () => {
    const provider = fakeProvider({ "redis/password.local.enc": "ciphertext" });

    await expect(resolveParameter(password, "development", provider)).rejects.toThrow(PenvError);
  });
});

describe("resolveAll", () => {
  it("dedupes a parameter across its scopes and sorts by parameter id", async () => {
    const provider = fakeProvider({
      "redis/password.production": "from-production",
      "redis/password": "from-default",
      "redis/host.production": "redis.internal",
      "api-url": "https://example.test",
      "app/jwt-secret.local": "local-secret",
      "app/jwt-secret.production": "prod-secret",
    });

    const resolutions = await resolveAll("production", provider);

    expect(resolutions.map((r) => r.parameter)).toEqual([
      "api-url",
      "app.jwt-secret",
      "redis.host",
      "redis.password",
    ]);
    expect(resolutions.map((r) => r.value)).toEqual([
      "https://example.test",
      "local-secret",
      "redis.internal",
      "from-production",
    ]);
  });

  it("resolves each deduped parameter for the requested environment only", async () => {
    const provider = fakeProvider({
      "redis/password.staging": "staging-value",
      "redis/password": "from-default",
    });

    const resolutions = await resolveAll("production", provider);

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.value).toBe("from-default");
    expect(resolutions[0]?.viaUnscopedFallback).toBe(true);
  });

  it("returns nothing when the provider holds nothing", async () => {
    expect(await resolveAll("production", fakeProvider({}))).toEqual([]);
  });
});
