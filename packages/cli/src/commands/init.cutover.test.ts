/**
 * `penv init` as the all-or-nothing dotenv cutover.
 *
 * The acceptance bar is friction item 9, and it is the first describe below: for
 * every shape of project penv adopts, the very next `penv run` starts a real
 * child process against the drafted schema with **zero edits** to it. A newcomer
 * whose reward for adopting penv is a Zod error in a file they did not write has
 * been charged for the abstraction at the exact moment they were deciding
 * whether to keep it.
 *
 * The install is the one step that reaches outside the repository, so it is a
 * seam here and nothing in this file spawns a package manager. What it fakes is
 * exactly what a real install does — the dependency in `package.json` and the
 * package in `node_modules` — because the run that follows has to resolve
 * `@penvhq/penv` the way a user's project would.
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
import { CUTOVER_PATH, ROLLBACK_DOTENV_PATH } from "@penvhq/core";
import { runCommand as runCittyCommand } from "citty";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanup, runUndo } from "../cutover.js";
import type { DotenvFile } from "../dotenv-files.js";
import type { InstallPlan, InstallRuntime } from "../install.js";
import { engineVersion } from "../install.js";
import { renderCleanup } from "./cleanup.js";
import type { CutoverResult, PromptIo } from "./init.js";
import {
  applyCutover,
  askEnvironment,
  initCommand,
  planAdoption,
  planCutover,
  planInit,
  promptForSelection,
  renderCutoverPlan,
  selectionForYes,
} from "./init.js";
import { runRun } from "./run.js";

/**
 * Fixture projects live under the workspace's `node_modules` so a scaffolded
 * `penv.schema.ts` resolves `import { z } from "zod"` by walking up, exactly as
 * a real project resolves it.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

/** A version that is nobody's release, so nothing here depends on the engine's own. */
const VERSION = "9.9.9";

const created: string[] = [];
const originalCwd = process.cwd();

interface Fixture {
  /** Dotenv files, by name. */
  readonly files: Readonly<Record<string, string>>;
  readonly manifest?: unknown;
  /** Written before the cutover, as a project that already installed the runtime would have it. */
  readonly installed?: boolean;
}

const MANIFEST = { name: "app", private: true, scripts: { dev: "vite" } };

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "cutover-"));
  created.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(fixture.manifest ?? MANIFEST), "utf8");
  for (const [name, contents] of Object.entries(fixture.files)) {
    writeFileSync(join(root, name), contents, "utf8");
  }
  if (fixture.installed === true) {
    installRuntime(root, VERSION);
  }
  return root;
}

/**
 * What a real `pnpm add @penvhq/penv` leaves behind: the exact pin in
 * `package.json`, and a package the project's own module resolution finds. The
 * scaffolded `.penv/env.ts` imports `load` from it and `penv.config.ts` imports
 * `defineConfig`, so without this the cutover's own validation could not read
 * the schema it just drafted.
 */
function installRuntime(root: string, version: string): void {
  const dir = join(root, "node_modules", "@penvhq", "penv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@penvhq/penv",
      version,
      type: "module",
      main: "index.js",
      exports: { ".": "./index.js" },
    }),
    "utf8",
  );
  // `load` is never called for its value here: `penv run` builds the child
  // environment itself, and the schema harvest defers the loader anyway.
  writeFileSync(
    join(dir, "index.js"),
    "export const defineConfig = (config) => config;\nexport const load = () => ({});\n",
    "utf8",
  );
  const manifestFile = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  manifest.dependencies = { "@penvhq/penv": version };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
}

function installer(): { readonly seam: InstallRuntime; readonly plans: InstallPlan[] } {
  const plans: InstallPlan[] = [];
  return {
    plans,
    seam: (plan) => {
      plans.push(plan);
      installRuntime(plan.root, plan.version);
      return Promise.resolve();
    },
  };
}

interface CutoverOptions {
  /** The filenames to adopt. Defaults to what init preselects — the development cascade. */
  readonly selected?: readonly string[];
  readonly environment?: string;
  readonly install?: InstallRuntime;
}

