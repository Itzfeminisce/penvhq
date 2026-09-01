/**
 * The migration is a relocation, so the properties under test are the ones a
 * relocation must have: every record arrives byte-identical under its own name,
 * nothing the user owns is touched, the second run does nothing and says so, and
 * a tree that is half in each layout is refused rather than merged.
 *
 * The refusal is tested through a command a user would actually type, not
 * through `assertMigrated` directly: the point is that an unmigrated project
 * cannot be read by accident, and that is only true if the path every command
 * opens runs the check.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError, recordsDir } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { runList } from "./list.js";
import { applyMigrate, planMigrate, renderMigrate, runMigrate } from "./migrate.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: {
    development: "@penvhq/provider-filesystem",
    production: "@penvhq/provider-filesystem",
  },
};

/** The loader, the shape and the config: the three files migration must not touch. */
const ENV_TS = 'import { z } from "zod";\nexport const schema = z.object({});\n';
const SCHEMA_TS = 'import { z } from "zod";\nexport const schema = z.object({});\n';
const PRELOAD_TS = 'import "@env";\n';

/** A sealed value, so the test proves a ciphertext crosses byte for byte. */
const SEALED = "penv:1:production:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDQ4PEA\n";

/** The records an old-layout project keeps directly under `.penv/`. */
const RECORDS: Readonly<Record<string, string>> = {
  "api-key": "dev-key\n",
  "api-key.production.enc": SEALED,
  "api-key.json": '{\n  "secret": true\n}\n',
  "redis/password.production": "hunter2\n",
  "redis/password.json": '{\n  "secret": true\n}\n',
};

/** What penv wrote as the boundary before the layout moved. */
const OLD_IGNORE = "# Written by penv.\n*\n!*/\n!.gitignore\n!env.ts\n!*.json\n";

const created: string[] = [];

