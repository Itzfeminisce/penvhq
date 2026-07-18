/**
 * `penv pull` is the inverse of deploy-time injection: it reads an environment's
 * declared source-of-truth provider and materialises the local `.penv` tree from
 * it. These tests stand up a `mock` provider as that source, pull it, and hold
 * the pull to its two contracts — every value and meta the source held now lives
 * in the local tree, and a sealed envelope crossed byte-for-byte because pull
 * never opens a value to move it. Pulling an environment whose source *is* the
 * local tree is a no-op, reported as nothing to do rather than a self-copy.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meta, ValueFile } from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { createMockProvider } from "@penvhq/provider-mock";
import { afterEach, describe, expect, it } from "vitest";
import { runPull } from "./pull.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "filesystem" },
    production: { type: "mock" },
  },
};

const created: string[] = [];

function makeProject(config: Record<string, unknown> = {}): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "pull-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify({ ...CONFIG, ...config })};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(join(root, ".penv", "env.ts"), "export const schema = {};\n", "utf8");
  return root;
}

/** The mock source's on-disk store, at the same path the registry builds it from. */
function mockSource(root: string) {
  return createMockProvider({ storePath: join(root, ".penv", ".penv-mock.json") });
}

/** The local tree, to read back what a pull wrote. */
function localTree(root: string, config: Record<string, unknown> = {}) {
  return createFilesystemProvider({ root: join(root, ".penv"), config: { ...CONFIG, ...config } });
}

const UNSCOPED: ValueFile = {
  namespace: [],
  name: "api-key",
  scope: { kind: "unscoped" },
  encrypted: false,
};
const SCOPED: ValueFile = {
  namespace: ["db"],
  name: "url",
  scope: { kind: "environment", environment: "production" },
  encrypted: false,
};
const SEALED: ValueFile = {
  namespace: [],
  name: "token",
  scope: { kind: "environment", environment: "production" },
  encrypted: true,
};
/** An opaque envelope: pull must copy it verbatim, never decrypt it. */
const ENVELOPE = "penv:v1:pZ3kQ8xr+base64+garbage+that/never/decrypts==";

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPull", () => {
  it("materialises every value the source holds, at every scope, into the local tree", async () => {
    const root = makeProject();
    const source = mockSource(root);
    await source.write(UNSCOPED, "shared-default");
    await source.write(SCOPED, "postgres://prod");

    const result = await runPull({ cwd: root, environment: "production" });

    expect(result.source).toBe("mock");
    expect(result.localSource).toBe(false);
    expect(result.values).toBe(2);

    const tree = localTree(root);
    expect(await tree.read(UNSCOPED)).toBe("shared-default");
    expect(await tree.read(SCOPED)).toBe("postgres://prod");
  });

  it("copies a sealed envelope byte-for-byte, never opening it to move it", async () => {
    const root = makeProject();
    const source = mockSource(root);
    await source.write(SEALED, ENVELOPE);

    const result = await runPull({ cwd: root, environment: "production" });

    expect(result.values).toBe(1);
    // Byte-identical: the local tree now holds exactly the envelope string the
    // source held, no decrypt and no re-encode in between.
    expect(await localTree(root).read(SEALED)).toBe(ENVELOPE);
  });

  it("pulls each parameter's meta once, across its scopes", async () => {
    const root = makeProject();
    const source = mockSource(root);
    await source.write(SCOPED, "postgres://prod");
    const meta: Meta = { secret: true, environments: { production: { required: true } } };
    await source.writeMeta({ namespace: ["db"], name: "url" }, meta);

    const result = await runPull({ cwd: root, environment: "production" });

    expect(result.refs).toBe(1);
    expect(result.meta).toBe(1);
    expect(await localTree(root).readMeta({ namespace: ["db"], name: "url" })).toEqual(meta);
  });

  it("reports nothing to pull when the environment's source is the local tree itself", async () => {
    const root = makeProject();

    const result = await runPull({ cwd: root, environment: "development" });

    expect(result.localSource).toBe(true);
    expect(result.source).toBe("filesystem");
    expect(result.values).toBe(0);
    expect(result.meta).toBe(0);
    expect(result.refs).toBe(0);
  });
});