function selectionOf(root: string, names: readonly string[] | undefined): DotenvFile[] {
  const adoption = planAdoption(root);
  const wanted = names ?? adoption.preselected;
  return adoption.found.filter((file) => wanted.includes(file.name));
}

function planFor(root: string, options: CutoverOptions = {}) {
  return planCutover({
    root,
    base: planInit(root),
    selected: selectionOf(root, options.selected),
    version: VERSION,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
}

function cutover(root: string, options: CutoverOptions = {}): Promise<CutoverResult> {
  return applyCutover(planFor(root, options), { install: options.install ?? installer().seam });
}

interface Refusal {
  readonly code: string;
  /** The refusal itself. `PenvError` folds the remedy into `message`; this is the first line. */
  readonly says: string;
  readonly remedy?: string;
}

function refusalFrom(work: () => unknown): Refusal {
  try {
    work();
  } catch (error) {
    const failure = error as { code: string; message: string; remedy?: string };
    return {
      code: failure.code,
      says: failure.message.split("\n")[0] ?? "",
      ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }),
    };
  }
  throw new Error("expected penv init to refuse");
}

async function asyncRefusalFrom(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; remedy?: string }> {
  return promise.then(
    () => {
      throw new Error("expected penv init to refuse");
    },
    (error: { code: string; message: string; remedy?: string }) => error,
  );
}

/** A child that exits 0 only when every named variable carries the expected value. */
function assertingChild(expected: Readonly<Record<string, string>>): string[] {
  const script = Object.entries(expected)
    .map(
      ([name, value]) =>
        `if (process.env[${JSON.stringify(name)}] !== ${JSON.stringify(value)}) { console.error(${JSON.stringify(name)}, process.env[${JSON.stringify(name)}]); process.exit(3); }`,
    )
    .join("");
  return [process.execPath, "-e", script];
}

