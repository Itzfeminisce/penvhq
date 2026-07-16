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
import type { ValidateIssueKind, ValidateResult } from "./validate.js";
import { runValidate, validateCommand } from "./validate.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod. A
 * project in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
};

const created: string[] = [];
const originalCwd = process.cwd();

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
  /** Replaces the default config entirely. */
  readonly config?: unknown;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "validate-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(fixture.config ?? CONFIG)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
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
