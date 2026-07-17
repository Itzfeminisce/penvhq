/**
 * `penv import` is the adoption path, and the only command that turns someone
 * else's file into penv's tree. Two of its failures are destructive rather than
 * merely wrong, so both are tested for what the tree looks like *afterwards*:
 *
 *  - A reserved name (invariant 11) written as `.penv/enc` re-parses as a scope
 *    segment, so every later `list()` throws and the project cannot be read,
 *    repaired, or even `remove`d through penv. Reporting it afterwards is too
 *    late; the file must never exist.
 *  - A name that does not round-trip (the v0.1 gate) silently renames the user's
 *    variable, so the app reads `undefined` from a `.env` penv generated.
 *
 * Both must therefore fail *atomically* — the assertions below are about the
 * absence of files, not just the presence of an error.
 *
 * A third failure joined them, and it is the reason `import` reads the scope out
 * of the source filename at all: flattening `.env.production` to the unscoped
 * default is not a lossy import, it is a scope-widening leak — the production
 * value becomes what *development* reads. It is tested the way it was found, by
 * resolving the other environment afterwards.
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError } from "@penv/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keySourceFor, openProject, resolveSync } from "../project.js";
import { EMPTY_DRIFT } from "../schema.js";
import type { ImportReport } from "./import.js";
import { importDotenv, renderImport } from "./import.js";
import type { ValidateResult } from "./validate.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod. A
 * project in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};

const created: string[] = [];

interface Fixture {
  /** The dotenv file's contents. */
  readonly dotenv: string;
  /** Replaces the default config. Omit to leave the project unscaffolded. */
  readonly config?: unknown;
  /** The source file's name. `.env` unless a test is about the scope it names. */
  readonly filename?: string;
  /** Written to `.penv/env.ts` before the import, so invariant 2 has a file to keep. */
  readonly schema?: string;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "import-"));
  created.push(root);

  if (fixture.config !== undefined) {
    writeFileSync(
      join(root, "penv.config.ts"),
      `export default ${JSON.stringify(fixture.config)};\n`,
      "utf8",
    );
  }
  if (fixture.schema !== undefined) {
    mkdirSync(join(root, ".penv"), { recursive: true });
    writeFileSync(join(root, ".penv", "env.ts"), fixture.schema, "utf8");
  }
  writeFileSync(join(root, fixture.filename ?? ".env"), fixture.dotenv, "utf8");
  return root;
}

/** Every file below `.penv/`, so a test can assert the tree is clean. */
function penvTree(root: string): string[] {
  const dir = join(root, ".penv");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
}

