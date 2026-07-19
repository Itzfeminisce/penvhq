/**
 * `penv validate` is the command that has to say no. Three things fail it, and
 * all three are errors rather than warnings: a config the schema rejects, a
 * reserved token in a name (invariant 11), and two parameters mapping to one
 * generated variable (invariant 12 — never last-write-wins).
 *
 * The exit code is checked through the real citty command, because a `validate`
 * that reports a failure and exits zero is a `validate` that no CI job notices.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "citty";
import { afterEach, describe, expect, it } from "vitest";
import { openProject } from "../project.js";
import type { ValidateIssueKind, ValidateResult } from "./validate.js";
import { loadSchema, runValidate, validateCommand } from "./validate.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod. A
 * project in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

const created: string[] = [];
const originalCwd = process.cwd();

/** Where the schema lives when a fixture does not move it. */
const DEFAULT_SCHEMA_FILE = ".penv/env.ts";

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
  /** The whole schema module, verbatim — overrides `schema` when a fixture needs its
   * own imports (e.g. a `server-only` guard). */
  readonly schemaModule?: string;
  /** Declared as `schemaFile` and written there. Defaults to `.penv/env.ts`. */
  readonly schemaFile?: string;
  /** Replaces the default config entirely. */
  readonly config?: unknown;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "validate-"));
  created.push(root);

  const config =
    fixture.config ??
    (fixture.schemaFile === undefined ? CONFIG : { ...CONFIG, schemaFile: fixture.schemaFile });
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  // Only at its declared path: a stray `.penv/env.ts` beside a schema that has
  // moved is a file the grammar would read as a parameter.
  const schemaFile = join(root, fixture.schemaFile ?? DEFAULT_SCHEMA_FILE);
  mkdirSync(dirname(schemaFile), { recursive: true });
  writeFileSync(
    schemaFile,
    fixture.schemaModule ??
      `import { z } from "zod";\nexport const schema = z.object({${fixture.schema ?? ""}});\n`,
    "utf8",
  );

  for (const [name, contents] of Object.entries(fixture.tree ?? {})) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

function kinds(result: ValidateResult): ValidateIssueKind[] {
  return result.issues.map((issue) => issue.kind);
}

/** The exit code `penv validate` would leave behind, run as the CLI runs it. */
async function exitCodeOf(root: string, environment: string): Promise<number | undefined> {
  process.chdir(root);
  process.exitCode = 0;
  try {
    await runCommand(validateCommand, { rawArgs: ["--env", environment] });
    return process.exitCode;
  } finally {
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `PENV_ENV` is how the environment reaches the user's own `.penv/env.ts`, and
 * it is a process global pinned across an `await`. Two loads in flight at once
 * used to interleave on it: the second read the first's value as the one to put
 * back, so the global survived both calls pointing at an environment nobody
 * asked for, and every later load in the process inherited it.
 */
describe("two schema loads at once", () => {
  it("leaves PENV_ENV exactly as it found it", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });
    const project = openProject(root);

    const before = process.env.PENV_ENV;
    expect(before).toBeUndefined();

    // Both in flight together — the interleave needs the overlap.
    await Promise.all([loadSchema(project, "development"), loadSchema(project, "production")]);

    expect(process.env.PENV_ENV).toBeUndefined();
  });

  it("gives each caller its own environment's schema", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const [development, production] = await Promise.all([
      runValidate({ cwd: root, environment: "development" }),
      runValidate({ cwd: root, environment: "production" }),
    ]);

    expect(development?.environment).toBe("development");
    expect(production?.environment).toBe("production");
    expect(process.env.PENV_ENV).toBeUndefined();
  });
});

describe("a schema guarded with server-only", () => {
  // An app that also imports its schema types into client components guards `.penv/env.ts`
  // with `import "server-only"`, which throws outside an RSC bundle. penv's CLI runs in
  // plain Node, so it must resolve server-only to its no-throw `react-server` variant —
  // otherwise it can't even read the `schema` export of a schema the app legitimately
  // marks server-only.
  it("still reads the schema instead of failing to load the module", async () => {
    const root = makeProject({
      schemaModule:
        'import "server-only";\nimport { z } from "zod";\nexport const schema = z.object({ databaseUrl: z.url() });\n',
      tree: { "database-url": "postgres://localhost/app" },
    });
    const project = openProject(root);

    const { schema, issues } = await loadSchema(project, "development");

    expect(issues).toEqual([]);
    expect(schema).toBeDefined();
  });

  it("validates green end-to-end (server-only does not stop the command)", async () => {
    const root = makeProject({
      schemaModule:
        'import "server-only";\nimport { z } from "zod";\nexport const schema = z.object({ databaseUrl: z.url() });\n',
      tree: { "database-url": "postgres://localhost/app" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe("a schema module with the scaffolded eager load", () => {
  /**
   * `export const env = load(schema)` used to throw during the schema read when
   * the tree had no values, taking the `schema` export down with it — so drift
   * stayed EMPTY and `fill` saw nothing to fill in the exact state it exists to
   * fix. Under the harvest pin the module evaluates, the schema is reachable,
   * and the drift names every declared-but-missing parameter.
   */
  it("yields the schema and a measured drift against an empty tree", async () => {
    const root = makeProject({
      schemaModule:
        'import { z } from "zod";\n' +
        'import { load } from "@penvhq/runtime";\n' +
        "export const schema = z.object({ databaseUrl: z.url() });\n" +
        "export const env = load(schema);\n",
    });
    const project = openProject(root);

    const { schema, issues } = await loadSchema(project, "development");
    expect(issues).toEqual([]);
    expect(schema).toBeDefined();

    const result = await runValidate({ cwd: root, environment: "development" });
    expect(result.ok).toBe(false); // the value genuinely is missing
    expect(result.drift.declared.map((entry) => entry.subject)).toEqual(["database-url"]);
  });
});

describe("a configuration the schema accepts", () => {
  it("passes, and exits zero", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url(), redis: z.object({ password: z.string() })",
      tree: { "database-url": "postgres://localhost/app", "redis/password": "secret" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parameters).toBe(2);
    expect(await exitCodeOf(root, "production")).toBe(0);
  });
});

describe("a schema failure", () => {
  it("exits non-zero, naming the parameter", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "not-a-url-at-all" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(kinds(result)).toEqual(["schema"]);
    expect(result.issues[0]?.subject).toBe("databaseUrl");
    expect(await exitCodeOf(root, "production")).toBe(1);
  });

  it("exits non-zero when a required parameter resolves to nothing", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url(), apiKey: z.string()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.subject).toBe("apiKey");
    expect(await exitCodeOf(root, "production")).toBe(1);
  });

  /** The cascade decides which value is checked, so validate reports on the winner. */
  it("checks the value the cascade resolves, not the unscoped default", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app", "database-url.production": "broken" },
    });

    expect((await runValidate({ cwd: root, environment: "production" })).ok).toBe(false);
    expect((await runValidate({ cwd: root, environment: "development" })).ok).toBe(true);
  });
});

