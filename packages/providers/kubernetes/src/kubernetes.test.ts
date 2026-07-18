/**
 * The Kubernetes adapter's proof. The provider-agnostic contract suite runs
 * against an injected in-memory Secret — the same behavioural suite the
 * filesystem, Vault, and SSM pass, with zero suite edits — plus the two things
 * this adapter must show on its own: that it declares retention *absent* (it is a
 * plain provider, and `retainsPrevious` narrows it to `false`), and that the
 * arbitrary-depth-namespace-to-flat-key flattening is reversible and collision-free.
 */

import type { ParameterRef, Provider, ValueFile } from "@penvhq/core";
import { retainsPrevious } from "@penvhq/core";
import { runProviderContractSuite } from "@penvhq/provider-contract";
import { describe, expect, it } from "vitest";
import type { KubernetesTransport } from "./kubernetes.js";
import { createKubernetesProvider, decodeKey, encodeKey } from "./kubernetes.js";

/** A faithful in-memory Secret: a flat `Map` of data key → plaintext value. */
function createInMemorySecret(): KubernetesTransport {
  const data = new Map<string, string>();
  return {
    readKey(key) {
      return Promise.resolve(data.get(key));
    },
    writeKey(key, value) {
      data.set(key, value);
      return Promise.resolve();
    },
    deleteKey(key) {
      data.delete(key);
      return Promise.resolve();
    },
    listKeys() {
      return Promise.resolve([...data.keys()]);
    },
  };
}

function makeProvider(): Promise<{ provider: Provider; cleanup: () => Promise<void> }> {
  const provider = createKubernetesProvider({ transport: createInMemorySecret() });
  return Promise.resolve({ provider, cleanup: () => Promise.resolve() });
}

runProviderContractSuite("kubernetes", makeProvider);

const K8S_KEY = /^[A-Za-z0-9._-]+$/;

describe("KubernetesProvider", () => {
  it("reports the kubernetes type", async () => {
    const { provider } = await makeProvider();
    expect(provider.type).toBe("kubernetes");
  });

  describe("retention is declared absent", () => {
    it("is a plain provider that retainsPrevious narrows to false", async () => {
      const { provider } = await makeProvider();
      expect(retainsPrevious(provider)).toBe(false);
      expect((provider as { readPrevious?: unknown }).readPrevious).toBeUndefined();
    });
  });

  describe("key flattening is reversible", () => {
    const paths = [
      "database-url",
      "redis/password",
      "redis/password.production.enc",
      "app/auth/jwt-secret.production.local",
      "with_underscore/name_here.development",
      // Underscore stress: the escape char itself, a trailing `_`, a doubled `_`.
      "a_s/b",
      "ends_/name",
      "deep/a/b/c/leaf.test",
      "redis__password",
      // penv puts no charset whitelist on names, so a data key must survive
      // characters outside the key alphabet: a space, a `+`, an `=`, a `~`, and
      // non-ASCII. The old two-rule escape produced invalid keys for these.
      "my key",
      "a+b=c",
      "na~me/x",
      "café/naïve.production",
      "emoji-🔐/token",
    ];

    for (const path of paths) {
      it(`round-trips \`${path}\` through encode/decode, staying a legal key`, () => {
        const key = encodeKey(path);
        expect(key).toMatch(K8S_KEY);
        expect(decodeKey(key)).toBe(path);
      });
    }
  });

  describe("the flattening does not collide", () => {
    // `redis/password` (a namespaced parameter) and `redis_password` (a root
    // parameter whose name contains an underscore) are two records. A naive
    // `/`->`_` flattening would map both to `redis_password` and lose one; the
    // two-rule escape keeps them apart.
    const namespaced: ValueFile = {
      namespace: ["redis"],
      name: "password",
      scope: { kind: "unscoped" },
      encrypted: false,
    };
    const underscored: ValueFile = {
      namespace: [],
      name: "redis_password",
      scope: { kind: "unscoped" },
      encrypted: false,
    };

    it("keeps a namespaced and an underscored parameter at distinct keys", async () => {
      const { provider } = await makeProvider();

      await provider.write(namespaced, "in-namespace");
      await provider.write(underscored, "at-root");

      expect(await provider.read(namespaced)).toBe("in-namespace");
      expect(await provider.read(underscored)).toBe("at-root");

      const listed = await provider.list();
      expect(listed).toHaveLength(2);
      const names = listed.map((f) => [...f.namespace, f.name].join("/")).sort();
      expect(names).toEqual(["redis/password", "redis_password"]);
    });
  });

  describe("meta lives at its own key", () => {
    const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };
    const scoped: ValueFile = {
      namespace: ["redis"],
      name: "password",
      scope: { kind: "environment", environment: "production" },
      encrypted: false,
    };

    it("stores meta where list never reaches it", async () => {
      const { provider } = await makeProvider();
      await provider.write(scoped, "hunter2");
      await provider.writeMeta(redisPassword, { description: "Redis auth" });

      expect(await provider.list()).toEqual([scoped]);
      expect(await provider.readMeta(redisPassword)).toEqual({ description: "Redis auth" });
    });
  });
});