/** The real command, with no ambient environment behind it. */
function run(root: string, environment: string, expected: Readonly<Record<string, string>>) {
  return runRun({
    cwd: root,
    environment,
    command: assertingChild(expected),
    host: { PATH: process.env.PATH ?? "" },
  });
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Friction item 9, sealed as an acceptance criterion: the first run after a
 * successful cutover passes with zero edits to `penv.schema.ts`, for every
 * adoption fixture.
 */
describe("the first run after a cutover", () => {
  interface Adoption {
    readonly name: string;
    readonly fixture: Fixture;
    readonly options?: CutoverOptions;
    readonly environment: string;
    readonly expects: Readonly<Record<string, string>>;
  }

  const ADOPTIONS: readonly Adoption[] = [
    {
      name: "a Next-style development cascade",
      fixture: {
        manifest: { name: "app", dependencies: { next: "15.0.0" }, scripts: { dev: "next dev" } },
        files: {
          ".env": "DATABASE_URL=postgres://localhost/app\nAPI_TIMEOUT=30\n",
          ".env.local": "API_KEY=from-my-machine\n",
          ".env.development": "NEXT_PUBLIC_URL=http://localhost:3000\n",
          ".env.development.local": "DATABASE_URL=postgres://localhost/app_dev\n",
        },
      },
      environment: "development",
      expects: {
        // The cascade decides, unchanged: `.env.development.local` beats `.env`.
        DATABASE_URL: "postgres://localhost/app_dev",
        API_TIMEOUT: "30",
        API_KEY: "from-my-machine",
        NEXT_PUBLIC_URL: "http://localhost:3000",
      },
    },
    {
      name: "a bare .env, with the environment named",
      fixture: { files: { ".env": "DATABASE_URL=postgres://localhost/app\nPORT=3000\n" } },
      options: { environment: "development" },
      environment: "development",
      expects: { DATABASE_URL: "postgres://localhost/app", PORT: "3000" },
    },
    {
      name: "multiple environments leaning on a shared .env",
      fixture: {
        files: {
          ".env": "DATABASE_URL=postgres://localhost/app\n",
          ".env.development": "DEBUG=true\n",
          ".env.production": "SENTRY_DSN=https://key@sentry.io/1\n",
        },
      },
      options: { selected: [".env", ".env.development", ".env.production"] },
      environment: "development",
      // SENTRY_DSN is production's alone, so the draft made it optional and
      // development starts without it.
      expects: { DATABASE_URL: "postgres://localhost/app", DEBUG: "true" },
    },
    {
      name: "a project that already installed the runtime",
      fixture: {
        installed: true,
        files: {
          ".env": "DATABASE_URL=postgres://localhost/app\n",
          ".env.development": "DEBUG=true\n",
        },
      },
      environment: "development",
      expects: { DATABASE_URL: "postgres://localhost/app", DEBUG: "true" },
    },
  ];

  for (const adoption of ADOPTIONS) {
    it(`starts a real child with the drafted schema unedited: ${adoption.name}`, async () => {
      const root = makeProject(adoption.fixture);
      const schemaBefore = await cutover(root, adoption.options ?? {}).then(() =>
        readFileSync(join(root, "penv.schema.ts"), "utf8"),
      );

      const result = await run(root, adoption.environment, adoption.expects);

      expect(result.exitCode).toBe(0);
      // Nothing edited the schema between the cutover and the run — the whole point.
      expect(readFileSync(join(root, "penv.schema.ts"), "utf8")).toBe(schemaBefore);
    });
  }

  /** `--yes` is the other adoption path, and it takes the same bar. */
  it("starts a real child after `--yes` took the development cascade", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    const adoption = planAdoption(root);

    await applyCutover(
      planCutover({
        root,
        base: planInit(root),
        selected: selectionForYes(adoption),
        environment: "development",
        version: VERSION,
      }),
      { install: installer().seam },
    );

    await expect(
      run(root, "development", { DATABASE_URL: "postgres://localhost/app", DEBUG: "true" }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("what the cutover writes", () => {
  const CASCADE: Fixture = {
    files: {
      ".env": "DATABASE_URL=postgres://localhost/app\n",
      ".env.local": "API_KEY=mine\n",
      ".env.development": "DEBUG=true\n",
    },
  };

  it("declares the environments the selected files name, and nothing else", async () => {
    const root = makeProject(CASCADE);

    const result = await cutover(root);
    const config = readFileSync(join(root, "penv.config.ts"), "utf8");

    expect(result.plan.environments).toEqual(["development"]);
    expect(config).toContain('environments: ["development"],');
    expect(config).not.toContain("production");
    expect(config).not.toContain("staging");
  });

  /** Seal 3: what makes `penv run -- pnpm dev` the daily form. */
  it("writes defaultEnvironment when it adopted the development cascade", async () => {
    const root = makeProject(CASCADE);

    await cutover(root);

    expect(readFileSync(join(root, "penv.config.ts"), "utf8")).toContain(
      'defaultEnvironment: "development",',
    );
  });

  /** The values land at the scope the filename named — invariant 4, unchanged. */
  it("writes each file's values at its own scope", async () => {
    const root = makeProject(CASCADE);

    await cutover(root);
    const records = join(root, ".penv", "state", "records");

    expect(readFileSync(join(records, "database-url"), "utf8").trim()).toBe(
      "postgres://localhost/app",
    );
    expect(readFileSync(join(records, "api-key.local"), "utf8").trim()).toBe("mine");
    expect(readFileSync(join(records, "debug.development"), "utf8").trim()).toBe("true");
  });

  it("moves every adopted file into the rollback bundle and records it", async () => {
    const root = makeProject(CASCADE);

    const result = await cutover(root);

    expect(result.moved).toEqual([".env", ".env.local", ".env.development"]);
    for (const name of result.moved) {
      expect(existsSync(join(root, name))).toBe(false);
      expect(existsSync(join(root, ...ROLLBACK_DOTENV_PATH.split("/"), name))).toBe(true);
    }
    const cutoverState = JSON.parse(readFileSync(join(root, ...CUTOVER_PATH.split("/")), "utf8"));
    expect(cutoverState).toMatchObject({ format: 1, files: result.moved });
  });

  /** Invariant 20: the bundle holds plaintext values, and the state names one machine's bundle. */
  it("ignores the bundle and the cutover state", async () => {
    const root = makeProject(CASCADE);

    await cutover(root);
    const ignore = readFileSync(join(root, ".penv", "state", ".gitignore"), "utf8");

    expect(ignore).toContain("rollback/");
    expect(ignore).toContain("/cutover.json");
  });

  it("installs the exact runtime version with the project's own package manager", async () => {
    const root = makeProject(CASCADE);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const install = installer();

    await cutover(root, { install: install.seam });

    expect(install.plans).toHaveLength(1);
    expect(install.plans[0]?.command).toEqual([
      "pnpm",
      "add",
      "--save-exact",
      `@penvhq/penv@${VERSION}`,
    ]);
    expect(install.plans[0]?.lockfile).toBe("pnpm-lock.yaml");
  });

  /** Seal 1 as amended: the wrapper stays outside, and init shows the line rather than writing it. */
  it("never edits package.json scripts, and shows the daily command instead", async () => {
    const root = makeProject(CASCADE);

    const result = await cutover(root);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    expect(manifest.scripts).toEqual({ dev: "vite" });
    const { renderCutover } = await import("./init.js");
    expect(renderCutover(result).join("\n")).toContain("penv run -- npm dev");
  });

  /** No keys, no sealing, no artifacts, no provider auth — PRD §6's closing paragraph. */
  it("creates no key, seals nothing, and writes no artifact", async () => {
    const root = makeProject(CASCADE);

    await cutover(root);
    const records = readdirSync(join(root, ".penv", "state", "records"));

    expect(records.every((name) => !name.endsWith(".enc"))).toBe(true);
    expect(existsSync(join(root, "penv.snapshot.ts"))).toBe(false);
    expect(readFileSync(join(root, "penv.config.ts"), "utf8")).not.toContain("keys:");
  });
});

describe("the draft schema", () => {
  it("requires what every adopted environment has and makes the rest optional", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
        ".env.production": "SENTRY_DSN=https://key@sentry.io/1\n",
      },
    });

    const plan = planFor(root, { selected: [".env", ".env.development", ".env.production"] });
    const shape = plan.fields.map((field) => `${field.key}: ${field.type}`);

    expect(shape).toContain("databaseUrl: z.url()");
    expect(shape).toContain("debug: z.stringbool().optional()");
    expect(shape).toContain("sentryDsn: z.url().optional()");
  });

  /** Never per-environment requiredness: one schema, and the weakest shape all of them satisfy. */
  it("writes one schema, with no environment named in it", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.production": "DEBUG=true\n",
      },
    });

    await cutover(root, { selected: [".env", ".env.production"] });
    const shape = readFileSync(join(root, "penv.schema.ts"), "utf8");

    expect(shape).toContain("DRAFT");
    expect(shape).not.toContain("production");
    expect(shape).not.toContain("development");
  });
});

