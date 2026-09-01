/**
 * The layout is one answer, so these tests are mostly about what is *not* a
 * record: the loader the project owns, an injection seam, a dotfile penv never
 * wrote. Anything left over is what an unmigrated project is refused for, and
 * what `penv migrate` moves — the same list, so the two can never disagree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMigrated,
  oldLayoutEntries,
  RECORDS_PATH,
  recordPath,
  recordsDir,
  renderStateGitignore,
  STATE_PATH,
} from "./layout.js";
import type { PenvConfig } from "./types.js";

const config: PenvConfig = {
  environments: {
    development: "@penvhq/provider-filesystem",
    production: "@penvhq/provider-filesystem",
  },
};

const created: string[] = [];

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "penv-layout-"));
  created.push(root);
  mkdirSync(join(root, ".penv"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the paths", () => {
  it("puts the records under the state directory", () => {
    expect(STATE_PATH).toBe(".penv/state");
    expect(RECORDS_PATH).toBe(".penv/state/records");
    expect(recordPath("redis/password.production")).toBe(
      ".penv/state/records/redis/password.production",
    );
  });

  it("resolves the tree against a project root", () => {
    const root = makeProject();
    expect(recordsDir(root)).toBe(join(root, ".penv", "state", "records"));
  });
});

describe("oldLayoutEntries", () => {
  it("names the records still sitting directly under .penv/", () => {
    const root = makeProject();
    writeFileSync(join(root, ".penv", "api-key.production"), "s3cret\n", "utf8");
    mkdirSync(join(root, ".penv", "redis"), { recursive: true });
    writeFileSync(join(root, ".penv", "redis", "password"), "hunter2\n", "utf8");

    expect(oldLayoutEntries(root, config)).toEqual(["api-key.production", "redis"]);
  });

  /** The loader, an injection seam, and a dotfile were never records. */
  it("leaves the project's own files out of the move", () => {
    const root = makeProject();
    writeFileSync(join(root, ".penv", "env.ts"), "export const schema = {};\n", "utf8");
    writeFileSync(join(root, ".penv", "preload.ts"), 'import "@env";\n', "utf8");
    writeFileSync(join(root, ".penv", ".DS_Store"), "", "utf8");

    expect(oldLayoutEntries(root, config)).toEqual([]);
  });

  it("is empty on a project already on the new layout", () => {
    const root = makeProject();
    mkdirSync(recordsDir(root), { recursive: true });
    writeFileSync(join(recordsDir(root), "api-key.production"), "s3cret\n", "utf8");
    writeFileSync(join(root, ".penv", "env.ts"), "export const schema = {};\n", "utf8");

    expect(oldLayoutEntries(root, config)).toEqual([]);
    expect(() => assertMigrated(root, config)).not.toThrow();
  });

  /**
   * On a case-insensitive filesystem these ARE `state/` and `env.ts`, and reading
   * them as records would refuse an already-migrated project from every command.
   */
  it("recognises penv's own names whatever their casing", () => {
    const root = mkdtempSync(join(tmpdir(), "penv-layout-"));
    created.push(root);
    mkdirSync(join(root, ".penv", "State"), { recursive: true });
    writeFileSync(join(root, ".penv", "Env.TS"), "export const schema = {};\n", "utf8");

    expect(oldLayoutEntries(root, config)).toEqual([]);
    expect(() => assertMigrated(root, config)).not.toThrow();
  });

  /** The negative case: a record whose name merely resembles one of them still moves. */
  it("keeps a record that only looks like one of them", () => {
    const root = makeProject();
    writeFileSync(join(root, ".penv", "state-url"), "postgres://localhost\n", "utf8");

    expect(oldLayoutEntries(root, config)).toEqual(["state-url"]);
  });

  it("is empty on a project with no .penv/ at all", () => {
    const root = mkdtempSync(join(tmpdir(), "penv-layout-"));
    created.push(root);

    expect(oldLayoutEntries(root, config)).toEqual([]);
  });
});

describe("assertMigrated", () => {
  it("refuses an old-layout project by naming the one command that converts it", () => {
    const root = makeProject();
    writeFileSync(join(root, ".penv", "api-key.production"), "s3cret\n", "utf8");

    expect(() => assertMigrated(root, config)).toThrowError(/penv migrate/);
  });
});

describe("renderStateGitignore", () => {
  it("ignores values and the rollback bundle, keeps structure and decisions", () => {
    const ignore = renderStateGitignore(config);

    expect(ignore).toContain("*\n");
    expect(ignore).toContain("!*/\n");
    expect(ignore).toContain("!.gitignore\n");
    expect(ignore).toContain("!*.json\n");
    expect(ignore).toContain("!*.d.ts\n");
    expect(ignore).toContain("rollback/\n");
    // The bundle is re-excluded after the directory pattern, or it would be committed.
    expect(ignore.indexOf("rollback/")).toBeGreaterThan(ignore.indexOf("!*/"));
  });

  /**
   * `!*.json` is there for meta and the manifest. cutover.json is neither: it
   * names this machine's rollback bundle, and committing it hands a teammate an
   * unresolved migration they never ran.
   */
  it("keeps the adoption cutover state out of the committed set", () => {
    const ignore = renderStateGitignore(config);

    expect(ignore).toContain("/cutover.json\n");
    expect(ignore.indexOf("/cutover.json")).toBeGreaterThan(ignore.indexOf("!*.json"));
  });

  /** A `!env.ts` naming nothing is a line the next reader has to prove is dead. */
  it("un-ignores the schema only when it lives in the tree", () => {
    expect(renderStateGitignore(config)).not.toContain("!env.ts");
    expect(renderStateGitignore({ ...config, schemaFile: ".penv/env.ts" })).not.toContain(
      "!env.ts",
    );
    expect(renderStateGitignore({ ...config, schemaFile: ".penv/state/records/env.ts" })).toContain(
      "!env.ts\n",
    );
  });
});
