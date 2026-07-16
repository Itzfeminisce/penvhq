/**
 * The only test that exercises what a user actually receives.
 *
 * Every other test in this repo resolves `@penv/*` to TypeScript source through
 * a Vitest alias, so none of them load a bundle. That gap has already hidden
 * four separate defects that a green suite reported as fine: a declaration build
 * that could not run at all, `import.meta` in the CJS output, a tarball whose
 * `workspace:*` dependencies could not resolve outside the workspace, and a
 * CommonJS dependency bundled into ESM that killed `npx penv` on the first line.
 *
 * So this test packs the real tarball, installs it into a throwaway project, and
 * runs the two entry points the documentation leads with. It is slow and it
 * shells out, which is why it is excluded from the default `vitest` run and gated
 * behind `pnpm test:artifact`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");
const timeout = 300_000;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

describe("the published artifact", () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "penv-artifact-"));

    // Pack the real tarball rather than a directory link: `pnpm pack` is what
    // rewrites `workspace:*`, so only a tarball proves the dependency graph a
    // consumer resolves is satisfiable.
    const packed = run("pnpm", ["pack", "--pack-destination", project], packageDir)
      .trim()
      .split(/\r?\n/)
      .at(-1);
    if (packed === undefined) {
      throw new Error("pnpm pack printed no tarball path");
    }

    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2),
    );
    run("npm", ["install", "--no-audit", "--no-fund", packed, "zod@4.4.3"], project);
  }, timeout);

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("declares no dependencies a consumer cannot resolve", () => {
    const manifest = run("npm", ["ls", "--json", "--depth", "0"], project);
    const tree = JSON.parse(manifest) as {
      problems?: string[];
      dependencies?: Record<string, { missing?: boolean }>;
    };

    expect(tree.problems ?? []).toEqual([]);
    expect(tree.dependencies?.penv?.missing).not.toBe(true);
  });

  it("runs `npx penv` — the bin the quickstart leads with", () => {
    // A CJS dependency bundled into the ESM output makes this throw
    // `Dynamic require of "os" is not supported` before printing anything.
    const help = run("npx", ["penv", "--help"], project);

    expect(help).toContain("penv");
    for (const command of ["init", "import", "generate", "get", "set", "validate", "doctor"]) {
      expect(help).toContain(command);
    }
  });

  it('serves `import { load } from "penv"` from the ESM build', () => {
    writeFileSync(
      join(project, "esm.mjs"),
      `import { load, defineConfig } from "penv";
       if (typeof load !== "function") throw new Error("load is not a function");
       if (typeof defineConfig !== "function") throw new Error("defineConfig is not a function");
       console.log("esm-ok");`,
    );

    expect(run("node", ["esm.mjs"], project)).toContain("esm-ok");
  });

  it('serves `require("penv")` from the CJS build', () => {
    // `import.meta` in a CJS bundle throws on load, so this is the guard for it.
    writeFileSync(
      join(project, "cjs.cjs"),
      `const { load, defineConfig } = require("penv");
       if (typeof load !== "function") throw new Error("load is not a function");
       if (typeof defineConfig !== "function") throw new Error("defineConfig is not a function");
       console.log("cjs-ok");`,
    );

    expect(run("node", ["cjs.cjs"], project)).toContain("cjs-ok");
  });

  it("ships types that keep load generic — invariant 3, through the bundler", () => {
    // rollup-plugin-dts inlines the types; a bad `resolve` config silently
    // degrades the signature or leaves it pointing at a package that is not
    // installed. Either way `z.infer<T>` stops being what a consumer sees.
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "ES2022",
            skipLibCheck: true,
          },
          include: ["types.ts"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(project, "types.ts"),
      `import { load } from "penv";
       import { z } from "zod";
       const schema = z.object({ databaseUrl: z.string(), port: z.number() });
       const env = load(schema);
       const url: string = env.databaseUrl;
       const port: number = env.port;
       // @ts-expect-error the schema has no such key
       env.notInSchema;
       // @ts-expect-error databaseUrl is a string, not a number
       const wrong: number = env.databaseUrl;
       void url; void port; void wrong;`,
    );

    run("npm", ["install", "--no-audit", "--no-fund", "typescript@5.9.3"], project);
    // Throws on any type error, including an unfulfilled @ts-expect-error —
    // which is what fires if `load` degrades to `any`.
    expect(() => run("npx", ["tsc", "-p", "tsconfig.json"], project)).not.toThrow();
  });
});
