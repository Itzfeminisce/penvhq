/**
 * `penv init` scaffolds; it does not own what it scaffolded. The properties
 * under test are that the schema module is written exactly once wherever it
 * lives (invariant 2), that the `@env` alias lands in the user's
 * `tsconfig.json` without taking the rest of the file with it, and that init
 * writes down only decisions — never an environment nobody declared (invariant
 * 10). The prompting is tested through a fake terminal: the decision is a plain
 * function, so no test here needs a TTY to exist.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InitDecisions, InitPlan, InitResult, InitTarget, PromptIo } from "./init.js";
import {
  DEFAULT_DECISIONS,
  environmentsFromFlag,
  insertEnvAlias,
  planInit,
  promptForDecisions,
  renderConfigModule,
  renderInit,
  runInit,
  suggestEnvironments,
} from "./init.js";

const created: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-init-"));
  created.push(dir);
  return dir;
}

/** A project that says what it is, so detection has something true to read. */
function makeProject(manifest: unknown, options: { src?: boolean } = {}): string {
  const root = makeDir();
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest), "utf8");
  if (options.src === true) {
    mkdirSync(join(root, "src"), { recursive: true });
  }
  return root;
}

const NEXT = { dependencies: { next: "15.0.0" } };

/** A terminal that answers what it was told to and remembers what it was shown. */
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

