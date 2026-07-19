/**
 * `set` and `remove` are the CLI's only writers, so between them they decide
 * which cascade levels a user can address at all. The cascade has four levels
 * (invariant 4); the flags have to reach all four, and `--local --env <e>` is the
 * one that mirrors `.env.<e>.local`. When that combination was refused, the
 * environment-scoped personal override existed in the grammar and was reachable
 * only by hand-writing the file — so these tests assert the filename each flag
 * combination produces, and that `remove` deletes the same file `set` wrote.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { runGet } from "./get.js";
import { runList } from "./list.js";
import { runMove } from "./mv.js";
import { runRemove } from "./remove.js";
import { runSet, scopeFrom } from "./set.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    test: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

const created: string[] = [];

function makeProject(tree: Readonly<Record<string, string>> = {}): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "scope-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    'import { z } from "zod";\nexport const schema = z.object({});\n',
    "utf8",
  );
  for (const [name, contents] of Object.entries(tree)) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

/**
 * A value file's contents, or `undefined` when it does not exist. The provider
 * terminates a written file with a newline, so it is dropped here — these tests
 * are about which file was written, not how the provider serializes into it.
 */
function valueFile(root: string, location: string): string | undefined {
  const file = join(root, ".penv", location);
  if (!existsSync(file)) {
    return undefined;
  }
  const contents = readFileSync(file, "utf8");
  return contents.endsWith("\n") ? contents.slice(0, -1) : contents;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scopeFrom", () => {
  it("reads --local --env <e> as the environment-scoped personal override", () => {
    expect(scopeFrom({ local: true, environment: "production" })).toEqual({
      kind: "environment-local",
      environment: "production",
    });
  });

  it("reads --local alone as the personal override for every environment", () => {
    expect(scopeFrom({ local: true })).toEqual({ kind: "local" });
  });

  it("reads --env alone as the environment scope", () => {
    expect(scopeFrom({ environment: "production" })).toEqual({
      kind: "environment",
      environment: "production",
    });
  });

  it("reads no flags as the unscoped default", () => {
    expect(scopeFrom({})).toEqual({ kind: "unscoped" });
  });

  /** Four levels, four addresses: no two flag combinations may name one file. */
  it("gives each cascade level a distinct flag combination", () => {
    const kinds = [
      scopeFrom({ local: true, environment: "production" }),
      scopeFrom({ local: true }),
      scopeFrom({ environment: "production" }),
      scopeFrom({}),
    ].map((scope) => scope.kind);

    expect(new Set(kinds).size).toBe(4);
  });
});

describe("penv set", () => {
  it("writes <name>.<env>.local for --local --env production", async () => {
    const root = makeProject();

    const result = await runSet({
      cwd: root,
      key: "api/key",
      value: "mine-in-prod",
      environment: "production",
      local: true,
    });

    expect(result.location).toBe("api/key.production.local");
    expect(valueFile(root, "api/key.production.local")).toBe("mine-in-prod");
  });

  /**
   * The scope-widening leak in filename form: the override for one environment
   * must not land on the unscoped default, which every other environment reads.
   */
  it("does not write the unscoped default for --local --env production", async () => {
    const root = makeProject();

    await runSet({
      cwd: root,
      key: "api/key",
      value: "mine-in-prod",
      environment: "production",
      local: true,
    });

    expect(valueFile(root, "api/key")).toBeUndefined();
    expect(valueFile(root, "api/key.local")).toBeUndefined();
  });

  it("writes <name>.local for --local alone", async () => {
    const root = makeProject();

    const result = await runSet({ cwd: root, key: "api/key", value: "mine", local: true });

    expect(result.location).toBe("api/key.local");
    expect(valueFile(root, "api/key.local")).toBe("mine");
  });

  it("writes <name>.<env> for --env alone", async () => {
    const root = makeProject();

    const result = await runSet({
      cwd: root,
      key: "api/key",
      value: "shared-prod",
      environment: "production",
    });

    expect(result.location).toBe("api/key.production");
  });

  it("writes the unscoped default with no scope flags", async () => {
    const root = makeProject();

    const result = await runSet({ cwd: root, key: "api/key", value: "fallback" });

    expect(result.location).toBe("api/key");
  });

  /** Invariant 10: the environment is a whitelist entry, in this filename too. */
  it("refuses an undeclared environment under --local", async () => {
    const root = makeProject();

    await expect(
      runSet({ cwd: root, key: "api/key", value: "x", environment: "staging", local: true }),
    ).rejects.toBeInstanceOf(PenvError);
    expect(valueFile(root, "api/key.staging.local")).toBeUndefined();
  });
});

/**
 * `resolveEnvironment` trims before it checks the whitelist, so the name it
 * validated and the name the flag carried are two different strings — and a
 * writer that puts the raw one in a filename writes a file the grammar then
 * refuses to read, which is the failure every later command inherits. The round
 * trip is the assertion: a filename `list` cannot read is the bug, so checking
 * the string `set` reported would not have caught it.
 */