describe("the preflight", () => {
  /** PRD §6: every framework-discoverable file in an adopted cascade comes too. */
  it("refuses a selection that leaves a file of the same cascade behind", () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });

    const error = refusalFrom(() => planFor(root, { selected: [".env.development"] }));

    expect(error.code).toBe("INIT_CUTOVER_INCOMPLETE");
    expect(error.says).toBe(
      ".env is part of development's cascade and was not selected, so your framework would keep reading it beside penv",
    );
    expect(error.remedy).toBe(
      "Run `penv init` again and take every file penv listed for that environment. Nothing was changed.",
    );
  });

  it("changes nothing at all when it refuses", () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });

    refusalFrom(() => planFor(root, { selected: [".env.development"] }));

    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, ".penv"))).toBe(false);
    expect(existsSync(join(root, "penv.config.ts"))).toBe(false);
    expect(existsSync(join(root, "penv.schema.ts"))).toBe(false);
  });

  /** Invariant 11, before a single value file exists. */
  it("refuses a reserved variable name", () => {
    const root = makeProject({ files: { ".env": "ENC=nope\n" } });

    const error = refusalFrom(() => planFor(root, { environment: "development" }));

    expect(error.code).toBe("RESERVED_TOKEN");
  });

  /**
   * The v0.1 gate, across a cutover: `MY-VAR` becomes the parameter `my-var`,
   * which regenerates as `MY_VAR`, so the application would read `undefined`.
   */
  it("refuses a variable name the round trip would rename", () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "MY-VAR=two\n",
      },
    });

    const error = refusalFrom(() => planFor(root));

    expect(error.code).toBe("IMPORT_LOSSY_NAME");
    expect(error.says).toContain("MY-VAR");
  });

  /**
   * The negative case for the same check: one parameter written at four scopes
   * is the cascade, not a collision. This is what `.env` plus
   * `.env.development.local` looks like, and refusing it would refuse the most
   * ordinary project there is.
   */
  it("stays quiet when one variable appears in several files of one cascade", () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DATABASE_URL=postgres://localhost/dev\n",
        ".env.development.local": "DATABASE_URL=postgres://localhost/mine\n",
      },
    });

    expect(planFor(root).fields.map((field) => field.key)).toEqual(["databaseUrl"]);
  });

  /** `.env` alone declares nothing (PRD §6), and penv will not choose for it. */
  it("refuses to invent an environment for a bare .env", () => {
    const root = makeProject({ files: { ".env": "DATABASE_URL=postgres://localhost/app\n" } });

    const error = refusalFrom(() => planFor(root));

    expect(error.code).toBe("INIT_ENVIRONMENT_UNNAMED");
    expect(error.remedy).toBe(
      "Run `penv init --env development` to say which environment these values are for.",
    );
  });

  /** Guess once, declare forever: an existing whitelist is the project's answer. */
  it("refuses to adopt an environment the existing config does not declare", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    await cutover(root);
    runCleanup({ cwd: root });
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://localhost/app\n", "utf8");
    writeFileSync(join(root, ".env.production"), "SENTRY_DSN=https://key@sentry.io/1\n", "utf8");

    const error = refusalFrom(() => planFor(root, { selected: [".env", ".env.production"] }));

    expect(error.code).toBe("INIT_ENVIRONMENT_UNDECLARED");
    expect(error.remedy).toBe(
      "Add `production` to `environments` in penv.config.ts, with a provider for it, then run `penv init` again. Nothing was changed.",
    );
  });
});

