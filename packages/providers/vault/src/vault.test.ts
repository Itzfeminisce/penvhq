/**
 * The Vault adapter's proof. The provider-agnostic contract suite runs against an
 * injected in-memory KV v2 fake — the same behavioural suite the filesystem passes,
 * with zero suite edits — plus the three assertions the base contract cannot make:
 * retention (`readPrevious`), meta at its own address, and the KV v1 refusal.
 */

import type { ParameterRef, Provider, ValueFile } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { runProviderContractSuite } from "@penvhq/provider-contract";
import { describe, expect, it } from "vitest";
import { VaultKvVersionError } from "./errors.js";
import type { VaultTransport } from "./vault.js";
import { createVaultProvider } from "./vault.js";

/**
 * A faithful in-memory KV v2 transport: a `Map` of path → ordered version list,
 * exactly the state a real KV v2 mount keeps. It models versioned writes,
 * point-in-time reads, one-level LIST with `/`-suffixed directories, and a full
 * metadata delete — enough that the provider cannot tell it from the real thing.
 */
function createInMemoryKvV2(options: { version?: number } = {}): VaultTransport {
  const mountVersion = options.version ?? 2;
  // Each write appends a version; index 0 is version 1, matching KV v2's numbering.
  const store = new Map<string, Record<string, string>[]>();

  return {
    mountVersion() {
      return Promise.resolve(mountVersion);
    },

    readData(path, version) {
      const versions = store.get(path);
      if (versions === undefined || versions.length === 0) return Promise.resolve(undefined);
      const index = version === undefined ? versions.length - 1 : version - 1;
      const data = versions[index];
      return Promise.resolve(data === undefined ? undefined : { ...data });
    },

    writeData(path, data) {
      const versions = store.get(path) ?? [];
      versions.push({ ...data });
      store.set(path, versions);
      return Promise.resolve();
    },

    currentVersion(path) {
      const versions = store.get(path);
      return Promise.resolve(
        versions === undefined || versions.length === 0 ? undefined : versions.length,
      );
    },

    deleteMetadata(path) {
      store.delete(path);
      return Promise.resolve();
    },

    listKeys(path) {
      const prefix = path === "" ? "" : `${path}/`;
      const children = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.length === 0) continue;
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
      }
      return Promise.resolve([...children]);
    },
  };
}

const BASE = "app/penv";

function makeProvider(): Promise<{ provider: Provider; cleanup: () => Promise<void> }> {
  const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });
  // The fake is owned by the provider and garbage-collected with it, so cleanup is a no-op.
  return Promise.resolve({ provider, cleanup: () => Promise.resolve() });
}

runProviderContractSuite("vault", makeProvider);

const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };
const scoped: ValueFile = {
  namespace: ["redis"],
  name: "password",
  scope: { kind: "environment", environment: "production" },
  encrypted: false,
};

describe("VaultProvider", () => {
  it("reports the vault type", async () => {
    const { provider } = await makeProvider();
    expect(provider.type).toBe("vault");
  });

  describe("readPrevious retention", () => {
    it("hands back the value from before the current one", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      await provider.write(scoped, "v1");
      await provider.write(scoped, "v2");

      expect(await provider.read(scoped)).toBe("v2");
      expect(await provider.readPrevious(scoped)).toBe("v1");
    });

    it("resolves to undefined when only one version was ever written", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      await provider.write(scoped, "only");

      expect(await provider.readPrevious(scoped)).toBeUndefined();
    });

    it("resolves to undefined when nothing was ever written", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      expect(await provider.readPrevious(scoped)).toBeUndefined();
    });

    it("follows the current value across a third write", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      await provider.write(scoped, "v1");
      await provider.write(scoped, "v2");
      await provider.write(scoped, "v3");

      expect(await provider.read(scoped)).toBe("v3");
      expect(await provider.readPrevious(scoped)).toBe("v2");
    });
  });

  describe("meta lives at its own address", () => {
    it("stores meta where list never reaches it", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      await provider.writeMeta(redisPassword, { description: "Redis auth", secret: true });

      expect(await provider.readMeta(redisPassword)).toEqual({
        description: "Redis auth",
        secret: true,
      });
      expect(await provider.list()).toEqual([]);
    });

    it("keeps meta and a same-parameter value as two distinct records", async () => {
      const provider = createVaultProvider({ path: BASE, transport: createInMemoryKvV2() });

      await provider.write(scoped, "hunter2");
      await provider.writeMeta(redisPassword, { description: "Redis auth" });

      // The value is listed; the meta beside it is not.
      expect(await provider.list()).toEqual([scoped]);
      expect(await provider.read(scoped)).toBe("hunter2");
      expect(await provider.readMeta(redisPassword)).toEqual({ description: "Redis auth" });
    });
  });

  describe("KV v1 is refused", () => {
    it("refuses a v1 mount with a PenvError at first use", async () => {
      const provider = createVaultProvider({
        path: BASE,
        transport: createInMemoryKvV2({ version: 1 }),
      });

      await expect(provider.list()).rejects.toBeInstanceOf(VaultKvVersionError);
      await expect(provider.list()).rejects.toBeInstanceOf(PenvError);
    });

    it("refuses a v1 mount on read and write alike", async () => {
      const provider = createVaultProvider({
        path: BASE,
        transport: createInMemoryKvV2({ version: 1 }),
      });

      await expect(provider.read(scoped)).rejects.toBeInstanceOf(VaultKvVersionError);
      await expect(provider.write(scoped, "x")).rejects.toBeInstanceOf(VaultKvVersionError);
    });
  });

  describe("the KV-version check does not cache a transient failure", () => {
    it("recovers on the next operation after a first-op version-check blip", async () => {
      const inner = createInMemoryKvV2();
      let failNextVersionCheck = true;
      // A transport whose very first mountVersion() rejects the way a network blip
      // or a momentary auth expiry would, then behaves normally. If the provider
      // memoized the rejection, every later operation would reject forever.
      const flaky: VaultTransport = {
        ...inner,
        mountVersion() {
          if (failNextVersionCheck) {
            failNextVersionCheck = false;
            return Promise.reject(new Error("transient vault outage"));
          }
          return inner.mountVersion();
        },
      };
      const provider = createVaultProvider({ path: BASE, transport: flaky });

      await expect(provider.write(scoped, "v1")).rejects.toThrow("transient vault outage");
      // The blip is over; the provider must retry the check rather than stay poisoned.
      await provider.write(scoped, "v1");
      expect(await provider.read(scoped)).toBe("v1");
    });
  });
});
