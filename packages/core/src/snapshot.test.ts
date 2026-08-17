/**
 * The snapshot's inputs and the digest that binds it to them. The CLI writes the
 * digest and the runtime recomputes it, so what matters here is that the same
 * inputs always digest the same and different inputs never do.
 */

import { describe, expect, it } from "vitest";
import { type SyncValueSource, sealedSnapshotValues, snapshotDigest } from "./snapshot.js";
import type { PenvConfig, ValueFile } from "./types.js";

const CONFIG: PenvConfig = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

function file(name: string, scope: ValueFile["scope"], encrypted: boolean): ValueFile {
  return { namespace: [], name, scope, encrypted };
}

/** A tree with one of every case the sealed-only filter must decide on. */
function tree(): SyncValueSource {
  const entries: [ValueFile, string][] = [
    [file("api-key", { kind: "unscoped" }, true), "penv:1:dev:aa:bb"],
    [
      file("database-url", { kind: "environment", environment: "production" }, true),
      "penv:1:p:c:d",
    ],
    [file("log-level", { kind: "unscoped" }, false), "debug"],
    [file("token", { kind: "local" }, true), "penv:1:dev:ee:ff"],
  ];
  return {
    listSync: () => entries.map(([f]) => f),
    readSync: (wanted) =>
      entries.find(([f]) => f.name === wanted.name && f.encrypted === wanted.encrypted)?.[1],
  };
}

describe("sealedSnapshotValues", () => {
  it("embeds sealed team-scope records only, code-unit sorted", () => {
    expect(Object.keys(sealedSnapshotValues(tree()))).toEqual([
      "api-key.enc",
      "database-url.production.enc",
    ]);
  });
});

describe("snapshotDigest", () => {
  it("is stable across declaration order — the config's content decides it", () => {
    const reordered: PenvConfig = {
      providers: {
        production: { type: "@penvhq/provider-filesystem" },
        development: { type: "@penvhq/provider-filesystem" },
      },
      environments: ["development", "production"],
    };
    const values = { "api-key.enc": "penv:1:dev:aa:bb" };

    expect(snapshotDigest(reordered, values)).toBe(snapshotDigest(CONFIG, values));
  });

  it("changes when a sealed value changes — the staleness a re-seal creates", () => {
    expect(snapshotDigest(CONFIG, { "api-key.enc": "penv:1:dev:aa:bb" })).not.toBe(
      snapshotDigest(CONFIG, { "api-key.enc": "penv:1:dev:cc:dd" }),
    );
  });

  it("changes when a parameter is added", () => {
    expect(snapshotDigest(CONFIG, { "api-key.enc": "x" })).not.toBe(
      snapshotDigest(CONFIG, { "api-key.enc": "x", "other.enc": "y" }),
    );
  });

  it("changes when the config changes", () => {
    const widened: PenvConfig = { ...CONFIG, environments: [...CONFIG.environments, "staging"] };
    expect(snapshotDigest(widened, {})).not.toBe(snapshotDigest(CONFIG, {}));
  });
});

describe("the digest's serialization", () => {
  /**
   * The property the whole digest rests on: the CLI digests a live config module
   * and the runtime digests the same module reloaded, while the snapshot ships a
   * JSON round trip of it. A serialization that disagreed with JSON about any of
   * those would report drift between two spellings of one config.
   */
  it("agrees with a JSON round trip", () => {
    const config = {
      environments: ["development", "production"],
      providers: { production: { type: "@penvhq/provider-vault", location: "secret/app" } },
      override: { "database-url": "DATABASE_URL" },
      nested: { list: [1, "two", true, null, { deep: "value" }] },
      absent: undefined,
      method: () => "not JSON",
    };

    expect(snapshotDigest(config as unknown as PenvConfig, {})).toBe(
      snapshotDigest(JSON.parse(JSON.stringify(config)) as PenvConfig, {}),
    );
  });

  it("distinguishes nested shapes a flat compare would collide", () => {
    const left = { environments: ["a"], providers: { a: { type: "x", location: "y" } } };
    const right = { environments: ["a"], providers: { a: { type: "x", location: "z" } } };

    expect(snapshotDigest(left as unknown as PenvConfig, {})).not.toBe(
      snapshotDigest(right as unknown as PenvConfig, {}),
    );
  });

  it("distinguishes a key's value from a key of that name", () => {
    const left = { environments: ["a"], providers: {}, x: { y: 1 } };
    const right = { environments: ["a"], providers: {}, "x.y": 1 };

    expect(snapshotDigest(left as unknown as PenvConfig, {})).not.toBe(
      snapshotDigest(right as unknown as PenvConfig, {}),
    );
  });

  it("refuses a circular config by name rather than overflowing the stack", () => {
    const config: Record<string, unknown> = { environments: ["a"], providers: {} };
    config.self = config;

    expect(() => snapshotDigest(config as unknown as PenvConfig, {})).toThrow(TypeError);
  });

  it("digests a value repeated at two places, which is not a cycle", () => {
    const shared = { type: "@penvhq/provider-filesystem" };
    const config = { environments: ["a", "b"], providers: { a: shared, b: shared } };

    expect(() => snapshotDigest(config as unknown as PenvConfig, {})).not.toThrow();
  });
});