describe("`--yes`", () => {
  /** PRD §6: it never decides what happens to another environment's fallback. */
  it("refuses when another environment leans on the shared .env", () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
        ".env.production": "SENTRY_DSN=https://key@sentry.io/1\n",
      },
    });

    const error = refusalFrom(() => selectionForYes(planAdoption(root)));

    expect(error.code).toBe("INIT_YES_SHARED_FALLBACK");
    expect(error.says).toBe(
      ".env.production falls back to the shared .env this cutover would move, so `--yes` will not decide what happens to production",
    );
    expect(error.remedy).toBe(
      "Run `penv init` without `--yes` and choose every file the cutover takes. Nothing was changed.",
    );
  });

  it("changes nothing when it refuses", () => {
    const root = makeProject({
      files: { ".env": "A=1\n", ".env.production": "B=2\n" },
    });

    refusalFrom(() => selectionForYes(planAdoption(root)));

    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, ".penv"))).toBe(false);
  });

  /** The negative case: with no other environment in sight, `--yes` takes the cascade. */
  it("takes the development cascade when nothing else is leaning on it", () => {
    const root = makeProject({
      files: {
        ".env": "A=1\n",
        ".env.local": "B=2\n",
        ".env.development": "C=3\n",
        ".env.example": "A=\n",
      },
    });

    const selected = selectionForYes(planAdoption(root)).map((file) => file.name);

    // `.env.example` is documentation and was never on the list.
    expect(selected).toEqual([".env", ".env.local", ".env.development"]);
  });
});