function importFails(root: string, file = ".env", environment?: string): PenvError {
  let thrown: unknown;
  try {
    importDotenv({
      cwd: root,
      file,
      ...(environment === undefined ? {} : { environment }),
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PenvError);
  return thrown as PenvError;
}

function setEnv(name: "PENV_ENV" | "NODE_ENV", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;

/**
 * `import` resolves the environment before it writes anything, so these fixtures
 * need one. It is pinned rather than left to the runner's `NODE_ENV=test`
 * because what a fixture's config declares is the subject of several tests
 * below — `development` is declared by every config here.
 */
beforeEach(() => {
  setEnv("PENV_ENV", "development");
});

afterEach(() => {
  setEnv("PENV_ENV", originalPenvEnv);
  setEnv("NODE_ENV", originalNodeEnv);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a variable that is a reserved token", () => {
  /**
   * Invariant 11, and the whole reason this is an error rather than a warning:
   * `.penv/enc` is not a bad import, it is an unreadable project.
   */
  it("fails, naming the variable as the .env spells it", () => {
    const root = makeProject({ dotenv: "ENC=some-secret\n", config: CONFIG });

    const error = importFails(root);

    expect(error.code).toBe("RESERVED_TOKEN");
    // `ENC`, not `enc`: the user is looking at their .env.
    expect(error.message).toContain("ENC");
    expect(error.message).toContain("reserved token");
  });

  it("writes no value file, so the project is still readable", () => {
    const root = makeProject({ dotenv: "ENC=some-secret\n", config: CONFIG });

    importFails(root);

    expect(penvTree(root)).toEqual([]);
    expect(existsSync(join(root, ".penv", "enc"))).toBe(false);
  });

  it.each(["JSON", "TOML", "YML", "LOCAL"])("refuses %s for the same reason", (variable) => {
    const root = makeProject({ dotenv: `${variable}=whatever\n`, config: CONFIG });

    expect(importFails(root).code).toBe("RESERVED_TOKEN");
    expect(penvTree(root)).toEqual([]);
  });

  /**
   * Shared decision (A): the reserved set is every declared environment plus the
   * static tokens, so `PRODUCTION=1` collides exactly the way `ENC=1` does —
   * `.penv/production` would re-parse as a scope segment with no parameter.
   */
  it("refuses a variable named after a declared environment", () => {
    const root = makeProject({ dotenv: "PRODUCTION=eu-west-1\n", config: CONFIG });

    const error = importFails(root);

    expect(error.code).toBe("RESERVED_TOKEN");
    expect(error.message).toContain("PRODUCTION");
    expect(penvTree(root)).toEqual([]);
  });

  /** Invariant 10: reserved-because-declared, never reserved by inference. */
  it("accepts that same variable when no environment declares it", () => {
    const root = makeProject({
      dotenv: "PRODUCTION=eu-west-1\n",
      config: { environments: ["development"], providers: { development: { type: "filesystem" } } },
    });

    const report = importDotenv({ cwd: root, file: ".env" });

    expect(report.variables).toBe(1);
    expect(existsSync(join(root, ".penv", "production"))).toBe(true);
  });

  /** Nothing partial: the good variables in the file are not imported either. */
  it("imports none of the file's other variables", () => {
    const root = makeProject({
      dotenv: "DATABASE_URL=postgres://localhost/app\nENC=some-secret\nAPI_KEY=k\n",
      config: CONFIG,
    });

    importFails(root);

    expect(penvTree(root)).toEqual([]);
  });
});

describe("a variable that does not round-trip", () => {
  /**
   * The v0.1 gate: `MY-VAR` regenerates as `MY_VAR`, so the app's
   * `process.env["MY-VAR"]` reads `undefined`. A silent rename is the drift penv
   * exists to remove, so import refuses rather than performing it.
   */
  it("fails, naming the override that would make it legal", () => {
    const root = makeProject({ dotenv: "MY-VAR=1\n", config: CONFIG });

    const error = importFails(root);

    expect(error.code).toBe("IMPORT_LOSSY_NAME");
    expect(error.message).toContain("MY-VAR");
    expect(error.message).toContain("MY_VAR");
    expect(error.remedy).toContain("names");
    expect(error.remedy).toContain("penv.config.ts");
    expect(penvTree(root)).toEqual([]);
  });

  it("refuses a variable that is not SCREAMING_SNAKE at all", () => {
    const root = makeProject({ dotenv: "lowerKey=1\n", config: CONFIG });

    expect(importFails(root).code).toBe("IMPORT_LOSSY_NAME");
  });

  /**
   * The negative case, and the reason the gate says "modulo declared name
   * overrides": an override makes the generated name a stated decision, so the
   * round trip is lossless again and the import is legal.
   */
  it("succeeds when penv.config.ts declares a names override for it", () => {
    const root = makeProject({
      dotenv: "MY-VAR=1\n",
      config: { ...CONFIG, names: { "my-var": "MY-VAR" } },
    });

    const report = importDotenv({ cwd: root, file: ".env" });

    expect(report.variables).toBe(1);
    expect(existsSync(join(root, ".penv", "my-var"))).toBe(true);
  });

  /** An override that renames it to something *else* still round-trips badly. */
  it("still refuses when the override does not restore the variable", () => {
    const root = makeProject({
      dotenv: "MY-VAR=1\n",
      config: { ...CONFIG, names: { "my-var": "SOMETHING_ELSE" } },
    });

    expect(importFails(root).code).toBe("IMPORT_LOSSY_NAME");
  });

  it("stays quiet for a variable that already round-trips", () => {
    const root = makeProject({ dotenv: "DATABASE_URL=postgres://localhost/app\n", config: CONFIG });

    expect(importDotenv({ cwd: root, file: ".env" }).variables).toBe(1);
  });
});

const API_KEY = { namespace: [], name: "api-key" };

/** What the environment reads once the import has run, through the real cascade. */
function resolveFor(root: string, environment: string): string | undefined {
  const project = openProject(root);
  return resolveSync(project.provider, API_KEY, environment, keySourceFor(project, environment))
    .value;
}

describe("the scope the source filename names", () => {
  /**
   * The bug the four-level cascade exists to delete, asserted as the failure it
   * actually was: `.env.production` flattened to the unscoped default, and
   * `penv get api-key --env development` handed back the production secret.
   */
  it("writes .env.production at production scope, where development cannot read it", () => {
    const root = makeProject({
      dotenv: "API_KEY=PRODUCTION-SECRET-abc123\n",
      config: CONFIG,
      filename: ".env.production",
    });

    const report = importDotenv({ cwd: root, file: ".env.production" });

    expect(report.scope).toEqual({ kind: "environment", environment: "production" });
    expect(penvTree(root)).toContain("api-key.production");
    expect(penvTree(root)).not.toContain("api-key");
    expect(resolveFor(root, "production")).toBe("PRODUCTION-SECRET-abc123");
    // The leak: an unscoped default would serve every environment, so development
    // would read a production secret.
    expect(resolveFor(root, "development")).toBeUndefined();
  });

  it("writes .env.development.local at environment-local scope", () => {
    const root = makeProject({
      dotenv: "API_KEY=my-machine-only\n",
      config: CONFIG,
      filename: ".env.development.local",
    });

    const report = importDotenv({ cwd: root, file: ".env.development.local" });

    expect(report.scope).toEqual({ kind: "environment-local", environment: "development" });
    expect(penvTree(root)).toContain("api-key.development.local");
    expect(resolveFor(root, "development")).toBe("my-machine-only");
    expect(resolveFor(root, "production")).toBeUndefined();
  });

  it("writes .env.local at local scope", () => {
    const root = makeProject({
      dotenv: "API_KEY=every-environment-on-my-machine\n",
      config: CONFIG,
      filename: ".env.local",
    });

    const report = importDotenv({ cwd: root, file: ".env.local" });

    expect(report.scope).toEqual({ kind: "local" });
    expect(penvTree(root)).toContain("api-key.local");
    expect(resolveFor(root, "development")).toBe("every-environment-on-my-machine");
  });

  /** The plain-`.env` case, and the reason unscoped is still the default. */
  it("writes .env at unscoped scope", () => {
    const root = makeProject({ dotenv: "API_KEY=shared-default\n", config: CONFIG });

    const report = importDotenv({ cwd: root, file: ".env" });

    expect(report.scope).toEqual({ kind: "unscoped" });
    expect(penvTree(root)).toContain("api-key");
    expect(resolveFor(root, "development")).toBe("shared-default");
    expect(resolveFor(root, "production")).toBe("shared-default");
  });

  /** The basename may be anything the user points at; the scope starts at `.env`. */
  it("reads the scope from the first `env` segment, whatever precedes it", () => {
    const root = makeProject({
      dotenv: "API_KEY=k\n",
      config: CONFIG,
      filename: "fake.env.production",
    });

    const report = importDotenv({ cwd: root, file: "fake.env.production" });

    expect(report.scope).toEqual({ kind: "environment", environment: "production" });
  });

  it("imports a file with no `env` segment as the unscoped default", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG, filename: "config.txt" });

    const report = importDotenv({ cwd: root, file: "config.txt" });

    expect(report.scope).toEqual({ kind: "unscoped" });
    expect(penvTree(root)).toContain("api-key");
  });

  /**
   * Invariant 10: a segment is an environment because the config declares it.
   * Falling back to unscoped for an undeclared one is the leak, so it is refused
   * — and refused before anything is written.
   */
  it("refuses an undeclared environment, and writes nothing", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG, filename: ".env.staging" });

    const error = importFails(root, ".env.staging");

    expect(error.code).toBe("UNKNOWN_ENVIRONMENT");
    expect(error.message).toContain("staging");
    expect(error.message).toContain("production");
    expect(penvTree(root)).toEqual([]);
  });

  /** `.env.example` is the same refusal: `example` is in the environment position. */
  it("refuses .env.example rather than flattening it to the default", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG, filename: ".env.example" });

    expect(importFails(root, ".env.example").code).toBe("UNKNOWN_ENVIRONMENT");
    expect(penvTree(root)).toEqual([]);
  });

  /** The environment always precedes `local`, at both ends of the import. */
  it("refuses .env.local.production, naming the file it means", () => {
    const root = makeProject({
      dotenv: "API_KEY=k\n",
      config: CONFIG,
      filename: ".env.local.production",
    });

    const error = importFails(root, ".env.local.production");

    expect(error.code).toBe("FILENAME_GRAMMAR");
    expect(error.remedy).toContain(".env.production.local");
    expect(penvTree(root)).toEqual([]);
  });
});

