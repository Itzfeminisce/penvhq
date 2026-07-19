/**
 * The SSM adapter's proof. The provider-agnostic contract suite runs against an
 * injected in-memory fake — the same behavioural suite the filesystem and Vault
 * pass, with zero suite edits — plus the assertions SSM's own shape demands:
 * retention (`readPrevious`), meta at its own address, the empty-value sentinel
 * (the fake rejects an empty value exactly as SSM does), values stored as
 * `SecureString`, and the `--with-decryption` discipline on every read.
 */

import type { ParameterRef, Provider, ValueFile } from "@penvhq/core";
import { runProviderContractSuite } from "@penvhq/provider-contract";
import { describe, expect, it } from "vitest";
import type { SsmTransport, SsmValue } from "./ssm.js";
import { createSsmProvider } from "./ssm.js";
import { defaultSsmTransport } from "./transport.js";

/** One `putParameter` call, captured so a test can assert the type SSM was told to use. */
interface PutCall {
  readonly name: string;
  readonly value: string;
  readonly secure: boolean;
}

interface InMemorySsm {
  readonly transport: SsmTransport;
  readonly puts: PutCall[];
}

/**
 * A faithful in-memory SSM: a `Map` of name → ordered version list, exactly the
 * state Parameter Store keeps. It models versioned overwrites, history, recursive
 * path listing, and — the load-bearing fidelity — the rejection of an empty
 * `Value`, so a suite that stores `""` proves the adapter's sentinel rather than
 * passing by accident against a laxer fake.
 */
function createInMemorySsm(): InMemorySsm {
  const store = new Map<string, SsmValue[]>();
  const puts: PutCall[] = [];

  const transport: SsmTransport = {
    getParameter(name) {
      const versions = store.get(name);
      if (versions === undefined || versions.length === 0) return Promise.resolve(undefined);
      const latest = versions[versions.length - 1];
      return Promise.resolve(latest === undefined ? undefined : { ...latest });
    },
    putParameter(name, value, secure) {
      // SSM rejects an empty Value (minimum length 1). Modelling it is what makes
      // the contract's empty-value case a real test of the adapter's sentinel.
      if (value.length === 0) {
        return Promise.reject(new Error("SSM ValidationException: Value cannot be empty"));
      }
      puts.push({ name, value, secure });
      const versions = store.get(name) ?? [];
      versions.push({ value, version: versions.length + 1 });
      store.set(name, versions);
      return Promise.resolve();
    },
    deleteParameter(name) {
      store.delete(name);
      return Promise.resolve();
    },
    listNames(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return Promise.resolve([...store.keys()].filter((name) => name.startsWith(prefix)));
    },
    getHistory(name) {
      const versions = store.get(name) ?? [];
      return Promise.resolve(versions.map((v) => ({ ...v })));
    },
  };

  return { transport, puts };
}

const BASE = "penv";

function makeProvider(): Promise<{ provider: Provider; cleanup: () => Promise<void> }> {
  const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
  return Promise.resolve({ provider, cleanup: () => Promise.resolve() });
}

runProviderContractSuite("ssm", makeProvider);

const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };
const scoped: ValueFile = {
  namespace: ["redis"],
  name: "password",
  scope: { kind: "environment", environment: "production" },
  encrypted: false,
};
const unscoped: ValueFile = {
  namespace: ["redis"],
  name: "password",
  scope: { kind: "unscoped" },
  encrypted: false,
};

describe("SsmProvider", () => {
  it("reports the ssm type", async () => {
    const { provider } = await makeProvider();
    expect(provider.type).toBe("@penvhq/provider-ssm");
  });

  describe("readPrevious retention", () => {
    it("hands back the value from before the current one", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      await provider.write(scoped, "v1");
      await provider.write(scoped, "v2");
      expect(await provider.read(scoped)).toBe("v2");
      expect(await provider.readPrevious(scoped)).toBe("v1");
    });

    it("resolves to undefined for a single version, and for none at all", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      expect(await provider.readPrevious(scoped)).toBeUndefined();
      await provider.write(scoped, "only");
      expect(await provider.readPrevious(scoped)).toBeUndefined();
    });

    it("follows the current value across a third write", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      await provider.write(scoped, "v1");
      await provider.write(scoped, "v2");
      await provider.write(scoped, "v3");
      expect(await provider.read(scoped)).toBe("v3");
      expect(await provider.readPrevious(scoped)).toBe("v2");
    });
  });

  describe("the empty-value sentinel", () => {
    it("round-trips an empty value that SSM itself would reject", async () => {
      const ssm = createInMemorySsm();
      const provider = createSsmProvider({ path: BASE, transport: ssm.transport });

      await provider.write(scoped, "");

      // The provider stored a non-empty value (the sentinel), so SSM's rule held...
      expect(ssm.puts.at(-1)?.value.length).toBeGreaterThan(0);
      // ...yet penv reads back the empty value byte-for-byte.
      expect(await provider.read(scoped)).toBe("");
    });

    it("round-trips a value that itself begins with the sentinel byte", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      const value = "\u0001payload";
      await provider.write(scoped, value);
      expect(await provider.read(scoped)).toBe(value);
    });
  });

  describe("SecureString for values, String for meta", () => {
    it("stores a value as SecureString and its meta as String", async () => {
      const ssm = createInMemorySsm();
      const provider = createSsmProvider({ path: BASE, transport: ssm.transport });

      await provider.write(scoped, "hunter2");
      await provider.writeMeta(redisPassword, { description: "Redis auth" });

      const valuePut = ssm.puts.find((p) => p.name.endsWith("password.production"));
      const metaPut = ssm.puts.find((p) => p.name.endsWith("password.json"));
      expect(valuePut?.secure).toBe(true);
      expect(metaPut?.secure).toBe(false);
    });
  });

  describe("meta lives at its own address", () => {
    it("stores meta where list never reaches it", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      await provider.writeMeta(redisPassword, { description: "Redis auth", secret: true });
      expect(await provider.readMeta(redisPassword)).toEqual({
        description: "Redis auth",
        secret: true,
      });
      expect(await provider.list()).toEqual([]);
    });

    it("keeps meta and a same-parameter value as two distinct records", async () => {
      const provider = createSsmProvider({ path: BASE, transport: createInMemorySsm().transport });
      await provider.write(unscoped, "hunter2");
      await provider.writeMeta(redisPassword, { description: "Redis auth" });
      expect(await provider.list()).toEqual([unscoped]);
      expect(await provider.read(unscoped)).toBe("hunter2");
      expect(await provider.readMeta(redisPassword)).toEqual({ description: "Redis auth" });
    });
  });

  describe("the default transport always decrypts on read", () => {
    it("passes --with-decryption on get-parameter and get-parameter-history", async () => {
      const calls: string[][] = [];
      const transport = defaultSsmTransport({
        run: (args) => {
          calls.push([...args]);
          // Enough JSON to satisfy each parse; the args are what this test asserts.
          if (args.includes("get-parameter")) {
            return JSON.stringify({ Parameter: { Value: "x", Version: 1 } });
          }
          return JSON.stringify({ Parameters: [{ Value: "x", Version: 1 }] });
        },
      });

      await transport.getParameter("/penv/redis/password.production");
      await transport.getHistory("/penv/redis/password.production");

      const decryptedReads = calls.filter((args) => args.includes("--with-decryption"));
      // Both reads decrypted; nothing read without it.
      expect(decryptedReads.length).toBe(2);
    });
  });
});