describe("a name-mapping collision", () => {
  /**
   * Invariant 12: `database-url` and `database_url` both generate DATABASE_URL,
   * so `penv generate` would silently drop one of the two values. It fails here.
   */
  it("exits non-zero rather than letting the last write win", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url(), databaseUrl2: z.string().optional()",
      tree: { "database-url": "postgres://localhost/app", database_url: "postgres://other/app" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(kinds(result)).toContain("collision");
    const collision = result.issues.find((issue) => issue.kind === "collision");
    expect(collision?.subject).toBe("DATABASE_URL");
    expect(collision?.message).toContain("both map to");
    expect(await exitCodeOf(root, "production")).toBe(1);
  });

  it("stays quiet when every parameter maps to its own variable", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url(), redisUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app", "redis-url": "redis://localhost" },
    });

    expect(kinds(await runValidate({ cwd: root, environment: "production" }))).not.toContain(
      "collision",
    );
  });
});

describe("a reserved token", () => {
  /** Invariant 11: reserved-token validation is mandatory, and an error. */
  it("exits non-zero rather than misparsing the filename", async () => {
    const root = makeProject({ schema: "", tree: { local: "whatever" } });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(kinds(result)).toEqual(["reserved"]);
    expect(result.issues[0]?.subject).toBe("local");
    expect(await exitCodeOf(root, "production")).toBe(1);
  });

  /**
   * `local` can never be an environment either: `<name>.local` already means
   * "personal override" at every scope, and an environment named `local` would
   * make that filename ambiguous.
   */
  it("rejects `enc` as a parameter name, though encryption is not implemented yet", async () => {
    const root = makeProject({ schema: "", tree: { enc: "whatever" } });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.subject).toBe("enc");
  });
});

/**
 * `schemaFile` moves the schema, and the whole command has to move with it. A
 * validate that read `.penv/env.ts` regardless would report a missing file for a
 * project whose schema is exactly where its config says.
 */
describe("a schema the config has moved", () => {
  it("validates against the file `schemaFile` names", async () => {
    const root = makeProject({
      schemaFile: "src/env.ts",
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "not-a-url-at-all" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    // The verdict could only come from `src/env.ts`: nothing else declares it.
    expect(result.ok).toBe(false);
    expect(kinds(result)).toEqual(["schema"]);
    expect(result.issues[0]?.subject).toBe("databaseUrl");
  });

  it("passes when the moved schema is satisfied", async () => {
    const root = makeProject({
      schemaFile: "src/env.ts",
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * A remedy naming `.penv/env.ts` sends the reader to a file that does not
   * exist — the one thing worse than no remedy at all.
   */
  it("names the moved schema in the remedy, not .penv/env.ts", async () => {
    const root = makeProject({
      schemaFile: "src/env.ts",
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "not-a-url-at-all" },
    });

    const remedy = (await runValidate({ cwd: root, environment: "production" })).issues[0]?.remedy;

    expect(remedy).toContain("src/env.ts");
    expect(remedy).not.toContain(".penv/env.ts");
  });

  it("names the moved schema when it exports no schema", async () => {
    const root = makeProject({ schemaFile: "src/env.ts", schema: "" });
    writeFileSync(join(root, "src", "env.ts"), "export const nope = 1;\n", "utf8");

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.subject).toBe("src/env.ts");
    expect(result.issues[0]?.message).toContain("src/env.ts exports no `schema`");
  });
});

describe("the schema module", () => {
  it("reports a schema file that exports no schema", async () => {
    const root = makeProject({ schema: "" });
    writeFileSync(join(root, ".penv", "env.ts"), "export const nope = 1;\n", "utf8");

    const result = await runValidate({ cwd: root, environment: "production" });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("exports no `schema`");
    expect(result.issues[0]?.remedy).toContain("export const schema");
  });
});