describe("--env against the environment the filename names", () => {
  /** Two environments, one import: penv says so rather than picking one. */
  it("refuses an --env that contradicts the filename, and writes nothing", () => {
    const root = makeProject({
      dotenv: "API_KEY=PRODUCTION-SECRET-abc123\n",
      config: CONFIG,
      filename: ".env.production",
    });

    const error = importFails(root, ".env.production", "development");

    expect(error.code).toBe("IMPORT_ENV_CONFLICT");
    expect(error.message).toContain("production");
    expect(error.message).toContain("development");
    expect(penvTree(root)).toEqual([]);
  });

  it("accepts an --env that says the same thing the filename does", () => {
    const root = makeProject({
      dotenv: "API_KEY=k\n",
      config: CONFIG,
      filename: ".env.production",
    });

    const report = importDotenv({ cwd: root, file: ".env.production", environment: "production" });

    expect(report.environment).toBe("production");
  });

  /** `penv import .env.production` means production without being told twice. */
  it("defaults the environment to the one the filename names", () => {
    const root = makeProject({
      dotenv: "API_KEY=k\n",
      config: CONFIG,
      filename: ".env.production",
    });

    // PENV_ENV says development; the file the user pointed at says production.
    const report = importDotenv({ cwd: root, file: ".env.production" });

    expect(report.environment).toBe("production");
  });

  /**
   * The quickstart: `penv import .env` on a greenfield project, where no
   * environment could plausibly be set yet. An unscoped import needs none — the
   * unscoped default is a scope — so it adopts, and only the validation that
   * follows goes without. Demanding one here failed the first command the docs
   * give, to satisfy a step the caller has not reached.
   */
  it("imports at the unscoped default when no environment is set", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG });
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    const report = importDotenv({ cwd: root, file: ".env" });

    expect(report.environment).toBeUndefined();
    expect(report.scope).toEqual({ kind: "unscoped" });
    expect(penvTree(root)).toContain("api-key");
    expect(existsSync(join(root, ".env.backup"))).toBe(true);
  });

  /**
   * Invariant 13: the values landed, so a silent skip would read as a validated
   * tree. The line has to name the skip and a way to close it.
   */
  it("says validation was skipped, and names an environment to pass", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG });
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    const report = importDotenv({ cwd: root, file: ".env" });
    const line = renderImport(report, undefined).find((text) =>
      text.includes("Skipped validation"),
    );

    // `formatSteps` pads the text to a column, so a text that overruns it prints
    // the note with no separator at all. Asserting the whole line rather than
    // `toContain` is what catches that: the first version of this ran the two
    // together into `...is setrun \`penv validate...\``.
    expect(line).toMatch(
      /^⚠ Skipped validation\s+\(no environment set — run `penv validate --env development`\)$/,
    );
  });

  /**
   * Adoption stays all or nothing where an environment IS named: resolving a
   * named environment *after* writing the tree left a half-adopted project
   * behind every time this failed.
   */
  it("writes nothing when the source names an environment that is not declared", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG });
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    const error = importFails(root, ".env", "staging");

    expect(error.code).toBe("UNKNOWN_ENVIRONMENT");
    expect(penvTree(root)).toEqual([]);
    expect(existsSync(join(root, ".env.backup"))).toBe(false);
  });
});

