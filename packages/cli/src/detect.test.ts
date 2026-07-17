/**
 * Detection is a suggestion, so the property under test is not "penv gets the
 * framework right" but "penv never claims to know more than package.json says".
 * Every case here is either a fact the manifest states or an `undefined` — the
 * answer that sends `init` to its reported fallback rather than to a guess.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAlias, detectFramework } from "./detect.js";

const created: string[] = [];

interface Fixture {
  /** The manifest's contents. Omit to leave the project without one. */
  readonly manifest?: unknown;
  /** Whether `src/` really exists, which is the only thing that puts the schema in it. */
  readonly src?: boolean;
}

function makeProject(fixture: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "penv-detect-"));
  created.push(root);
  if (fixture.manifest !== undefined) {
    writeFileSync(join(root, "package.json"), JSON.stringify(fixture.manifest), "utf8");
  }
  if (fixture.src === true) {
    mkdirSync(join(root, "src"), { recursive: true });
  }
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the frameworks penv recognises", () => {
  it("reads Next.js and its NEXT_PUBLIC_ prefix", () => {
    const root = makeProject({ manifest: { dependencies: { next: "15.0.0" } }, src: true });

    expect(detectFramework(root)).toEqual({
      name: "Next.js",
      schemaFile: "src/env.ts",
      publicPrefixes: ["NEXT_PUBLIC_"],
    });
  });

  it("reads Vite and its VITE_ prefix", () => {
    const root = makeProject({ manifest: { devDependencies: { vite: "^5" } }, src: true });

    expect(detectFramework(root)).toEqual({
      name: "Vite",
      schemaFile: "src/env.ts",
      publicPrefixes: ["VITE_"],
    });
  });

  it("reads Astro and its PUBLIC_ prefix", () => {
    const root = makeProject({ manifest: { dependencies: { astro: "^4" } } });

    expect(detectFramework(root)).toEqual({
      name: "Astro",
      schemaFile: "env.ts",
      publicPrefixes: ["PUBLIC_"],
    });
  });

  it.each(["@tanstack/react-start", "@tanstack/start"])("reads TanStack Start from %s", (pkg) => {
    const root = makeProject({ manifest: { dependencies: { [pkg]: "^1" } }, src: true });

    expect(detectFramework(root)?.name).toBe("TanStack Start");
    expect(detectFramework(root)?.publicPrefixes).toEqual(["VITE_"]);
  });

  /**
   * A framework's foundation must never answer for the framework. TanStack Start
   * and Next.js both ship Vite in real projects, and answering "Vite" there would
   * declare `VITE_` public in an app that inlines `NEXT_PUBLIC_` — arming the one
   * doctor check that keeps a secret out of a browser bundle against the wrong name.
   */
  it("answers with the framework, not the bundler underneath it", () => {
    const tanstack = makeProject({
      manifest: {
        dependencies: { "@tanstack/react-start": "^1" },
        devDependencies: { vite: "^5" },
      },
    });
    const next = makeProject({
      manifest: { dependencies: { next: "15.0.0" }, devDependencies: { vite: "^5" } },
    });

    expect(detectFramework(tanstack)?.name).toBe("TanStack Start");
    expect(detectFramework(next)?.name).toBe("Next.js");
  });

  it("finds a framework installed as a devDependency", () => {
    const root = makeProject({ manifest: { devDependencies: { next: "15.0.0" } } });

    expect(detectFramework(root)?.name).toBe("Next.js");
  });
});

describe("what penv cannot tell", () => {
  it("says nothing about a project with no package.json", () => {
    expect(detectFramework(makeProject({}))).toBeUndefined();
  });

  it("says nothing about a framework it has no prefix for", () => {
    const root = makeProject({ manifest: { dependencies: { "@remix-run/react": "^2" } } });

    expect(detectFramework(root)).toBeUndefined();
  });

  it("says nothing about a manifest with no dependencies at all", () => {
    expect(detectFramework(makeProject({ manifest: { name: "app" } }))).toBeUndefined();
  });

  /**
   * A broken manifest is "I cannot tell", not a crash: init's fallback is correct
   * and reported, and failing here would fail a command before it had asked the
   * user a single question — over a file it only ever wanted a hint from.
   */
  it("says nothing rather than throwing on an unreadable manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "penv-detect-"));
    created.push(root);
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");

    expect(detectFramework(root)).toBeUndefined();
  });
});

describe("src/", () => {
  /** The layout is a codebase fact. Observing `src/` is fair; assuming it is not. */
  it("puts the schema at the root when there is no src/", () => {
    const root = makeProject({ manifest: { dependencies: { next: "15.0.0" } } });

    expect(detectFramework(root)?.schemaFile).toBe("env.ts");
  });

  it("puts the schema in src/ only when src/ is really there", () => {
    const root = makeProject({ manifest: { dependencies: { next: "15.0.0" } }, src: true });

    expect(detectFramework(root)?.schemaFile).toBe("src/env.ts");
  });
});

/**
 * The two alias forms are resolved by different things, and that is the whole
 * reason to detect rather than default: `@env` is a tsconfig `paths` entry that a
 * bundler resolves and plain Node does not, and `#env` is a package.json
 * `imports` entry Node resolves itself. A project carrying an `imports` block has
 * already answered.
 */
describe("detectAlias", () => {
  it("offers #env to a project that already speaks subpath imports", () => {
    const root = makeProject({ manifest: { name: "app", imports: { "#db": "./src/db.ts" } } });

    expect(detectAlias(root)).toBe("#env");
  });

  it("offers @env to a project that does not", () => {
    expect(
      detectAlias(makeProject({ manifest: { name: "app", dependencies: { next: "15.0.0" } } })),
    ).toBe("@env");
  });

  /** No manifest is not an error: init scaffolds projects that do not exist yet. */
  it("offers @env when there is no manifest to read", () => {
    expect(detectAlias(makeProject({}))).toBe("@env");
  });

  it("offers @env when the manifest is unreadable", () => {
    const root = makeProject({});
    writeFileSync(join(root, "package.json"), "{ not json", "utf8");

    expect(detectAlias(root)).toBe("@env");
  });

  /** An `imports` that is not an object is not an imports block penv can read. */
  it("offers @env when imports is not an object", () => {
    expect(detectAlias(makeProject({ manifest: { name: "app", imports: ["#db"] } }))).toBe("@env");
  });
});
