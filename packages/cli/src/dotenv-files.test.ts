/**
 * Which files are configuration a framework loads, and which only look like it.
 *
 * Both ends of adoption read this: init offers these files and `run` refuses the
 * ones that come back. The two failure directions are not symmetrical — missing
 * a live file leaves a project with two sources of truth, while offering
 * `.env.example` puts documentation into the parameter tree — so both are tested
 * here rather than at either caller.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PenvConfig } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeDotenvFiles,
  cascadeFor,
  discoverDotenvFiles,
  environmentsDeclaredBy,
} from "./dotenv-files.js";

const created: string[] = [];

function makeDir(names: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "penv-dotenv-"));
  created.push(root);
  for (const name of names) {
    writeFileSync(join(root, name), "A=1\n", "utf8");
  }
  return root;
}

const CONFIG: PenvConfig = {
  environments: {
    development: "@penvhq/provider-filesystem",
    production: "@penvhq/provider-filesystem",
  },
};

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("what penv offers to adopt", () => {
  it("reads the four scopes, in one order on every machine", () => {
    const root = makeDir([
      ".env.production",
      ".env.development.local",
      ".env",
      ".env.development",
      ".env.local",
    ]);

    expect(discoverDotenvFiles(root).map((file) => file.name)).toEqual([
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
    ]);
  });

  it("labels each file with what it is", () => {
    const root = makeDir([".env", ".env.local", ".env.production", ".env.production.local"]);

    expect(discoverDotenvFiles(root).map((file) => file.label)).toEqual([
      "shared default",
      "local override",
      "production",
      "production-local",
    ]);
  });

  /** Documentation, leftovers, and filenames penv has no reading of. */
  it("offers nothing that no framework loads", () => {
    const root = makeDir([
      ".env.example",
      ".env.sample",
      ".env.template",
      ".env.backup",
      ".env.local.production",
      ".envrc",
      ".env.a.b.c",
    ]);

    expect(discoverDotenvFiles(root)).toEqual([]);
  });

  it("reads no environment out of a scope marker", () => {
    const root = makeDir([".env.local", ".env.enc"]);

    expect(discoverDotenvFiles(root).map((file) => file.name)).toEqual([".env.local"]);
    expect(environmentsDeclaredBy(discoverDotenvFiles(root))).toEqual([]);
  });

  it("ignores a directory that happens to be named like one", () => {
    const root = makeDir([".env"]);
    mkdirSync(join(root, ".env.development"));

    expect(discoverDotenvFiles(root).map((file) => file.name)).toEqual([".env"]);
  });
});

describe("what a framework actually loads", () => {
  /** Invariant 10: a segment is an environment because the config declares it. */
  it("counts only the environments the config declares", () => {
    const root = makeDir([".env", ".env.local", ".env.production", ".env.staging"]);

    expect(activeDotenvFiles(root, CONFIG).map((file) => file.name)).toEqual([
      ".env",
      ".env.local",
      ".env.production",
    ]);
  });

  it("counts nothing scoped when the whitelist is empty", () => {
    const root = makeDir([".env", ".env.production"]);

    expect(
      activeDotenvFiles(root, { environments: {} }).map((file) => file.name),
    ).toEqual([".env"]);
  });
});

describe("what a selection declares", () => {
  it("takes the environments of the environment-scoped files, sorted", () => {
    const root = makeDir([".env", ".env.local", ".env.production", ".env.development"]);

    expect(environmentsDeclaredBy(discoverDotenvFiles(root))).toEqual([
      "development",
      "production",
    ]);
  });

  /** PRD §6, exactly: selecting `.env` alone declares nothing. */
  it("declares nothing for the two unscoped files", () => {
    const root = makeDir([".env", ".env.local"]);

    expect(environmentsDeclaredBy(discoverDotenvFiles(root))).toEqual([]);
  });
});

describe("the cascade of one environment", () => {
  it("is invariant 4's four levels, most general first", () => {
    expect(cascadeFor("production")).toEqual([
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]);
  });
});