/**
 * The gap the leak lived in: every test above hands `--env` a filename that
 * already carries the environment, so `--env` is never the *only* thing naming
 * it. These point it at files that name none, which is the case the flag exists
 * for and the case that wrote a production secret to the unscoped default.
 */
describe("--env for a filename that names no environment", () => {
  /**
   * The leak, reproduced as it was found: `--env` reached the environment and the
   * closing validate but never the scope, so `api-key` was written unscoped and
   * `penv get api-key --env development` handed back the production secret.
   */
  it("scopes a file with no `env` segment to --env, where development cannot read it", () => {
    const root = makeProject({
      dotenv: "API_KEY=PRODUCTION-SECRET-abc123\n",
      config: CONFIG,
      filename: "prod-secrets.txt",
    });

    const report = importDotenv({
      cwd: root,
      file: "prod-secrets.txt",
      environment: "production",
    });

    expect(report.scope).toEqual({ kind: "environment", environment: "production" });
    expect(penvTree(root)).toContain("api-key.production");
    expect(penvTree(root)).not.toContain("api-key");
    expect(resolveFor(root, "production")).toBe("PRODUCTION-SECRET-abc123");
    expect(resolveFor(root, "development")).toBeUndefined();
  });

  /** `.env` names no environment either, so `--env` names it the same way. */
  it("scopes .env to --env, where development cannot read it", () => {
    const root = makeProject({ dotenv: "API_KEY=PRODUCTION-SECRET-abc123\n", config: CONFIG });

    const report = importDotenv({ cwd: root, file: ".env", environment: "production" });

    expect(report.scope).toEqual({ kind: "environment", environment: "production" });
    expect(penvTree(root)).toContain("api-key.production");
    expect(resolveFor(root, "production")).toBe("PRODUCTION-SECRET-abc123");
    expect(resolveFor(root, "development")).toBeUndefined();
  });

  /**
   * `--env "$ENVIRONMENT"` with the variable unset reaches penv as a blank flag,
   * and blank must never read as "no `--env`": that silently rewrites the scope
   * the user asked for into the unscoped default, which is the leak by a quieter
   * route (invariants 10 and 13). `set` refuses the blank flag for the same
   * reason — a writer scoping a file to an environment nobody named.
   */
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses a %s --env rather than importing unscoped", (_label, environment) => {
    const root = makeProject({
      dotenv: "API_KEY=PRODUCTION-SECRET-abc123\n",
      config: CONFIG,
      filename: "prod-secrets.txt",
    });

    const error = importFails(root, "prod-secrets.txt", environment);

    expect(error.code).toBe("IMPORT_ENV_FLAG_EMPTY");
    expect(penvTree(root)).toEqual([]);
  });

  /**
   * `.env.local` names a scope but no environment, so the two compose: the
   * filename says personal override, `--env` says which environment it overrides.
   * `.env.local --env production` is the file `.env.production.local`.
   */
  it("composes .env.local with --env into the environment-local scope", () => {
    const root = makeProject({
      dotenv: "API_KEY=my-machine-against-production\n",
      config: CONFIG,
      filename: ".env.local",
    });

    const report = importDotenv({ cwd: root, file: ".env.local", environment: "production" });

    expect(report.scope).toEqual({ kind: "environment-local", environment: "production" });
    expect(penvTree(root)).toContain("api-key.production.local");
    expect(penvTree(root)).not.toContain("api-key.local");
    expect(resolveFor(root, "production")).toBe("my-machine-against-production");
    expect(resolveFor(root, "development")).toBeUndefined();
  });

  /** Invariant 10: `--env` is a declared name or it is nothing, and nothing is written. */
  it("refuses an undeclared --env, listing the declared environments", () => {
    const root = makeProject({ dotenv: "API_KEY=k\n", config: CONFIG, filename: "config.txt" });

    const error = importFails(root, "config.txt", "staging");

    expect(error.code).toBe("UNKNOWN_ENVIRONMENT");
    expect(error.message).toContain("staging");
    expect(error.message).toContain("production");
    expect(penvTree(root)).toEqual([]);
    expect(existsSync(join(root, "config.txt.backup"))).toBe(false);
  });
});

