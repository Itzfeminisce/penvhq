/**
 * `penv init` scaffolds; it does not own what it scaffolded. The two properties
 * under test are that `.penv/env.ts` is written exactly once (invariant 2) and
 * that the `@env` alias lands in the user's `tsconfig.json` without taking the
 * rest of the file with it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InitResult, InitTarget } from "./init.js";
import { insertEnvAlias, runInit } from "./init.js";

const created: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-init-"));
  created.push(dir);
  return dir;
}

function stepFor(result: InitResult, target: InitTarget) {
  const step = result.steps.find((candidate) => candidate.target === target);
  if (step === undefined) {
    throw new Error(`init reported no step for ${target}`);
  }
  return step;
}

function read(root: string, ...path: string[]): string {
  return readFileSync(join(root, ...path), "utf8");
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scaffolding", () => {
  it("writes the tree, the schema, the config, the alias, and the ignore file", () => {
    const root = makeDir();

    const result = runInit({ cwd: root });

    expect(result.steps.map((step) => step.target)).toEqual([
      "penv-dir",
      "schema",
      "config",
      "tsconfig",
      "gitignore",
    ]);
    expect(existsSync(join(root, ".penv"))).toBe(true);
    expect(read(root, ".penv", "env.ts")).toContain("export const schema = z.object({");
    expect(read(root, ".penv", "env.ts")).toContain("export const env = load(schema);");
    expect(read(root, "penv.config.ts")).toContain("environments:");
    expect(read(root, "tsconfig.json")).toContain('"@env": [".penv/env.ts"]');
  });

  /** Invariant 17: a value file that is not ignored is a secret waiting to be committed. */
  it("ignores value files but keeps env.ts, meta, and structure committable", () => {
    const root = makeDir();

    runInit({ cwd: root });
    const ignore = read(root, ".penv", ".gitignore");

    expect(ignore).toContain("*\n");
    expect(ignore).toContain("!env.ts");
    expect(ignore).toContain("!*.json");
    expect(ignore).toContain("!*/");
  });

  it("is safe to re-run", () => {
    const root = makeDir();

    runInit({ cwd: root });
    const second = runInit({ cwd: root });

    expect(stepFor(second, "penv-dir").action).toBe("kept");
    expect(stepFor(second, "schema").action).toBe("kept");
    expect(stepFor(second, "config").action).toBe("kept");
    expect(stepFor(second, "tsconfig").action).toBe("kept");
    expect(stepFor(second, "gitignore").action).toBe("kept");
    // One alias, not two: re-running must not append a second entry.
    expect(read(root, "tsconfig.json").match(/"@env"/g)).toHaveLength(1);
  });
});

describe("env.ts", () => {
  /**
   * Invariant 2: penv scaffolds `.penv/env.ts` once and never regenerates it. A
   * generated type is a second representation that drifts from the schema — the
   * exact disease penv treats — so an existing file is the user's, always.
   */
  it("does not overwrite an existing .penv/env.ts", () => {
    const root = makeDir();
    const mine = "export const schema = 'mine, hand-written, and quite wrong';\n";
    mkdirSync(join(root, ".penv"), { recursive: true });
    writeFileSync(join(root, ".penv", "env.ts"), mine, "utf8");

    const result = runInit({ cwd: root });

    expect(read(root, ".penv", "env.ts")).toBe(mine);
    expect(stepFor(result, "schema").action).toBe("kept");
  });

  it("says so rather than failing when it keeps one", () => {
    const root = makeDir();
    mkdirSync(join(root, ".penv"), { recursive: true });
    writeFileSync(join(root, ".penv", "env.ts"), "// mine\n", "utf8");

    const result = runInit({ cwd: root });

    expect(stepFor(result, "schema").text).toContain("Kept .penv/env.ts");
    expect(stepFor(result, "schema").note).toContain("never regenerates it");
    // The run carries on: the alias is still written.
    expect(read(root, "tsconfig.json")).toContain('"@env"');
  });
});

describe("the @env alias", () => {
  it("adds the alias without destroying the rest of tsconfig.json", () => {
    const root = makeDir();
    const original = `{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "paths": {
      "@app/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
`;
    writeFileSync(join(root, "tsconfig.json"), original, "utf8");

    const result = runInit({ cwd: root });
    const updated: unknown = JSON.parse(read(root, "tsconfig.json"));

    expect(stepFor(result, "tsconfig").action).toBe("updated");
    expect(updated).toEqual({
      compilerOptions: {
        target: "ES2022",
        strict: true,
        paths: { "@env": [".penv/env.ts"], "@app/*": ["./src/*"] },
      },
      include: ["src/**/*.ts"],
    });
  });

  /** A tsconfig is JSONC in practice. Reformatting it away is not a minimal edit. */
  it("keeps comments and formatting", () => {
    const source = `{
  // The compiler options we argued about for a week.
  "compilerOptions": {
    /* block */
    "strict": true
  }
}
`;

    const edited = insertEnvAlias(source);

    expect(edited.changed).toBe(true);
    expect(edited.source).toContain("// The compiler options we argued about for a week.");
    expect(edited.source).toContain("/* block */");
    expect(edited.source).toContain('"strict": true');
    expect(edited.source).toContain('"paths": { "@env": [".penv/env.ts"] }');
  });

  it("creates the paths block when compilerOptions has none", () => {
    const edited = insertEnvAlias('{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n');

    expect(JSON.parse(edited.source)).toEqual({
      compilerOptions: { strict: true, paths: { "@env": [".penv/env.ts"] } },
    });
  });

  it("creates compilerOptions when the file has none", () => {
    const edited = insertEnvAlias('{\n  "include": ["src"]\n}\n');

    expect(JSON.parse(edited.source)).toEqual({
      include: ["src"],
      compilerOptions: { paths: { "@env": [".penv/env.ts"] } },
    });
  });

  it("fills an empty compilerOptions rather than leaving it open", () => {
    const edited = insertEnvAlias('{\n  "compilerOptions": {}\n}\n');

    expect(JSON.parse(edited.source)).toEqual({
      compilerOptions: { paths: { "@env": [".penv/env.ts"] } },
    });
  });

  it("leaves an already-aliased file alone", () => {
    const source = '{\n  "compilerOptions": { "paths": { "@env": [".penv/env.ts"] } }\n}\n';

    const edited = insertEnvAlias(source);

    expect(edited.changed).toBe(false);
    expect(edited.source).toBe(source);
  });

  it("refuses a tsconfig whose paths is not an object, naming the fix", () => {
    expect(() => insertEnvAlias('{ "compilerOptions": { "paths": "nope" } }')).toThrow(
      /compilerOptions.paths` is not an object/,
    );
  });
});