/** A project written the way penv wrote them before `.penv/state/` existed. */
function makeOldProject(records: Readonly<Record<string, string>> = RECORDS): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "migrate-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  writeFileSync(join(root, "penv.schema.ts"), SCHEMA_TS, "utf8");
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(join(root, ".penv", "env.ts"), ENV_TS, "utf8");
  writeFileSync(join(root, ".penv", "preload.ts"), PRELOAD_TS, "utf8");
  writeFileSync(join(root, ".penv", ".gitignore"), OLD_IGNORE, "utf8");
  for (const [name, contents] of Object.entries(records)) {
    const file = join(root, ".penv", ...name.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

function read(root: string, ...segments: string[]): string {
  return readFileSync(join(root, ...segments), "utf8");
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("penv migrate", () => {
  it("moves every record under the tree, byte for byte", () => {
    const root = makeOldProject();

    const result = runMigrate({ cwd: root, yes: true });

    expect(result.status).toBe("migrated");
    for (const [name, contents] of Object.entries(RECORDS)) {
      expect(read(root, ".penv", "state", "records", ...name.split("/"))).toBe(contents);
      expect(existsSync(join(root, ".penv", ...name.split("/")))).toBe(false);
    }
  });

  it("leaves the files the user owns exactly as they were", () => {
    const root = makeOldProject();

    runMigrate({ cwd: root, yes: true });

    expect(read(root, "penv.schema.ts")).toBe(SCHEMA_TS);
    expect(read(root, "penv.config.ts")).toBe(`export default ${JSON.stringify(CONFIG)};\n`);
    expect(read(root, ".penv", "env.ts")).toBe(ENV_TS);
    // The injection seam is the project's code too, not a record.
    expect(read(root, ".penv", "preload.ts")).toBe(PRELOAD_TS);
  });

  it("replaces the old boundary with the one over state/", () => {
    const root = makeOldProject();

    runMigrate({ cwd: root, yes: true });

    expect(existsSync(join(root, ".penv", ".gitignore"))).toBe(false);
    const ignore = read(root, ".penv", "state", ".gitignore");
    expect(ignore).toContain("*\n");
    expect(ignore).toContain("!*.json");
    expect(ignore).toContain("rollback/");
  });

  it("is a no-op the second time, and says so", () => {
    const root = makeOldProject();
    runMigrate({ cwd: root, yes: true });
    const before = readdirSync(recordsDir(root)).sort();

    const again = runMigrate({ cwd: root, yes: true });

    expect(again.status).toBe("current");
    expect(again.moves).toEqual([]);
    expect(readdirSync(recordsDir(root)).sort()).toEqual(before);
    expect(renderMigrate(again).join("\n")).toContain("nothing to migrate");
  });

  it("writes nothing until the move is approved", () => {
    const root = makeOldProject();

    const preview = runMigrate({ cwd: root });

    expect(preview.status).toBe("previewed");
    expect(preview.moves.map((move) => move.from)).toContain(".penv/api-key");
    expect(existsSync(recordsDir(root))).toBe(false);
    expect(read(root, ".penv", "api-key")).toBe(RECORDS["api-key"]);
    expect(renderMigrate(preview).join("\n")).toContain(".penv/state/records/api-key");
  });

  it("refuses a tree that is half in each layout", () => {
    const root = makeOldProject();
    mkdirSync(recordsDir(root), { recursive: true });
    writeFileSync(join(recordsDir(root), "api-key"), "a second answer\n", "utf8");

    let thrown: unknown;
    try {
      planMigrate(root);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PenvError);
    expect((thrown as PenvError).code).toBe("HALF_MIGRATED");
    expect((thrown as PenvError).message).toContain("`api-key` is in both");
    // The user's own copy is still there — a refusal that wrote would be worse
    // than no refusal at all.
    expect(read(root, ".penv", "state", "records", "api-key")).toBe("a second answer\n");
    expect(read(root, ".penv", "api-key")).toBe(RECORDS["api-key"]);
  });

  /**
   * The negative case, and the reason the refusal is keyed off names rather than
   * off both sides holding something: a migration interrupted between two renames
   * leaves exactly this, and every other command answers it by naming `migrate`.
   */
  it("resumes a migration that was interrupted partway", () => {
    const root = makeOldProject();
    // What a crash after the first rename leaves: one record moved, the rest not.
    mkdirSync(recordsDir(root), { recursive: true });
    writeFileSync(join(recordsDir(root), "api-key"), RECORDS["api-key"] ?? "", "utf8");
    rmSync(join(root, ".penv", "api-key"));

    const result = runMigrate({ cwd: root, yes: true });

    expect(result.status).toBe("migrated");
    expect(read(root, ".penv", "state", "records", "api-key")).toBe(RECORDS["api-key"]);
    expect(read(root, ".penv", "state", "records", "redis", "password.production")).toBe(
      RECORDS["redis/password.production"],
    );
    expect(runMigrate({ cwd: root, yes: true }).status).toBe("current");
  });

  /** A name that differs only in case is the same file on Windows and macOS, so it collides. */
  it("refuses a record the tree already holds under another casing", () => {
    const root = makeOldProject();
    mkdirSync(recordsDir(root), { recursive: true });
    writeFileSync(join(recordsDir(root), "API-KEY"), "a second answer\n", "utf8");

    let thrown: unknown;
    try {
      planMigrate(root);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as PenvError).code).toBe("HALF_MIGRATED");
  });

  /**
   * Invariant 20: the records this command just moved are never unignored, not
   * even for the instant between two writes. Proved by failing the write of the
   * new boundary — the old one has to still be there.
   */
  it("writes the new boundary before it drops the old one", () => {
    const root = makeOldProject();
    const plan = planMigrate(root);
    // A directory where the file goes, so writing the new boundary throws.
    mkdirSync(join(root, ".penv", "state", ".gitignore"), { recursive: true });

    expect(() => applyMigrate(plan)).toThrow();

    expect(read(root, ".penv", ".gitignore")).toBe(OLD_IGNORE);
  });

  /** The negative case: when the new boundary lands, the old one goes. */
  it("drops the old boundary once the new one is written", () => {
    const root = makeOldProject();

    applyMigrate(planMigrate(root));

    expect(existsSync(join(root, ".penv", ".gitignore"))).toBe(false);
    expect(read(root, ".penv", "state", ".gitignore")).toContain("!.gitignore\n");
  });

  it("plans nothing for a project that never held records", () => {
    const root = makeOldProject({});
    rmSync(join(root, ".penv", ".gitignore"));
    applyMigrate(planMigrate(root));

    expect(runMigrate({ cwd: root, yes: true }).status).toBe("current");
  });
});

describe("the old-layout refusal", () => {
  it("fires on a command that reads the tree, naming penv migrate", async () => {
    const root = makeOldProject();

    await expect(runList({ cwd: root, environment: "production" })).rejects.toThrowError(
      /penv migrate/,
    );
  });

  it("stays quiet once the project has moved", async () => {
    const root = makeOldProject();
    runMigrate({ cwd: root, yes: true });

    const result = await runList({ cwd: root, environment: "production" });

    expect(result.parameters.map((entry) => entry.parameter)).toEqual([
      "api-key",
      "redis.password",
    ]);
  });
});
