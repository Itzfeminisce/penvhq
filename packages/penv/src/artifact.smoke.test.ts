/**
 * The only test that exercises what a user actually receives.
 *
 * Every other test in this repo resolves `@penvhq/*` to TypeScript source through
 * a Vitest alias, so none of them load a bundle. That gap has already hidden
 * five separate defects that a green suite reported as fine: a declaration build
 * that could not run at all, `import.meta` in the CJS output, a tarball whose
 * `workspace:*` dependencies could not resolve outside the workspace, a
 * CommonJS dependency bundled into ESM that killed `npx penv` on the first line,
 * and a bundled *copy* of `ProviderConfigMap` — under the alias the map is
 * core's, so every type-level test bound; in the tarball it was a second
 * interface with the same name, and every committed provider declaration
 * augmented the one `defineConfig` never read.
 *
 * So this test packs the real tarball, installs it into a throwaway project, and
 * runs the two entry points the documentation leads with. It is slow and it
 * shells out, which is why it is excluded from the default `vitest` run and gated
 * behind `pnpm test:artifact`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");
const coreDir = resolve(packageDir, "..", "core");
const timeout = 300_000;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

/** tsc's verdict and its diagnostics, so a failed compilation can be read. */
function typecheck(config: string, cwd: string): { readonly ok: boolean; readonly out: string } {
  try {
    run("npx", ["tsc", "-p", config], cwd);
    return { ok: true, out: "" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/** Pack the real tarball: `pnpm pack` is what rewrites `workspace:*`. */
function pack(dir: string, destination: string): string {
  const packed = run("pnpm", ["pack", "--pack-destination", destination], dir)
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (packed === undefined) {
    throw new Error(`pnpm pack printed no tarball path for ${dir}`);
  }
  return packed;
}

describe("the published artifact", () => {
  let project: string;

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "penv-artifact-"));

    // Tarballs rather than directory links, so the dependency graph a consumer
    // resolves is the one under test. `@penvhq/core` is packed beside it because
    // it is now a real dependency of this package and the version it declares is
    // this workspace's, which no registry has.
    const packed = [pack(packageDir, project), pack(coreDir, project)];

    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2),
    );
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", ...packed, "zod@4.4.3", "typescript@5.9.3"],
      project,
    );
  }, timeout);

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  /**
   * The premise moved with the packaging: this package declares `@penvhq/core`
   * now, so "no `workspace:*` escapes" is no longer the whole of it. The version
   * that escapes has to be one a resolver can satisfy — changesets rewrites
   * `workspace:*` to an exact version, and the `fixed` group publishes core at
   * that same version, so the sibling in the graph is the one penv asks for.
   */
  it("declares no dependencies a consumer cannot resolve", () => {
    const manifest = run("npm", ["ls", "--json", "--depth", "0"], project);
    const tree = JSON.parse(manifest) as {
      problems?: string[];
      dependencies?: Record<string, { missing?: boolean; version?: string }>;
    };
    const installed: unknown = JSON.parse(
      readFileSync(join(project, "node_modules", "@penvhq", "penv", "package.json"), "utf8"),
    );
    const declared = (installed as { dependencies?: Record<string, string> }).dependencies ?? {};

    expect(tree.problems ?? []).toEqual([]);
    expect(tree.dependencies?.["@penvhq/penv"]?.missing).not.toBe(true);
    expect(declared["@penvhq/core"]).toBe(tree.dependencies?.["@penvhq/core"]?.version);
  });

  /** PRD §3: this package is the typed runtime surface, and the global `penv` is the launcher's. */
  it("ships no command line", () => {
    const installed: unknown = JSON.parse(
      readFileSync(join(project, "node_modules", "@penvhq", "penv", "package.json"), "utf8"),
    );
    expect((installed as { bin?: unknown }).bin).toBeUndefined();
  });

  it('serves `import { load } from "@penvhq/penv"` from the ESM build', () => {
    writeFileSync(
      join(project, "esm.mjs"),
      `import { load, defineConfig } from "@penvhq/penv";
       if (typeof load !== "function") throw new Error("load is not a function");
       if (typeof defineConfig !== "function") throw new Error("defineConfig is not a function");
       console.log("esm-ok");`,
    );

    expect(run("node", ["esm.mjs"], project)).toContain("esm-ok");
  });

  it('serves `require("@penvhq/penv")` from the CJS build', () => {
    // `import.meta` in a CJS bundle throws on load, so this is the guard for it.
    writeFileSync(
      join(project, "cjs.cjs"),
      `const { load, defineConfig } = require("@penvhq/penv");
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
      `import { load } from "@penvhq/penv";
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

    // Any type error fails it, including an unfulfilled @ts-expect-error —
    // which is what fires if `load` degrades to `any`.
    expect(typecheck("tsconfig.json", project).out).toBe("");
  });

  /**
   * Finding 28: the committed declaration `penv add` writes augments
   * `ProviderConfigMap` in module `"@penvhq/core"`, so `defineConfig` has to hold
   * a config against *that* interface. While this package inlined its own copy,
   * the augmentation merged into an interface nothing consulted, and a Vercel
   * target misspelled `"producton"` compiled clean under `--strict`.
   *
   * Three compilations, because only the third separates "bound" from "the map
   * is still empty": a bound entry rejects a field the provider never declared,
   * an empty map accepts anything through the base index signature. The second
   * is the finding's exact typo.
   */
  it("binds a committed provider declaration to the map defineConfig reads", () => {
    writeFileSync(
      join(project, "provider.d.ts"),
      `export {};

       declare module "@penvhq/core" {
         interface ProviderConfigMap {
           "@penvhq/provider-vercel": {
             readonly location: string;
             readonly targets: Readonly<Record<string, "production" | "preview" | "development">>;
             readonly teamId?: string;
           };
         }
       }`,
    );

    const compile = (
      name: string,
      entry: string,
    ): { readonly ok: boolean; readonly out: string } => {
      writeFileSync(
        join(project, `${name}.ts`),
        `import { defineConfig } from "@penvhq/penv";

         export default defineConfig({
           environments: ["production"],
           providers: { production: ${entry} },
         });`,
      );
      writeFileSync(
        join(project, `${name}.tsconfig.json`),
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
            include: [`${name}.ts`, "provider.d.ts"],
          },
          null,
          2,
        ),
      );
      return typecheck(`${name}.tsconfig.json`, project);
    };

    const wellTyped = compile(
      "config-bound",
      `{
         type: "@penvhq/provider-vercel",
         location: "penv-cloud",
         targets: { production: "production" },
       }`,
    );
    expect(wellTyped.out).toBe("");

    const typo = compile(
      "config-typo",
      `{
         type: "@penvhq/provider-vercel",
         location: "penv-cloud",
         targets: { production: "producton" },
       }`,
    );
    expect(typo.ok).toBe(false);
    expect(typo.out).toContain("producton");

    const undeclared = compile(
      "config-undeclared-field",
      `{
         type: "@penvhq/provider-vercel",
         location: "penv-cloud",
         targets: { production: "production" },
         bogusFieldThatDoesNotExist: 123,
       }`,
    );
    expect(undeclared.ok).toBe(false);
    expect(undeclared.out).toContain("not assignable to type 'never'");
  });
});