describe("penv set with a padded --env", () => {
  const PADDED = [
    { label: "trailing space", environment: "production " },
    { label: "leading space", environment: " production" },
    { label: "both", environment: "  production  " },
  ];

  for (const { label, environment } of PADDED) {
    it(`writes <name>.<env> and reads it back for a ${label}`, async () => {
      const root = makeProject();

      const result = await runSet({ cwd: root, key: "api/key", value: "shared-prod", environment });

      expect(result.location).toBe("api/key.production");
      expect(valueFile(root, "api/key.production")).toBe("shared-prod");
      await expect(runGet({ cwd: root, key: "api/key", environment: "production" })).resolves.toBe(
        "shared-prod",
      );
      const listed = await runList({ cwd: root, environment: "production" });
      expect(listed.parameters).toEqual([
        {
          parameter: "api.key",
          variable: "API_KEY",
          scope: "production",
          location: "api/key.production",
          encrypted: false,
          viaUnscopedFallback: false,
        },
      ]);
    });

    it(`writes <name>.<env>.local and reads it back for --local and a ${label}`, async () => {
      const root = makeProject();

      const result = await runSet({
        cwd: root,
        key: "api/key",
        value: "mine-in-prod",
        environment,
        local: true,
      });

      expect(result.location).toBe("api/key.production.local");
      expect(valueFile(root, "api/key.production.local")).toBe("mine-in-prod");
      await expect(runGet({ cwd: root, key: "api/key", environment: "production" })).resolves.toBe(
        "mine-in-prod",
      );
      const listed = await runList({ cwd: root, environment: "production" });
      expect(listed.parameters.map((entry) => entry.location)).toEqual([
        "api/key.production.local",
      ]);
    });
  }

  it("removes the file a padded --env wrote", async () => {
    const root = makeProject();
    const written = await runSet({
      cwd: root,
      key: "api/key",
      value: "v",
      environment: "production ",
    });

    const removed = await runRemove({ cwd: root, key: "api/key", environment: " production" });

    expect(removed.removed).toEqual(["api/key.production"]);
    expect(written.location).toBe("api/key.production");
    expect(valueFile(root, "api/key.production")).toBeUndefined();
  });

  /** Invariant 10: trimming is normalization, never a way into the whitelist. */
  it("still refuses an undeclared environment that is merely padded", async () => {
    const root = makeProject();

    await expect(
      runSet({ cwd: root, key: "api/key", value: "x", environment: " staging " }),
    ).rejects.toBeInstanceOf(PenvError);
    expect(valueFile(root, "api/key.staging")).toBeUndefined();
  });

  /**
   * Invariant 10 and 13: `resolveEnvironment` would answer a blank `--env` from
   * `PENV_ENV`/`NODE_ENV`, and a writer silently scoping a file to an
   * environment the user never named is the same wrong file by another route.
   */
  it("refuses a blank --env rather than inferring one", async () => {
    const root = makeProject();

    await expect(
      runSet({ cwd: root, key: "api/key", value: "x", environment: "   " }),
    ).rejects.toBeInstanceOf(PenvError);
    const listed = await runList({ cwd: root, environment: "production" });
    expect(listed.parameters).toEqual([]);
  });
});

/**
 * The lockout the write-path guard used to cause. A `dbHost.<env>` file is one
 * the filename grammar admits but the transform never produces — a hand-written
 * value, or one from before penv guarded creation. When the guard sat on the
 * shared `refFromKey`, `get` and `mv` refused it too, so the only way out was to
 * delete the file by hand. `get` must still read it, and `mv` must still rename
 * it away, so these drive both against a file placed directly on disk.
 */
describe("an existing non-canonical value file stays gettable and renamable", () => {
  it("reads it with penv get and renames it with penv mv", async () => {
    const root = makeProject({ "dbHost.production": "existing" });

    // Gettable: the read path addresses the file by its literal name.
    await expect(runGet({ cwd: root, key: "dbHost", environment: "production" })).resolves.toBe(
      "existing",
    );

    // Renamable: the move guards only the destination, so renaming AWAY from the
    // non-canonical name succeeds and the file lands at the canonical address.
    const result = await runMove({ cwd: root, from: "dbHost", to: "db-host" });

    expect(result.files.map((file) => ({ from: file.from, to: file.to }))).toEqual([
      { from: "dbHost.production", to: "db-host.production" },
    ]);
    expect(valueFile(root, "dbHost.production")).toBeUndefined();
    expect(valueFile(root, "db-host.production")).toBe("existing");
  });
});

describe("penv remove", () => {
  it("removes <name>.<env>.local for --local --env production", async () => {
    const root = makeProject({
      "api/key.production.local": "mine-in-prod",
      "api/key.local": "mine",
      "api/key": "fallback",
    });

    const result = await runRemove({
      cwd: root,
      key: "api/key",
      environment: "production",
      local: true,
    });

    expect(result.removed).toEqual(["api/key.production.local"]);
    // The other levels are different files and are none of this command's business.
    expect(valueFile(root, "api/key.local")).toBe("mine");
    expect(valueFile(root, "api/key")).toBe("fallback");
  });

  it("removes <name>.local for --local alone", async () => {
    const root = makeProject({
      "api/key.production.local": "mine-in-prod",
      "api/key.local": "mine",
    });

    const result = await runRemove({ cwd: root, key: "api/key", local: true });

    expect(result.removed).toEqual(["api/key.local"]);
    expect(valueFile(root, "api/key.production.local")).toBe("mine-in-prod");
  });

  /** `.enc` is orthogonal to scope, so removing a scope removes both of its files. */
  it("removes both files at the environment-local scope", async () => {
    const root = makeProject({
      "api/key.production.local": "mine",
      "api/key.production.local.enc": "ciphertext",
    });

    const result = await runRemove({
      cwd: root,
      key: "api/key",
      environment: "production",
      local: true,
    });

    expect(result.removed).toEqual(["api/key.production.local", "api/key.production.local.enc"]);
  });

  it("removes the file set wrote, for every scope flag combination", async () => {
    for (const options of [
      { environment: "production", local: true },
      { local: true },
      { environment: "production" },
      {},
    ]) {
      const root = makeProject();
      const written = await runSet({ cwd: root, key: "api/key", value: "v", ...options });

      const removed = await runRemove({ cwd: root, key: "api/key", ...options });

      expect(removed.removed).toEqual([written.location]);
      expect(valueFile(root, written.location)).toBeUndefined();
    }
  });
});