describe("an env.ts the import kept", () => {
  const KEPT: Fixture = {
    dotenv: "API_KEY=k\nDATABASE_URL=postgres://localhost/app\n",
    config: CONFIG,
    schema: 'import { z } from "zod";\n\nexport const schema = z.object({});\n',
  };

  const PASSED: ValidateResult = {
    ok: true,
    environment: "development",
    parameters: 2,
    issues: [],
    drift: EMPTY_DRIFT,
  };

  /**
   * Invariant 2 keeps the file; invariant 13 makes the consequence loud. `penv
   * init` then `penv import` leaves an empty `z.object({})` while the parameters
   * sit in the tree, and the closing validate passes — an empty object satisfies
   * an empty schema. A ✓ there reports that as fine.
   */
  it("warns, naming how many parameters the skipped draft would have declared", () => {
    const root = makeProject(KEPT);

    const report: ImportReport = importDotenv({ cwd: root, file: ".env" });
    const line = renderImport(report, PASSED).find((text) => text.includes("env.ts"));

    expect(line).toBeDefined();
    expect(line).toContain("⚠");
    expect(line).not.toContain("✓");
    expect(line).toContain("2");
    expect(line).toContain("undeclared");
    expect(line).toContain("skipped");
  });

  it("still reports a schema it wrote itself with a ✓", () => {
    const root = makeProject({ dotenv: KEPT.dotenv, config: CONFIG });

    const report = importDotenv({ cwd: root, file: ".env" });
    const line = renderImport(report, PASSED).find((text) => text.includes("env.ts"));

    expect(line).toContain("✓");
    expect(line).toContain("Generated");
  });
});

