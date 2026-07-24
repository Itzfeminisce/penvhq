/**
 * The snapshot provider answers the `listSync`/`readSync` shape the cascade
 * consumes, with core's `parseFilename` as the one filename authority — so a
 * snapshot address is read exactly as the filesystem walker reads a file.
 */

import type { PenvSnapshot, ValueFile } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { createSnapshotProvider } from "./snapshot.js";

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

function snapshot(values: Readonly<Record<string, string>>): PenvSnapshot {
  return { v: 1, config: CONFIG, values };
}

describe("createSnapshotProvider", () => {
  it("re-parses each embedded key into a ValueFile through parseFilename", () => {
    const provider = createSnapshotProvider(
      snapshot({
        "database-url.enc": "penv:1:dev:aaaa:bbbb",
        "redis/password.production.enc": "penv:1:prod:cccc:dddd",
      }),
    );

    const files = provider
      .listSync()
      .sort((a, b) =>
        [...a.namespace, a.name].join("/") < [...b.namespace, b.name].join("/") ? -1 : 1,
      );

    expect(files).toEqual<ValueFile[]>([
      { namespace: [], name: "database-url", scope: { kind: "unscoped" }, encrypted: true },
      {
        namespace: ["redis"],
        name: "password",
        scope: { kind: "environment", environment: "production" },
        encrypted: true,
      },
    ]);
  });

  it("reads a value back by its formatted address", () => {
    const provider = createSnapshotProvider(
      snapshot({ "database-url.enc": "penv:1:dev:aaaa:bbbb" }),
    );

    expect(
      provider.readSync({
        namespace: [],
        name: "database-url",
        scope: { kind: "unscoped" },
        encrypted: true,
      }),
    ).toBe("penv:1:dev:aaaa:bbbb");
  });

  it("returns undefined for a location the snapshot does not hold", () => {
    const provider = createSnapshotProvider(
      snapshot({ "database-url.enc": "penv:1:dev:aaaa:bbbb" }),
    );

    expect(
      provider.readSync({
        namespace: [],
        name: "database-url",
        scope: { kind: "environment", environment: "production" },
        encrypted: true,
      }),
    ).toBeUndefined();
  });
});