describe("undo", () => {
  const FIXTURE: Fixture = {
    files: {
      ".env": "DATABASE_URL=postgres://localhost/app\n",
      ".env.development.local": "DEBUG=true\n",
      ".env.development": "PORT=3000\n",
    },
  };

  it("restores every file under its exact name", async () => {
    const root = makeProject(FIXTURE);
    const before = Object.fromEntries(
      Object.keys(FIXTURE.files).map((name) => [name, readFileSync(join(root, name), "utf8")]),
    );
    await cutover(root);

    const result = runUndo({ cwd: root });

    expect([...result.restored].sort()).toEqual(Object.keys(FIXTURE.files).sort());
    for (const [name, contents] of Object.entries(before)) {
      expect(readFileSync(join(root, name), "utf8")).toBe(contents);
    }
    expect(existsSync(join(root, ...CUTOVER_PATH.split("/")))).toBe(false);
    expect(existsSync(join(root, ...ROLLBACK_DOTENV_PATH.split("/")))).toBe(false);
  });

  /** The records are the project's now; undo is recovery for the migration, not for the adoption. */
  it("leaves what penv scaffolded exactly where it is", async () => {
    const root = makeProject(FIXTURE);
    await cutover(root);
    const schema = readFileSync(join(root, "penv.schema.ts"), "utf8");

    runUndo({ cwd: root });

    expect(readFileSync(join(root, "penv.schema.ts"), "utf8")).toBe(schema);
    expect(existsSync(join(root, ".penv", "state", "records", "database-url"))).toBe(true);
  });

  it("refuses rather than writing over a file that came back", async () => {
    const root = makeProject(FIXTURE);
    await cutover(root);
    writeFileSync(join(root, ".env"), "DATABASE_URL=something-newer\n", "utf8");

    const error = refusalFrom(() => runUndo({ cwd: root }));

    expect(error.code).toBe("INIT_UNDO_OCCUPIED");
    expect(error.remedy).toBe(
      "Move .env out of the way, or run `penv cleanup` to keep it and drop the bundle. Nothing was restored.",
    );
    // Nothing was restored: the other two are still in the bundle.
    expect(existsSync(join(root, ".env.development"))).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("DATABASE_URL=something-newer\n");
  });

  it("refuses when there is no cutover to undo", () => {
    const root = makeProject({ files: {} });

    const error = refusalFrom(() => runUndo({ cwd: root }));

    expect(error.code).toBe("INIT_UNDO_NOTHING");
    expect(error.remedy).toBe(
      "Run `penv init` to adopt your dotenv files; undo puts them back afterwards.",
    );
  });
});

describe("cleanup", () => {
  it("removes the bundle and only the bundle", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    await cutover(root);

    const result = runCleanup({ cwd: root });

    expect(result.removed).toEqual([".env", ".env.development"]);
    expect(existsSync(join(root, ...CUTOVER_PATH.split("/")))).toBe(false);
    expect(existsSync(join(root, ".penv", "state", "rollback"))).toBe(false);
    // Everything else the cutover produced is untouched.
    expect(existsSync(join(root, ".penv", "state", "records", "database-url"))).toBe(true);
    expect(existsSync(join(root, ".penv", "state", "records", "debug.development"))).toBe(true);
    expect(existsSync(join(root, "penv.schema.ts"))).toBe(true);
    expect(existsSync(join(root, "penv.config.ts"))).toBe(true);
  });

  it("says so, rather than failing, when there is nothing to clean up", () => {
    const root = makeProject({ files: {} });

    const result = runCleanup({ cwd: root });

    expect(result).toMatchObject({ cleaned: false, removed: [] });
    expect(renderCleanup(result).join("\n")).toContain("No dotenv rollback bundle to clean up.");
  });
});

/**
 * The command itself, for the two things only it decides: which positional it
 * takes, and that a run with nobody to ask migrates nothing. A script that
 * migrated a project by accident is the one failure a cutover cannot undo for
 * someone who did not know it had happened.
 */
