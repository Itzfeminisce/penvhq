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
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError } from "@penv/core";
import { afterEach, describe, expect, it } from "vitest";
import { importDotenv } from "./import.js";

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
  writeFileSync(join(root, ".env"), fixture.dotenv, "utf8");
  return root;
}

/** Every file below `.penv/`, so a test can assert the tree is clean. */
function penvTree(root: string): string[] {
  const dir = join(root, ".penv");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];
}

function importFails(root: string): PenvError {
  let thrown: unknown;
  try {
    importDotenv({ cwd: root, file: ".env" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PenvError);
  return thrown as PenvError;
}

afterEach(() => {
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

/*
 * The unscaffolded case — `penv import .env` on a fresh directory — is not
 * covered here. It cannot be: the config `penv init` writes opens with
 * `import { defineConfig } from "penv"`, so loading it needs the `penv` package
 * built, and a fixture project resolves that no better than it resolves zod.
 * `importDotenv` has always had to load the config it scaffolds, so this is a
 * limit of the fixtures rather than of the checks — every check above runs on
 * the config in effect, whether it was found or just written.
 */