function planFor(root: string): InitPlan {
  return planInit(root);
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

  /**
   * The alias is how the user's code reaches penv, so an `@env` that resolves
   * anywhere else is not a smaller problem than a missing one: the import
   * compiles, runs, and hands back another module's export.
   *
   * penv reported `Kept the @env path alias` for this, because it asked whether
   * the *key* was there rather than where it pointed — a silent seam, in the
   * scaffolder of the tool whose whole subject is silent seams.
   */
  describe("when the project already maps @env somewhere else", () => {
    const foreign =
      '{\n  "compilerOptions": {\n    "paths": { "@env": ["./src/legacy-env.ts"] }\n  }\n}\n';

    it("reports the conflict rather than reporting success", () => {
      const edited = insertEnvAlias(foreign, "src/env.ts");

      expect(edited.changed).toBe(false);
      expect(edited.conflict).toBe('["./src/legacy-env.ts"]');
    });

    /** The file is the user's, and penv cannot tell a stale mapping from a deliberate one. */
    it("leaves their mapping exactly as it found it", () => {
      expect(insertEnvAlias(foreign, "src/env.ts").source).toBe(foreign);
    });

    /** The negative: an alias already pointing at the schema is agreement, not conflict. */
    it("stays quiet when the alias already points at the schema", () => {
      const edited = insertEnvAlias(foreign, "./src/legacy-env.ts");

      expect(edited.changed).toBe(false);
      expect(edited.conflict).toBeUndefined();
    });

    it("reports it as a warning step rather than a ✓", () => {
      const root = makeProject({ name: "app" });
      writeFileSync(join(root, "tsconfig.json"), foreign, "utf8");

      const result = runInit({ cwd: root });
      const step = result.steps.find((s) => s.target === "tsconfig");

      expect(step?.action).toBe("conflicted");
      expect(step?.text).toContain("already maps @env");
      expect(renderInit(result).join("\n")).toContain("⚠");
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

  /** The alias is the only thing that knows where the schema is; moving one moves both. */
  it("points at the schema wherever it was put", () => {
    const root = makeProject(NEXT, { src: true });

    runInit({ cwd: root, decisions: planFor(root).decisions });

    expect(read(root, "tsconfig.json")).toContain('"@env": ["src/env.ts"]');
  });

  it("points an existing tsconfig at the chosen schema too", () => {
    const root = makeProject(NEXT, { src: true });
    writeFileSync(join(root, "tsconfig.json"), '{\n  "compilerOptions": {}\n}\n', "utf8");

    runInit({ cwd: root, decisions: planFor(root).decisions });

    expect(JSON.parse(read(root, "tsconfig.json"))).toEqual({
      compilerOptions: { paths: { "@env": ["src/env.ts"] } },
    });
  });
});

describe("environments", () => {
  /**
   * The bug this fixes: init used to write `["development", "staging", "production"]`,
   * so every project began by declaring infrastructure it had never been asked
   * about — a real one carried a fictional `staging` for months. Invariant 10
   * says an environment exists because it is declared, and penv cannot declare
   * one on your behalf without inventing it.
   */
  it("declares none by default, because penv cannot see your infrastructure", () => {
    const root = makeDir();

    const result = runInit({ cwd: root });
    const config = read(root, "penv.config.ts");

    expect(result.decisions.environments).toEqual([]);
    expect(config).toContain("environments: [],");
    expect(config).toContain("providers: {},");
    expect(config).not.toContain("staging");
  });

  /** `--yes` trusts penv's reading of the codebase. Infrastructure is not in the codebase. */
  it("still declares none when the detected defaults are taken unasked", () => {
    const root = makeProject(NEXT, { src: true });

    const plan = planFor(root);

    expect(plan.decisions.environments).toEqual([]);
    expect(plan.decisions.schemaFile).toBe("src/env.ts");
  });

  /** An empty whitelist is a decision penv made for the user, so it is explained on the spot. */
  it("says in the config why the whitelist is empty and what fills it", () => {
    const config = renderConfigModule({
      environments: [],
      schemaFile: ".penv/env.ts",
      publicPrefixes: [],
      alias: "@env",
    });

    expect(config).toContain("never infers one");
    expect(config).toContain('environments: ["development", "production"],');
    expect(config).toContain("environments: [],");
  });

  it("gives every declared environment a provider to read from", () => {
    const config = renderConfigModule({
      environments: ["development", "production"],
      schemaFile: ".penv/env.ts",
      publicPrefixes: [],
      alias: "@env",
    });

    expect(config).toContain('environments: ["development", "production"],');
    expect(config).toContain('"development": { type: "filesystem" },');
    expect(config).toContain('"production": { type: "filesystem" },');
  });

  it("declares what --env names, however it was written", () => {
    expect(environmentsFromFlag(["development", "production"])).toEqual([
      "development",
      "production",
    ]);
    expect(environmentsFromFlag("development,production")).toEqual(["development", "production"]);
    expect(environmentsFromFlag(undefined)).toBeUndefined();
  });

  /** Present-but-blank is refused, never normalized into "no answer". */
  it("refuses --env with no name rather than reading it as none", () => {
    expect(() => environmentsFromFlag("")).toThrow(/`--env` was given without a value/);
  });
});

describe("the environments the .env files are evidence for", () => {
  /**
   * Suggestion is not inference: nothing here reaches the config unless a human
   * reads it and presses Enter. The test is that penv offers what the project
   * already wrote down, and offers nothing it would have had to invent.
   */
  it("reads the environments out of the .env files on disk", () => {
    const root = makeDir();
    for (const file of [".env", ".env.production", ".env.development.local", ".env.local"]) {
      writeFileSync(join(root, file), "", "utf8");
    }

    expect(suggestEnvironments(root)).toEqual(["development", "production"]);
  });

  /** `.env.example` is documentation and `local` is a scope. Neither is an environment. */
  it("suggests nothing from a filename that names no environment", () => {
    const root = makeDir();
    for (const file of [".env.example", ".env.local", ".env.sample", ".envrc"]) {
      writeFileSync(join(root, file), "", "utf8");
    }

    expect(suggestEnvironments(root)).toEqual([]);
  });

  it("suggests nothing when there are no .env files at all", () => {
    expect(suggestEnvironments(makeDir())).toEqual([]);
    expect(planFor(makeDir()).suggestedEnvironments).toEqual([]);
  });
});

describe("the plan", () => {
  it("carries what was detected and what it implies", () => {
    const root = makeProject(NEXT, { src: true });

    const plan = planFor(root);

    expect(plan.detected?.name).toBe("Next.js");
    expect(plan.decisions.schemaFile).toBe("src/env.ts");
    expect(plan.decisions.publicPrefixes).toEqual(["NEXT_PUBLIC_"]);
    expect(plan.notes.join("\n")).toContain("Detected Next.js");
  });

  /** Invariant 13's habit: a fallback penv takes without saying so is a guess. */
  it("reports the fallback rather than taking it silently", () => {
    const plan = planFor(makeDir());

    expect(plan.detected).toBeUndefined();
    expect(plan.decisions.schemaFile).toBe(".penv/env.ts");
    expect(plan.notes.join("\n")).toContain("No framework detected");
    expect(plan.notes.join("\n")).toContain("No environments declared");
  });

  it("takes --schema over what it detected", () => {
    const root = makeProject(NEXT, { src: true });

    expect(planInit(root, { schema: "app/config/env.ts" }).decisions.schemaFile).toBe(
      "app/config/env.ts",
    );
  });

  /** The config is committed, so a path only its author's machine can read is refused now. */
  it("refuses a --schema the config could not carry, before anything is written", () => {
    const root = makeDir();

    expect(() => planInit(root, { schema: "/etc/env.ts" })).toThrow(/absolute path/);
    expect(() => planInit(root, { schema: "../shared/env.ts" })).toThrow(/outside the project/);
    expect(() => planInit(root, { schema: "" })).toThrow(/`--schema` was given without a value/);
  });
});

describe("the prompt", () => {
  it("shows one screen and takes the suggested environments on Enter", async () => {
    const root = makeProject(NEXT, { src: true });
    writeFileSync(join(root, ".env.production"), "", "utf8");
    const io = fakeTerminal(["", "y"]);

    const decisions = await promptForDecisions(planFor(root), io);

    expect(io.shown.join("\n")).toContain("Detected Next.js.");
    expect(io.shown.join("\n")).toContain("[production]");
    expect(decisions).toEqual({
      environments: ["production"],
      schemaFile: "src/env.ts",
      publicPrefixes: ["NEXT_PUBLIC_"],
      alias: "@env",
    });
  });

  /** Enter with nothing suggested is a valid answer: an empty whitelist, declared. */
  it("takes an empty answer as an empty whitelist", async () => {
    const decisions = await promptForDecisions(planFor(makeDir()), fakeTerminal(["", ""]));

    expect(decisions?.environments).toEqual([]);
  });

  it("takes the environments the human types over the ones penv suggested", async () => {
    const root = makeDir();
    writeFileSync(join(root, ".env.production"), "", "utf8");

    const decisions = await promptForDecisions(planFor(root), fakeTerminal(["dev, prod", "y"]));

    expect(decisions?.environments).toEqual(["dev", "prod"]);
  });

  it("lets the human refuse a suggestion outright", async () => {
    const root = makeDir();
    writeFileSync(join(root, ".env.production"), "", "utf8");

    const decisions = await promptForDecisions(planFor(root), fakeTerminal(["none", "y"]));

    expect(decisions?.environments).toEqual([]);
  });

  /**
   * Declining is an outcome, not a failure. The two mistakes are not symmetrical:
   * a decline costs a re-run, while reading "n" as consent scaffolds a project
   * into a repository whose owner said no.
   */
  it("writes nothing when the plan is declined", async () => {
    const root = makeProject(NEXT, { src: true });

    const decisions = await promptForDecisions(planFor(root), fakeTerminal(["", "n"]));

    expect(decisions).toBeUndefined();
    expect(existsSync(join(root, "penv.config.ts"))).toBe(false);
    expect(existsSync(join(root, ".penv"))).toBe(false);
  });

  it("declines an answer it cannot read as consent", async () => {
    const root = makeProject(NEXT, { src: true });

    expect(
      await promptForDecisions(planFor(root), fakeTerminal(["", "maybe later"])),
    ).toBeUndefined();
  });
});

describe("the schema's home", () => {
  const CUSTOM: InitDecisions = {
    environments: [],
    schemaFile: "src/config/env.ts",
    publicPrefixes: [],
    alias: "@env",
  };

  it("writes the schema where the decisions say, creating the directories for it", () => {
    const root = makeDir();

    const result = runInit({ cwd: root, decisions: CUSTOM });

    expect(read(root, "src", "config", "env.ts")).toContain("export const env = load(schema);");
    expect(existsSync(join(root, ".penv", "env.ts"))).toBe(false);
    expect(stepFor(result, "schema").text).toContain("Generated src/config/env.ts");
  });

  /** Invariant 2 is about the file, not about the path penv would have chosen for it. */
  it("keeps an existing schema at a custom path", () => {
    const root = makeDir();
    const mine = "export const schema = 'mine, hand-written, and quite wrong';\n";
    mkdirSync(join(root, "src", "config"), { recursive: true });
    writeFileSync(join(root, "src", "config", "env.ts"), mine, "utf8");

    const result = runInit({ cwd: root, decisions: CUSTOM });

    expect(read(root, "src", "config", "env.ts")).toBe(mine);
    expect(stepFor(result, "schema").action).toBe("kept");
    expect(stepFor(result, "schema").text).toContain("Kept src/config/env.ts");
  });

  it("records the schema's home in the config only when it is not the default", () => {
    const custom = renderConfigModule(CUSTOM);
    const standard = renderConfigModule({
      environments: [],
      schemaFile: ".penv/env.ts",
      publicPrefixes: [],
      alias: "@env",
    });

    expect(custom).toContain('schemaFile: "src/config/env.ts",');
    expect(standard).not.toContain("schemaFile:");
  });

  /**
   * The un-ignore names the schema by name, so outside the tree it names nothing:
   * a `!env.ts` matching no file is a line the next reader has to prove is dead
   * before they can leave it alone.
   */
  it("drops the schema's un-ignore line when the schema is not in .penv/", () => {
    const root = makeDir();

    runInit({ cwd: root, decisions: CUSTOM });
    const ignore = read(root, ".penv", ".gitignore");

    expect(ignore).not.toContain("!env.ts");
    // Invariant 17 is untouched: values are still ignored, structure still committed.
    expect(ignore).toContain("*\n");
    expect(ignore).toContain("!*/");
    expect(ignore).toContain("!*.json");
  });
});

describe("publicPrefixes", () => {
  /** penv holds the policy (`secret: true`) and the name; only it can see the collision. */
  it("records the prefixes a framework inlines into the browser", () => {
    const root = makeProject(NEXT, { src: true });

    runInit({ cwd: root, decisions: planFor(root).decisions });

    expect(read(root, "penv.config.ts")).toContain('publicPrefixes: ["NEXT_PUBLIC_"],');
    // The alias is not a config key: it lives in the file that resolves it —
    // tsconfig `paths` or package.json `imports` — and a copy here would be a
    // second authority on one fact.
    expect(read(root, "penv.config.ts")).not.toContain("alias:");
  });

  it("writes no prefixes when no framework was detected", () => {
    const root = makeDir();

    runInit({ cwd: root });

    expect(read(root, "penv.config.ts")).not.toContain("publicPrefixes");
  });
});

/**
 * `#env` is not a style preference. `@env` is a tsconfig `paths` entry, which
 * TypeScript understands and a bundler resolves — and which plain `node
 * dist/index.js` does not, because `paths` is erased by the compiler. `#env` is
 * a package.json `imports` entry Node resolves itself. A project that already
 * carries an `imports` block has answered the question, so init offers its answer.
 */
describe("the alias form", () => {
  it("writes #env into package.json for a project that speaks subpath imports", () => {
    const root = makeProject({ name: "app", imports: { "#db": "./src/db.ts" } });

    const result = runInit({ cwd: root });

    expect(result.decisions.alias).toBe("#env");
    expect(JSON.parse(read(root, "package.json"))).toEqual({
      name: "app",
      imports: { "#env": "./.penv/env.ts", "#db": "./src/db.ts" },
    });
    // And nothing was written to the tsconfig: one alias, in the file that resolves it.
    expect(existsSync(join(root, "tsconfig.json"))).toBe(false);
  });

  it("writes @env into tsconfig for a project that does not", () => {
    const root = makeProject(NEXT);

    const result = runInit({ cwd: root });

    expect(result.decisions.alias).toBe("@env");
    expect(read(root, "tsconfig.json")).toContain('"@env"');
  });

  it("takes --alias over what it detected", () => {
    const root = makeProject({ name: "app", imports: { "#db": "./src/db.ts" } });

    const plan = planInit(root, { alias: "@env" });

    expect(plan.decisions.alias).toBe("@env");
  });

  it("refuses an alias that is neither form", () => {
    const root = makeProject({ name: "app" });

    expect(() => planInit(root, { alias: "env" })).toThrow(/not an alias penv can write/);
    expect(() => planInit(root, { alias: "" })).toThrow(/without a value/);
  });

  /** The same conflict rule as the tsconfig: the key being there is not the question. */
  it("reports a conflicting #env rather than reporting success", () => {
    const root = makeProject({ name: "app", imports: { "#env": "./src/legacy.ts" } });

    const step = stepFor(runInit({ cwd: root }), "tsconfig");

    expect(step.action).toBe("conflicted");
    expect(step.text).toContain("already maps #env");
  });

  /** Re-running is idempotent through the manifest, which is where the alias lives. */
  it("keeps an #env that already points at the schema", () => {
    const root = makeProject({ name: "app", imports: { "#db": "./src/db.ts" } });

    runInit({ cwd: root });
    const second = stepFor(runInit({ cwd: root }), "tsconfig");

    expect(second.action).toBe("kept");
    expect(read(root, "package.json").match(/#env/g)).toHaveLength(1);
  });

  /** `imports` is a key on a manifest that exists; penv does not invent one. */
  it("refuses to invent a package.json for #env", () => {
    const root = makeDir();

    const step = stepFor(
      runInit({ cwd: root, decisions: { ...DEFAULT_DECISIONS, alias: "#env" } }),
      "tsconfig",
    );

    expect(step.action).toBe("conflicted");
    expect(step.note).toContain("--alias @env");
  });
});

/**
 * The note explains why penv chose what it chose, so it must not explain a choice
 * penv did not make. It fired on the alias's *form* rather than on where the
 * alias came from, and told a project whose manifest said `{"name":"svc"}` that
 * its own `imports` block had asked for `#env`.
 */
describe("the alias note", () => {
  it("explains a detected #env", () => {
    const root = makeProject({ name: "app", imports: { "#db": "./src/db.ts" } });

    expect(planInit(root).notes.join("\n")).toContain("declares `imports`");
  });

  it("claims nothing about the manifest when --alias forced it", () => {
    const root = makeProject({ name: "svc" });

    const plan = planInit(root, { alias: "#env" });

    expect(plan.decisions.alias).toBe("#env");
    expect(plan.notes.join("\n")).not.toContain("declares `imports`");
  });
});
