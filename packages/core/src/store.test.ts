/**
 * `$PENV_HOME` is where every version any project pins ends up, so the first two
 * properties tested here are the ones that keep versions apart and keep an
 * archive from writing outside the store.
 *
 * The third is the one the engine depends on: a store directory is one extracted
 * tarball with no `node_modules` around it, so the package's own `exports` is the
 * only thing that says where its entry is — and whether that entry is something
 * `import()` takes as written, which is the whole difference between a provider
 * that loads and one that fails at the moment it is first needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PenvError } from "./errors.js";
import { isImportableEntry, packageDir, packageEntry, penvHome } from "./store.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-store-"));
  created.push(dir);
  return dir;
}

/** A package directory as the store holds one: a `package.json` and its files. */
function packageAt(manifest: Record<string, unknown>, files: readonly string[] = []): string {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const file of files) {
    const path = join(dir, ...file.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("penvHome", () => {
  it("is ~/.penv unless the environment says otherwise", () => {
    expect(penvHome({})).toBe(join(homedir(), ".penv"));
    expect(penvHome({ PENV_HOME: "" })).toBe(join(homedir(), ".penv"));
  });

  it("takes the declared store, absolute", () => {
    const dir = scratch();

    expect(penvHome({ PENV_HOME: dir })).toBe(dir);
  });
});

describe("packageDir", () => {
  it("addresses a package by exact name and exact version", () => {
    const home = scratch();

    expect(packageDir(home, "engines", "@penvhq/cli", "0.9.0")).toBe(
      join(home, "engines", "@penvhq", "cli", "0.9.0"),
    );
    expect(packageDir(home, "extensions", "provider-consul", "1.4.2")).toBe(
      join(home, "extensions", "provider-consul", "1.4.2"),
    );
  });

  it("refuses a name that resolves outside the store", () => {
    const failure = () => packageDir(scratch(), "engines", "../../evil", "0.9.0");

    expect(failure).toThrow(PenvError);
    expect(failure).toThrow(/outside/);
  });

  /** Inside `$PENV_HOME` is not enough: an engine filed among the extensions is not an engine. */
  it("refuses a name that lands in the other bucket", () => {
    const failure = () => packageDir(scratch(), "engines", "../extensions/evil", "0.9.0");

    expect(failure).toThrow(PenvError);
    expect(failure).toThrow(/outside/);
  });
});

describe("isImportableEntry", () => {
  it("takes what Node's ESM loader takes, and nothing else", () => {
    expect(isImportableEntry("/x/dist/index.js")).toBe(true);
    expect(isImportableEntry("/x/dist/index.mjs")).toBe(true);
    expect(isImportableEntry("/x/dist/index.cjs")).toBe(true);
    expect(isImportableEntry("/x/src/index.ts")).toBe(false);
    expect(isImportableEntry("/x/src/index.tsx")).toBe(false);
    expect(isImportableEntry("/x/README")).toBe(false);
  });
});

describe("packageEntry", () => {
  it("takes the `.` subpath of exports, under the conditions import() sees", () => {
    const dir = packageAt(
      {
        name: "@acme/provider-consul",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/x.cjs" },
        },
      },
      ["dist/index.js"],
    );

    expect(packageEntry(dir)).toEqual({ file: join(dir, "dist", "index.js"), importable: true });
  });

  it("takes a condition map with no subpaths, and a bare string", () => {
    const conditions = packageAt({ exports: { node: "./dist/index.js" } }, ["dist/index.js"]);
    expect(packageEntry(conditions)?.file).toBe(join(conditions, "dist", "index.js"));

    const bare = packageAt({ exports: "./lib/main.js" }, ["lib/main.js"]);
    expect(packageEntry(bare)?.file).toBe(join(bare, "lib", "main.js"));
  });

  it("falls back to main, then to index.js", () => {
    const main = packageAt({ main: "./build/entry.js" }, ["build/entry.js"]);
    expect(packageEntry(main)?.file).toBe(join(main, "build", "entry.js"));

    const neither = packageAt({ name: "x" }, ["index.js"]);
    expect(packageEntry(neither)?.file).toBe(join(neither, "index.js"));
  });

  /** Finding 17's package: it resolves, and penv still cannot import it. */
  it("reports TypeScript source as not importable", () => {
    const dir = packageAt({ exports: { ".": { import: "./src/index.ts" } } }, ["src/index.ts"]);

    expect(packageEntry(dir)).toEqual({ file: join(dir, "src", "index.ts"), importable: false });
  });

  it("reports a declared entry that is not there as not importable", () => {
    const dir = packageAt({ main: "./dist/index.js" });

    expect(packageEntry(dir)?.importable).toBe(false);
  });

  it("answers nothing for a directory with no package.json, or one pointing outside itself", () => {
    expect(packageEntry(scratch())).toBeUndefined();
    expect(packageEntry(packageAt({ main: "../../elsewhere.js" }))).toBeUndefined();
  });
});