describe("the command", () => {
  async function runInitCommand(root: string, rawArgs: readonly string[]): Promise<number> {
    process.chdir(root);
    process.exitCode = 0;
    try {
      await runCittyCommand(initCommand, { rawArgs: [...rawArgs] });
      return process.exitCode ?? 0;
    } finally {
      process.chdir(originalCwd);
      process.exitCode = 0;
    }
  }

  it("restores the last cutover on `penv init undo`", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    await cutover(root);

    expect(await runInitCommand(root, ["undo"])).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, ".env.development"))).toBe(true);
  });

  it("refuses a positional it does not have", async () => {
    const root = makeProject({ files: {} });

    expect(await runInitCommand(root, ["redo"])).toBe(1);
  });

  /** No terminal, no `--yes`: the plan is printed and not one file moves. */
  it("migrates nothing when there is nobody to ask", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });

    expect(await runInitCommand(root, [])).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, ".penv"))).toBe(false);
    expect(existsSync(join(root, "penv.config.ts"))).toBe(false);
  });
});

describe("a second migration", () => {
  const FIXTURE: Fixture = {
    files: {
      ".env": "DATABASE_URL=postgres://localhost/app\n",
      ".env.development": "DEBUG=true\n",
    },
  };

  it("refuses while the first rollback bundle is unresolved", async () => {
    const root = makeProject(FIXTURE);
    await cutover(root);
    writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://localhost/app\n", "utf8");

    const error = refusalFrom(() => planFor(root, { selected: [".env"] }));

    expect(error.code).toBe("INIT_BUNDLE_UNRESOLVED");
    expect(error.says).toBe(
      "The dotenv files from the last cutover are still in .penv/state/rollback/dotenv/, and penv will not migrate a second time over them",
    );
    expect(error.remedy).toBe(
      "Run `penv cleanup` to drop that bundle once you are happy with the migration.",
    );
  });

  /** The negative case: once the bundle is resolved, a second cutover is ordinary work. */
  it("proceeds once the bundle is cleaned up", async () => {
    const root = makeProject(FIXTURE);
    await cutover(root);
    runCleanup({ cwd: root });
    writeFileSync(join(root, ".env.development"), "DEBUG=true\nEXTRA=1\n", "utf8");

    const result = await cutover(root, { selected: [".env.development"] });

    expect(result.moved).toEqual([".env.development"]);
  });
});

/**
 * One screen at a time, and the io is a parameter — so the conversation is a
 * plain function and no test here needs a terminal to exist.
 */
describe("the conversation", () => {
  function fakeTerminal(answers: readonly string[]): PromptIo & { readonly shown: string[] } {
    const queue = [...answers];
    const shown: string[] = [];
    return {
      shown,
      ask: (question: string) => {
        shown.push(question);
        return Promise.resolve(queue.shift() ?? "");
      },
      write: (line: string) => {
        shown.push(line);
      },
    };
  }

  const CASCADE: Fixture = {
    files: {
      ".env": "A=1\n",
      ".env.local": "B=2\n",
      ".env.development": "C=3\n",
      ".env.production": "D=4\n",
    },
  };

  it("shows every file, with the development cascade checked", async () => {
    const root = makeProject(CASCADE);
    const io = fakeTerminal([""]);

    const selected = await promptForSelection(planAdoption(root), io);
    const screen = io.shown.join("\n");

    expect(screen).toMatch(/\[x]\s+\.env\s+shared default/);
    expect(screen).toMatch(/\[x]\s+\.env\.development\s+development/);
    expect(screen).toMatch(/\[ ]\s+\.env\.production\s+production/);
    expect(selected?.map((file) => file.name)).toEqual([".env", ".env.local", ".env.development"]);
  });

  it("takes the files the developer names instead", async () => {
    const root = makeProject(CASCADE);

    const selected = await promptForSelection(
      planAdoption(root),
      fakeTerminal([".env, .env.production"]),
    );

    expect(selected?.map((file) => file.name)).toEqual([".env", ".env.production"]);
  });

  it("takes all of them on `all`", async () => {
    const root = makeProject(CASCADE);

    const selected = await promptForSelection(planAdoption(root), fakeTerminal(["all"]));

    expect(selected).toHaveLength(4);
  });

  /** Declining is an outcome, not a failure: nothing is written and the run says so. */
  it("declines on `none`", async () => {
    const root = makeProject(CASCADE);

    expect(await promptForSelection(planAdoption(root), fakeTerminal(["none"]))).toBeUndefined();
  });

  it("refuses a name that is not on the list", async () => {
    const root = makeProject(CASCADE);

    await expect(
      promptForSelection(planAdoption(root), fakeTerminal([".env.staging"])),
    ).rejects.toMatchObject({
      code: "INIT_SELECTION_UNKNOWN",
      remedy:
        "Run `penv init` again and name the files exactly as they are listed, e.g. `.env.production`.",
    });
  });

  it("offers development for a selection that declares no environment", async () => {
    const io = fakeTerminal([""]);

    expect(await askEnvironment(io, "development")).toBe("development");
    expect(io.shown.join("\n")).toContain("declares no environment");
  });

  it("takes the environment the developer types", async () => {
    expect(await askEnvironment(fakeTerminal(["staging"]), "development")).toBe("staging");
  });

  /** The plan screen is the consent: everything it names has still to happen. */
  it("shows the environments, the draft and the exact install before asking", () => {
    const root = makeProject(CASCADE);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const screen = renderCutoverPlan(
      planFor(root, { selected: [".env", ".env.local", ".env.development"] }),
    ).join("\n");

    expect(screen).toContain("[development]");
    expect(screen).toContain("3 parameters");
    expect(screen).toContain('"@penvhq/penv": "9.9.9"');
    expect(screen).toContain("pnpm-lock.yaml");
    expect(screen).toContain(".penv/state/rollback/dotenv/");
  });
});