/*
 * The unscaffolded case — `penv import .env` on a fresh directory — is not
 * covered here. It cannot be: the config `penv init` writes opens with
 * `import { defineConfig } from "penv"`, so loading it needs the `penv` package
 * built, and a fixture project resolves that no better than it resolves zod.
 * `importDotenv` has always had to load the config it scaffolds, so this is a
 * limit of the fixtures rather than of the checks — every check above runs on
 * the config in effect, whether it was found or just written.
 */

/**
 * The two halves of one scaffold must answer the same question the same way.
 *
 * `scaffold` takes its decisions with a default, so import compiled while
 * quietly passing none — and wrote a config saying `schemaFile: "src/env.ts"`
 * beside a schema it had just put in `.penv/env.ts`. The project then had a
 * config pointing at a file that did not exist, and `penv validate` looked for
 * it there forever. The optional parameter is what hid it from the compiler:
 * nothing was missing, so nothing was reported.
 */
describe("the schema goes where the config says", () => {
  it("scaffolds the schema at the path it wrote into the config", () => {
    const root = makeProject({ dotenv: "API_KEY=abc\n", filename: ".env.production" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { next: "16.0.0" } }),
      "utf8",
    );

    importDotenv({ cwd: root, file: ".env.production" });

    const config = readFileSync(join(root, "penv.config.ts"), "utf8");
    expect(config).toContain('schemaFile: "src/env.ts"');
    // The file the config names is the file that exists.
    expect(existsSync(join(root, "src", "env.ts"))).toBe(true);
    expect(existsSync(join(root, ".penv", "env.ts"))).toBe(false);
  });

  /** With no framework there is nothing to detect, so both halves say the default. */
  it("keeps both halves on the default when nothing is detected", () => {
    const root = makeProject({ dotenv: "API_KEY=abc\n", filename: ".env.production" });

    importDotenv({ cwd: root, file: ".env.production" });

    expect(readFileSync(join(root, "penv.config.ts"), "utf8")).not.toContain("schemaFile:");
    expect(existsSync(join(root, ".penv", "env.ts"))).toBe(true);
  });

  /** An existing config is the declaration; import scaffolds to what it already says. */
  it("scaffolds to the path an existing config declares", () => {
    const root = makeProject({
      dotenv: "API_KEY=abc\n",
      filename: ".env.production",
      config: { ...CONFIG, schemaFile: "src/lib/env.ts" },
    });

    importDotenv({ cwd: root, file: ".env.production" });

    expect(existsSync(join(root, "src", "lib", "env.ts"))).toBe(true);
    expect(existsSync(join(root, ".penv", "env.ts"))).toBe(false);
  });
});