/**
 * Adopting one more file into a project that already declared more environments
 * than this cutover touches. The environment it did not touch is not judged by
 * it: refusing here would fail a migration for a state the project was already
 * in, and the files would stay put for a reason the reader cannot act on.
 */
describe("a cutover narrower than the whitelist", () => {
  it("validates what it adopted, not every environment the config declares", async () => {
    const root = makeProject({ files: { ".env.development": "DEBUG=true\n" } });
    await cutover(root);
    runCleanup({ cwd: root });
    // production is declared and has no values at all — nothing this cutover did.
    writeFileSync(
      join(root, "penv.config.ts"),
      `export default ${JSON.stringify({
        environments: ["development", "production"],
        providers: {
          development: { type: "@penvhq/provider-filesystem" },
          production: { type: "@penvhq/provider-filesystem" },
        },
        defaultEnvironment: "development",
      })};\n`,
      "utf8",
    );
    writeFileSync(join(root, ".env.local"), "EXTRA=1\n", "utf8");

    const result = await cutover(root, { selected: [".env.local"], environment: "development" });

    expect(result.plan.environments).toEqual(["development", "production"]);
    expect(result.validated).toEqual(["development"]);
    expect(result.moved).toEqual([".env.local"]);
  });
});

describe("the install", () => {
  it("performs no cutover when the install fails", async () => {
    const root = makeProject({
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    const plan = planFor(root);

    await asyncRefusalFrom(
      applyCutover(plan, {
        install: () => Promise.reject(new Error("the registry is down")),
      }),
    );

    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, ".env.development"))).toBe(true);
    expect(existsSync(join(root, ".penv"))).toBe(false);
    expect(existsSync(join(root, ...CUTOVER_PATH.split("/")))).toBe(false);
  });

  it("installs nothing when package.json already pins the exact version", async () => {
    const root = makeProject({
      installed: true,
      files: {
        ".env": "DATABASE_URL=postgres://localhost/app\n",
        ".env.development": "DEBUG=true\n",
      },
    });
    const install = installer();

    const result = await cutover(root, { install: install.seam });

    expect(install.plans).toEqual([]);
    expect(result.plan.install.satisfied).toBe(true);
  });

  it("pins the engine's own version by default", () => {
    const root = makeProject({ files: { ".env": "A=1\n" } });

    const plan = planCutover({
      root,
      base: planInit(root),
      selected: selectionOf(root, undefined),
      environment: "development",
    });

    expect(plan.install.version).toBe(engineVersion());
  });
});
