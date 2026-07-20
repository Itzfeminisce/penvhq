/**
 * `penv init` — scaffold a project.
 *
 * Every step is idempotent, and two of them are write-once on purpose: the
 * schema module is yours the moment it exists (invariant 2 — penv scaffolds it,
 * never regenerates it), and `penv.config.ts` is the environment whitelist you
 * declared. Re-running init reports what it kept rather than overwriting it.
 *
 * What init writes is a set of decisions, and the two kinds are kept apart. penv
 * may default what it can *observe* — the framework in `package.json`, whether
 * `src/` exists — because a wrong guess about the codebase is visible in the
 * codebase. It must ask for what it cannot observe: which environments exist is
 * deployment topology, it is nowhere on disk, and a project that carries a
 * `staging` penv invented is a project whose config is fiction (invariant 10).
 * So `environments` starts empty, and `--yes` cannot fill it: `--yes` means "I
 * trust your defaults for what you can see", never "invent my infrastructure".
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_SCHEMA_FILE,
  isLegalEnvironmentName,
  loadConfigFrom,
  type PenvConfig,
  PenvError,
  RESERVED_TOKENS,
  schemaFileOf,
  schemaInsideTree,
  validateSchemaFile,
} from "@penvhq/core";
import { defineCommand } from "citty";
import { DEFAULT_ALIAS, type Detected, detectAlias, detectFramework } from "../detect.js";
import { type Seam, seamFor } from "../seams.js";
import { out } from "../style.js";
import { CHECK, columns, formatSteps, guard, prompt, type Step, tip, WARN, write } from "../ui.js";

export const SCHEMA_FILE = "env.ts";
export const CONFIG_FILE = "penv.config.ts";
export const TSCONFIG_FILE = "tsconfig.json";
export const GITIGNORE_FILE = ".gitignore";
export const PENV_DIR = ".penv";

/**
 * The alias forms penv can write, and the only two a specifier can take that is
 * not a package: `@name` resolves through tsconfig `paths`, `#name` through
 * package.json `imports`.
 */
const ALIAS_NAME = /^[@#][A-Za-z0-9_-]+$/;

/** The prefix that means Node resolves the alias itself, with no bundler involved. */
const IMPORTS_PREFIX = "#";

const PACKAGE_FILE = "package.json";

/** What init touched, so a caller can report it and a test can assert it. */
export type InitTarget = "penv-dir" | "schema" | "config" | "tsconfig" | "gitignore" | "seam";
/**
 * `conflicted` is the one that is not a success. penv wanted to write something,
 * found the user's file already saying something else about the same thing, and
 * left it alone — so the step is reported with a warning rather than a ✓, and the
 * text says what will not work until the user decides.
 *
 * `info` is a step penv did not perform automatically — a manual instruction (the
 * injection seam for a framework penv cannot scaffold), reported so the user
 * knows the one thing left to do.
 */
export type InitAction = "created" | "kept" | "updated" | "conflicted" | "info";

export interface InitStep {
  readonly target: InitTarget;
  readonly action: InitAction;
  /** The reported line, in the docs' voice. */
  readonly text: string;
  readonly note?: string;
}

/**
 * The answers init writes down. Every one of these is a decision a human either
 * made or consented to — never an identity penv recorded to reinterpret later.
 * There is deliberately no `framework` here: `schemaFile` and `publicPrefixes`
 * still mean exactly what they say after the project is rewritten in something
 * else, and `framework: "next"` would not.
 */
export interface InitDecisions {
  /** The whitelist. Empty unless a human named them — penv never infers one. */
  readonly environments: readonly string[];
  /** The schema module, relative to the project root, POSIX. */
  readonly schemaFile: string;
  /** The prefixes the framework inlines into its client bundle. */
  readonly publicPrefixes: readonly string[];
  /**
   * How the user's code names the schema module — `@env` or `#env`.
   *
   * Two forms, resolved by two different things: `@env` is a tsconfig `paths`
   * entry that a bundler resolves and plain Node does not, and `#env` is a
   * package.json `imports` entry that Node resolves itself. Which one a project
   * wants is a fact about the project, so penv reads what it already does and
   * offers that.
   */
  readonly alias: string;
  /**
   * Whether to inject the validated config into `process.env` for libraries that
   * read it directly, so `env.ts` loads with `{ inject: true }` and penv places
   * the framework's pre-app seam. Off by default and only ever turned on by an
   * explicit yes — a project that reads config only through `@env` gets none.
   */
  readonly inject: boolean;
}

/** What init would write with no further input: the defaults, and nothing invented. */
export const DEFAULT_DECISIONS: InitDecisions = {
  environments: [],
  inject: false,
  schemaFile: DEFAULT_SCHEMA_FILE,
  publicPrefixes: [],
  alias: DEFAULT_ALIAS,
};

export interface InitResult {
  readonly root: string;
  readonly decisions: InitDecisions;
  readonly steps: readonly InitStep[];
}

export interface InitOptions {
  readonly cwd: string;
  /** What to write. Omitted means the plan's defaults, as `--yes` takes them. */
  readonly decisions?: InitDecisions;
}

/*
 * The plan: what penv observed, what it would write, and why.
 */

/** Flags that decide without asking, so a script never meets a prompt. */
export interface InitFlags {
  /** `--schema <path>`. */
  readonly schema?: string;
  /** `--env`, already split. Absent means no answer; present means the answer. */
  readonly environments?: readonly string[];
  /** `--alias <name>`. */
  readonly alias?: string;
}

export interface InitPlan {
  readonly detected: Detected | undefined;
  /** What init writes unless a human edits it. */
  readonly decisions: InitDecisions;
  /** Environments the `.env*` files on disk are evidence for. Offered, never taken. */
  readonly suggestedEnvironments: readonly string[];
  /** Why each decision is what it is. Printed — a fallback penv takes silently is a guess. */
  readonly notes: readonly string[];
}

/**
 * Names that look like an environment in a `.env` filename but are not one:
 * `.env.example` is documentation, and the grammar's reserved tokens are
 * scope markers. Suggesting either would put a name into the whitelist that no
 * value file can ever be scoped to.
 */
const NOT_ENVIRONMENTS: readonly string[] = [...RESERVED_TOKENS, "example", "sample", "template"];

/**
 * The environments the project's own `.env*` files are evidence for.
 *
 * This is not inference: nothing here reaches `penv.config.ts` unless a human
 * reads the suggestion and presses Enter. Invariant 10 is about what penv
 * *declares*, and showing someone the filenames they wrote is not a declaration
 * — it is the difference between "you seem to have a production" and penv
 * quietly deciding that you do.
 */
export function suggestEnvironments(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const found = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(".env.")) {
      continue;
    }
    const segments = entry.slice(".env.".length).split(".");
    // `.env.production.local` is production's file; `.env.local` names no
    // environment at all, and neither does anything with more segments left
    // over, which is a filename penv has no reading of.
    const withoutLocal = segments.at(-1) === "local" ? segments.slice(0, -1) : segments;
    const name = withoutLocal.length === 1 ? withoutLocal[0] : undefined;
    if (name === undefined || !isLegalEnvironmentName(name) || NOT_ENVIRONMENTS.includes(name)) {
      continue;
    }
    found.add(name);
  }
  // Sorted so the same project shows the same line on every machine: directory
  // order is the filesystem's answer, not the project's.
  return [...found].sort();
}

/** A flag that is present but says nothing is refused, never read as absent. */
function emptyFlag(flag: "schema" | "env" | "alias"): PenvError {
  return new PenvError(
    "INIT_FLAG_EMPTY",
    `\`--${flag}\` was given without a value`,
    flag === "schema"
      ? "Name the module that exports the schema, e.g. `--schema src/env.ts`, or drop the flag " +
          `to use ${DEFAULT_SCHEMA_FILE}.`
      : "Name the environment, e.g. `--env production`, or drop the flag to leave the whitelist " +
          "empty and declare it in penv.config.ts.",
  );
}

/** One list of environment names, however it was written. */
function splitEnvironments(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * `--env` as the whitelist it declares, or `undefined` when it was not given —
 * which is no answer, not an empty one. Repeatable and comma-separated both
 * work: `--env development --env production` and `--env development,production`
 * are the same answer, and a shell that made one of them awkward is not a reason
 * to have declared a different set of environments.
 */
export function environmentsFromFlag(flag: unknown): readonly string[] | undefined {
  if (flag === undefined) {
    return undefined;
  }
  const given = Array.isArray(flag) ? (flag as readonly unknown[]) : [flag];
  const names = given.flatMap((value) => splitEnvironments(String(value)));
  if (names.length === 0) {
    throw emptyFlag("env");
  }
  return [...new Set(names)];
}

/** The config the decisions describe, so core answers questions about it, not init. */
function configOf(decisions: InitDecisions): PenvConfig {
  return { environments: decisions.environments, providers: {}, schemaFile: decisions.schemaFile };
}

/**
 * The decisions this project already recorded, or `undefined` when it has none.
 *
 * Only the config init itself would write or keep — the one beside `root`, not
 * whatever `findConfigFile` turns up two directories above. A monorepo's root
 * config is not this package's declaration, and `writeConfigFile` has always
 * looked exactly here.
 *
 * A config that exists and cannot be read is an error rather than an absence.
 * Treating it as absent is how the re-run bug worked in the first place: penv
 * would decide the project had declared nothing, re-detect, and scaffold a
 * second schema beside the one already there.
 */
function declaredIn(root: string): PenvConfig | undefined {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    return undefined;
  }
  return loadConfigFrom(file);
}

/**
 * What penv observed and what it proposes to write. The notes are the point as
 * much as the decisions are: a project that ends up with `.penv/env.ts` because
 * detection failed must be told that detection failed, or the fallback is
 * indistinguishable from a choice penv made on their behalf.
 *
 * Precedence is the whole design in one list: a flag is the human deciding now, a
 * config is the human having decided already, and detection is a suggestion that
 * loses to both. Guess once, declare forever — so once `penv.config.ts` exists,
 * re-detection cannot move what it says. Re-running init on a project that
 * declared `src/lib/env.ts` used to scaffold a *second* schema at the detected
 * path, warn that its own correct alias pointed at the wrong file, and announce
 * that a project with `environments: ["production"]` had declared none.
 */
export function planInit(root: string, flags: InitFlags = {}): InitPlan {
  const declared = declaredIn(root);
  const detected = detectFramework(root);
  const notes: string[] = [];

  if (declared !== undefined) {
    notes.push(`${CONFIG_FILE} already exists — init keeps every decision it records.`);
  } else if (detected === undefined) {
    notes.push(
      `No framework detected in package.json — the schema goes to ${DEFAULT_SCHEMA_FILE}.`,
    );
  } else {
    notes.push(`Detected ${detected.name}.`);
    if (detected.displacedFrom !== undefined) {
      notes.push(
        `${detected.displacedFrom} is already a module of yours that exports no \`schema\`, so ` +
          `the schema goes to ${detected.schemaFile}. penv never writes over a file it did not ` +
          `write — delete yours and re-run if you want it there, or pass \`--schema\`.`,
      );
    }
  }

  // Flag, then what the project already declared, then detection. `schemaFileOf`
  // rather than `config.schemaFile`: a config that omits the key has still
  // answered — with the default — and re-detection must not move a schema that
  // is already sitting where the project says it is.
  const schemaFile =
    flags.schema === undefined
      ? declared !== undefined
        ? schemaFileOf(declared)
        : (detected?.schemaFile ?? DEFAULT_SCHEMA_FILE)
      : flags.schema.trim();
  if (flags.schema !== undefined) {
    if (schemaFile.length === 0) {
      throw emptyFlag("schema");
    }
    // Every rule a committed path has to satisfy lives in core, so `--schema`
    // is judged by the same validator `penv validate` will judge the config by.
    // Refusing here is refusing before a file is written; refusing there is
    // refusing after the project already has one in the wrong place.
    const error = validateSchemaFile({ environments: [], providers: {}, schemaFile })[0];
    if (error !== undefined) {
      throw error;
    }
  }

  const alias = flags.alias === undefined ? detectAlias(root) : flags.alias.trim();
  if (flags.alias !== undefined && alias.length === 0) {
    throw emptyFlag("alias");
  }
  if (!ALIAS_NAME.test(alias)) {
    throw new PenvError(
      "INIT_ALIAS_INVALID",
      `\`${alias}\` is not an alias penv can write`,
      `An alias is \`@name\` — a tsconfig \`paths\` entry a bundler resolves — or \`#name\`, a ` +
        "package.json `imports` entry Node resolves itself. Those are the two things a module " +
        "specifier can be that is not a package.",
    );
  }
  // Only when penv worked it out. `--alias` needs no explanation of why penv
  // chose it, and this note would have explained a reason that was not true:
  // it fired on the *form* of the alias rather than on where it came from, so a
  // forced `#env` was told its own package.json had asked for it.
  if (flags.alias === undefined && alias.startsWith(IMPORTS_PREFIX)) {
    notes.push(
      `Your ${PACKAGE_FILE} declares \`imports\`, so the alias is \`${alias}\` — Node resolves it without a bundler.`,
    );
  }

  const suggestedEnvironments = suggestEnvironments(root);
  const environments = flags.environments ?? declared?.environments ?? [];
  // The empty whitelist is worth a line only when it is still empty. A project
  // that declared `production` being told it has declared nothing is penv
  // reading its own config wrong out loud.
  if (environments.length === 0) {
    notes.push(
      "No environments declared: penv does not infer them, and a `--yes` run cannot invent them.",
    );
    if (suggestedEnvironments.length > 0) {
      notes.push(
        `Your \`.env\` files mention ${suggestedEnvironments.join(", ")} — declare the ones you ` +
          `really deploy in ${CONFIG_FILE}, with a provider for each.`,
      );
    }
  }

  return {
    detected,
    decisions: {
      environments,
      // Injection is a choice about the app's needs, not something on disk — so
      // the plan defaults it off, and only the interactive prompt turns it on.
      inject: false,
      schemaFile,
      publicPrefixes: declared?.publicPrefixes ?? detected?.publicPrefixes ?? [],
      alias,
    },
    suggestedEnvironments,
    notes,
  };
}

/*
 * The prompt.
 *
 * A plan the human confirms, not an interrogation they answer: penv already
 * knows everything but the one fact it must not guess, so it shows the whole
 * page and asks once. The io is a parameter so the decision logic is a plain
 * function — the tests call it, they do not spawn a terminal.
 */

export interface PromptIo {
  readonly ask: (question: string) => Promise<string>;
  readonly write: (line: string) => void;
}

/** The plan as one screen. */
export function renderPlan(plan: InitPlan): string[] {
  const rows: string[][] = [];
  rows.push([
    `  ${out.dim("environments")}`,
    plan.suggestedEnvironments.length === 0
      ? ""
      : out.cyan(`[${plan.suggestedEnvironments.join(", ")}]`),
    out.dim(
      plan.suggestedEnvironments.length === 0
        ? "← name them, or Enter to leave the whitelist empty"
        : "← from your .env files; edit, or Enter to accept",
    ),
  ]);
  rows.push([
    `  ${out.dim("schemaFile")}`,
    plan.decisions.schemaFile,
    plan.decisions.schemaFile === DEFAULT_SCHEMA_FILE
      ? ""
      : out.dim(`(default: ${DEFAULT_SCHEMA_FILE})`),
  ]);
  for (const prefix of plan.decisions.publicPrefixes) {
    rows.push([`  ${out.dim("publicPrefix")}`, prefix, ""]);
  }

  const headline = out.bold(
    plan.detected === undefined
      ? "No framework detected in package.json."
      : `Detected ${plan.detected.name}.`,
  );
  return [headline, "", ...columns(rows), ""];
}

function environmentsHint(plan: InitPlan): string {
  return plan.suggestedEnvironments.length === 0
    ? prompt("environments", "comma-separated, Enter for none")
    : prompt("environments", 'Enter to accept, "none" for an empty whitelist');
}

/**
 * The plan, confirmed. `undefined` is the human declining, which is an outcome
 * and not a failure: nothing is written and the run says so.
 *
 * An answer that is neither yes nor no declines, because the two mistakes are
 * not symmetrical — a decline costs a re-run, while reading "no thanks" as
 * consent scaffolds a project someone said no to.
 */
export async function promptForDecisions(
  plan: InitPlan,
  io: PromptIo,
): Promise<InitDecisions | undefined> {
  for (const line of renderPlan(plan)) {
    io.write(line);
  }

  const answer = (await io.ask(environmentsHint(plan))).trim();
  const environments =
    answer.length === 0
      ? plan.suggestedEnvironments
      : answer.toLowerCase() === "none"
        ? []
        : splitEnvironments(answer);
  // The confirmation has to be about what is actually written, so an edited
  // line is echoed before `Proceed?` rather than confirmed in the abstract.
  if (answer.length > 0) {
    io.write("");
    io.write(
      environments.length === 0
        ? "  environments  [] (declare them later in penv.config.ts)"
        : `  environments  [${environments.join(", ")}]`,
    );
    io.write("");
  }

  // Injection is off unless the developer asks — and there is no point asking on a
  // runtime that reads nothing from process.env (a pure client SPA), so the
  // question appears only when the framework has a seam to place.
  const inject = seamKindFor(plan) === "none" ? false : await askInject(io);

  const proceed = (await io.ask(prompt("Proceed?", "Y/n"))).trim().toLowerCase();
  if (proceed.length > 0 && proceed !== "y" && proceed !== "yes") {
    return undefined;
  }
  return { ...plan.decisions, environments, inject };
}

/** The seam kind for the plan's framework, so the prompt can skip a runtime injection cannot serve. */
function seamKindFor(plan: InitPlan): Seam["kind"] {
  return seamFor(plan.detected?.name, {
    alias: plan.decisions.alias,
    srcDir: plan.decisions.schemaFile.startsWith("src/") ? "src/" : "",
  }).kind;
}

/**
 * The injection question, implication-first: the developer reads what yes and no
 * each *do*, not a premise about libraries. Default is no.
 */
async function askInject(io: PromptIo): Promise<boolean> {
  io.write("");
  io.write("Also inject your validated config into process.env?");
  io.write("  y  libraries that read process.env directly (WorkOS, Prisma…) just work");
  io.write('  n  config stays available only through  import { env } from "@env"');
  const answer = (await io.ask(prompt("inject", "y/N"))).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/*
 * Templates.
 */

/** One schema field for the draft `penv import` generates. */
export interface SchemaField {
  readonly key: string;
  /** The Zod expression, e.g. `z.url()`. */
  readonly type: string;
}

const EMPTY_SCHEMA_BODY =
  "  // One key per parameter, e.g. `databaseUrl: z.url(),`. Nesting a key nests\n" +
  "  // the parameter: `redis: z.object({ password: z.string() })` is redis/password.";

const DRAFT_HEADER =
  "// DRAFT — generated by `penv import` from one sample of each value, and yours\n" +
  "// to correct. Single-sample inference cannot know that a boolean seen as `true`\n" +
  "// must also accept `1`/`0`, or that a string is really a URL. penv scaffolds\n" +
  "// this file once and never regenerates it, so edits here are safe.\n";

export function renderSchemaModule(
  fields: readonly SchemaField[],
  draft: boolean,
  inject = false,
): string {
  const body =
    fields.length === 0
      ? EMPTY_SCHEMA_BODY
      : fields.map((field) => `  ${field.key}: ${field.type},`).join("\n");

  const loadComment = inject
    ? "// The loaded, validated values for the current environment. Import this in app\n" +
      "// code. `inject: true` also copies the values into process.env, for libraries\n" +
      "// that read process.env directly (WorkOS, Prisma) instead of importing @env.\n"
    : "// The loaded, validated values for the current environment. Import this in app\n" +
      "// code. Importing it loads configuration and throws (naming the parameter and\n" +
      "// environment) if anything required is missing or invalid.\n";
  const loadCall = inject
    ? "export const env = load(schema, { inject: true });\n"
    : "export const env = load(schema);\n";

  return (
    `${draft ? DRAFT_HEADER : ""}import { z } from "zod";\n` +
    `import { load } from "@penvhq/penv";\n` +
    `\n` +
    `// The shape. Import this (or z.infer<typeof schema>) when you only need the\n` +
    `// type — tests, tooling — so you don't trigger config loading.\n` +
    `export const schema = z.object({\n${body}\n});\n` +
    `\n` +
    loadComment +
    loadCall +
    `\n` +
    `// Registers the schema's shape with penv's types (erased at runtime, so\n` +
    `// nothing cycles). This is what makes \`override\` keys in penv.config.ts\n` +
    `// autocomplete from this schema — a typo'd parameter id is a compile error.\n` +
    `declare module "@penvhq/core" {\n` +
    `  interface PenvSchemaShape {\n` +
    `    readonly shape: z.infer<typeof schema>;\n` +
    `  }\n` +
    `}\n`
  );
}

/**
 * The whitelist block. Empty is the honest answer to a question nothing on disk
 * can settle, so the comment carries what an empty file cannot: that penv left
 * it empty on purpose, and the exact shape of the two lines that fill it in.
 */
function renderEnvironments(decisions: InitDecisions): string {
  const shared =
    "  // Environments are a whitelist. A filename segment is an environment only if\n" +
    "  // it is declared here — penv never infers one from a folder or a filename.\n";
  if (decisions.environments.length === 0) {
    return (
      `${shared}` +
      "  // It starts empty because which environments you deploy is not something penv\n" +
      "  // can read off your codebase, and an environment you do not have is worse\n" +
      "  // than one you have not declared yet. Name yours, and give each a provider:\n" +
      '  //   environments: ["development", "production"],\n' +
      '  //   providers: { development: { type: "@penvhq/provider-filesystem" }, production: { type: "@penvhq/provider-filesystem" } },\n' +
      "  environments: [],\n" +
      "\n" +
      "  providers: {},\n"
    );
  }
  const names = decisions.environments.map((name) => JSON.stringify(name)).join(", ");
  const providers = decisions.environments
    .map((name) => `    ${JSON.stringify(name)}: { type: "@penvhq/provider-filesystem" },\n`)
    .join("");
  return (
    `${shared}  environments: [${names}],\n` +
    "\n" +
    "  // One entry per environment: where that environment's values are read from.\n" +
    `  providers: {\n${providers}  },\n`
  );
}

/** The config, carrying only the decisions that were actually made. */
export function renderConfigModule(decisions: InitDecisions): string {
  let body = renderEnvironments(decisions);

  // The default is written by not writing it: a key that restates the default is
  // noise the next reader has to check against the docs before they can ignore it.
  if (decisions.schemaFile !== DEFAULT_SCHEMA_FILE) {
    body +=
      "\n  // The module that exports the schema. It is yours — penv scaffolds it once\n" +
      "  // and never regenerates it — so this says where you keep it.\n" +
      `  schemaFile: ${JSON.stringify(decisions.schemaFile)},\n`;
  }
  if (decisions.publicPrefixes.length > 0) {
    const prefixes = decisions.publicPrefixes.map((prefix) => JSON.stringify(prefix)).join(", ");
    body +=
      "\n  // The prefixes your framework inlines into the browser bundle. `penv doctor`\n" +
      "  // reports a parameter your meta declares `secret: true` whose variable name\n" +
      "  // starts with one of these — penv is the only thing holding both facts.\n" +
      `  publicPrefixes: [${prefixes}],\n`;
  }

  return `import { defineConfig } from "@penvhq/penv";\n\nexport default defineConfig({\n${body}});\n`;
}

/**
 * Invariant 17: value files are never committed; structure, the schema, meta,
 * and config are. The negated directory pattern keeps git descending into
 * namespace folders, which an excluded directory would otherwise hide entirely.
 *
 * The schema is un-ignored by name only when it lives in the tree. Outside it,
 * this file has no opinion on it at all, and a `!env.ts` naming nothing is a
 * line the next reader has to work out is dead.
 */
export function renderGitignore(decisions: InitDecisions): string {
  const inside = schemaInsideTree(configOf(decisions));
  const listed = inside === undefined ? "" : `${inside}, `;
  return (
    `# Written by penv. Value files hold configuration values and are never\n` +
    `# committed; only the structure, ${listed}meta, and config are.\n` +
    `*\n` +
    `!*/\n` +
    `!.gitignore\n` +
    `${inside === undefined ? "" : `!${inside}\n`}` +
    `!*.json\n`
  );
}

/*
 * The tsconfig.json edit.
 *
 * The alias is inserted into the user's own file, so the file is scanned rather
 * than parsed and re-emitted: reformatting someone's tsconfig — dropping its
 * comments, resorting its keys — to add one path is not a minimal edit.
 */

function skipTrivia(source: string, index: number): number {
  let i = index;
  for (;;) {
    const ch = source.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "/" && source.charAt(i + 1) === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "/" && source.charAt(i + 1) === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
}

/** Index just past the closing quote of the string opening at `index`. */
function endOfString(source: string, index: number): number {
  let i = index + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/** Index just past the bracket matching the one at `index`. */
function endOfBracket(source: string, index: number): number {
  const open = source.charAt(index);
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '"') {
      i = endOfString(source, i);
      continue;
    }
    if (ch === "/" && (source.charAt(i + 1) === "/" || source.charAt(i + 1) === "*")) {
      i = skipTrivia(source, i);
      continue;
    }
    if (ch === open) {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    i += 1;
  }
  return source.length;
}

function endOfValue(source: string, index: number): number {
  const ch = source.charAt(index);
  if (ch === '"') {
    return endOfString(source, index);
  }
  if (ch === "{" || ch === "[") {
    return endOfBracket(source, index);
  }
  let i = index;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "," || c === "}" || c === "]" || c === "\n") {
      return i;
    }
    i += 1;
  }
  return source.length;
}

interface Member {
  readonly valueStart: number;
}

/** The member named `key` directly inside the object whose `{` is at `open`. */
function findMember(source: string, open: number, key: string): Member | undefined {
  const close = endOfBracket(source, open) - 1;
  let i = skipTrivia(source, open + 1);
  while (i < close) {
    if (source.charAt(i) !== '"') {
      return undefined;
    }
    const keyEnd = endOfString(source, i);
    const name = source.slice(i + 1, keyEnd - 1);
    const colon = skipTrivia(source, keyEnd);
    if (source.charAt(colon) !== ":") {
      return undefined;
    }
    const valueStart = skipTrivia(source, colon + 1);
    const valueEnd = endOfValue(source, valueStart);
    if (name === key) {
      return { valueStart };
    }
    let next = skipTrivia(source, valueEnd);
    if (source.charAt(next) === ",") {
      next = skipTrivia(source, next + 1);
    }
    i = next;
  }
  return undefined;
}

/** The indentation of the line `index` sits on. */
function lineIndent(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, index));
  return match?.[0] ?? "";
}

/** The file's own indentation unit, so the inserted line looks like its neighbours. */
function indentUnit(source: string): string {
  const match = /\n([ \t]+)"/.exec(source);
  return match?.[1] ?? "  ";
}

function insertMember(source: string, open: number, member: string, unit: string): string {
  const objectIndent = lineIndent(source, open);
  const entryIndent = objectIndent + unit;
  const close = endOfBracket(source, open) - 1;
  if (skipTrivia(source, open + 1) === close) {
    return `${source.slice(0, open + 1)}\n${entryIndent}${member}\n${objectIndent}${source.slice(close)}`;
  }
  return `${source.slice(0, open + 1)}\n${entryIndent}${member},${source.slice(open + 1)}`;
}

function shapeError(what: string, target: string, alias: string): PenvError {
  return new PenvError(
    "TSCONFIG_SHAPE",
    `penv cannot add the \`${alias}\` path alias to tsconfig.json: ${what}`,
    `Add it by hand: \`{ "compilerOptions": { "paths": { "${alias}": ["${target}"] } } }\`.`,
  );
}

export interface AliasEdit {
  readonly source: string;
  readonly changed: boolean;
  /**
   * What the alias already points at, when that is not penv's schema.
   *
   * The alias is how the user's code reaches penv, so an alias that resolves
   * somewhere else is not a small problem: `import { env } from "@env"` compiles,
   * runs, and hands back another module's export. Reporting "kept the alias"
   * because the *key* was present is how penv would say that was fine — a silent
   * seam, in the scaffolder of the tool whose subject is silent seams.
   *
   * Left as the user's, never rewritten: penv cannot tell a stale mapping from a
   * deliberate one, and the file is theirs.
   */
  readonly conflict?: string;
}

/**
 * `tsconfig.json` with the `@env` alias present, everything else untouched.
 * Already-aliased input comes back unchanged rather than gaining a duplicate.
 *
 * The alias is why the schema can live anywhere: application code imports
 * `@env`, and this line is the only thing that has to know where that is.
 */
export function insertEnvAlias(
  source: string,
  target: string = DEFAULT_SCHEMA_FILE,
  name: string = DEFAULT_ALIAS,
): AliasEdit {
  const alias = `"${name}": ["${target}"]`;
  const root = skipTrivia(source, 0);
  if (source.charAt(root) !== "{") {
    throw shapeError("its contents are not a JSON object", target, name);
  }

  const unit = indentUnit(source);
  const compilerOptions = findMember(source, root, "compilerOptions");
  if (compilerOptions === undefined) {
    return {
      source: insertMember(source, root, `"compilerOptions": { "paths": { ${alias} } }`, unit),
      changed: true,
    };
  }
  if (source.charAt(compilerOptions.valueStart) !== "{") {
    throw shapeError("`compilerOptions` is not an object", target, name);
  }

  const paths = findMember(source, compilerOptions.valueStart, "paths");
  if (paths === undefined) {
    return {
      source: insertMember(source, compilerOptions.valueStart, `"paths": { ${alias} }`, unit),
      changed: true,
    };
  }
  if (source.charAt(paths.valueStart) !== "{") {
    throw shapeError("`compilerOptions.paths` is not an object", target, name);
  }

  const existing = findMember(source, paths.valueStart, name);
  if (existing !== undefined) {
    // The key being present is not the question. Where it points is.
    const points = source.slice(existing.valueStart, endOfValue(source, existing.valueStart));
    return points.includes(`"${target}"`)
      ? { source, changed: false }
      : { source, changed: false, conflict: points.trim() };
  }
  return { source: insertMember(source, paths.valueStart, alias, unit), changed: true };
}

/**
 * `package.json` with the `#env` subpath import present, everything else untouched.
 *
 * The same scanning edit the tsconfig gets, for the same reason: a manifest is
 * the project's file, and rewriting it through `JSON.parse`/`stringify` to add
 * one key resorts nothing but reformats everything.
 *
 * `imports` is Node's own mechanism, so an alias written here needs no bundler to
 * resolve — which is the whole reason a project would choose it.
 */
export function insertImportsAlias(source: string, target: string, name: string): AliasEdit {
  const entry = `"${name}": "./${target}"`;
  const root = skipTrivia(source, 0);
  if (source.charAt(root) !== "{") {
    throw shapeError("its contents are not a JSON object", target, name);
  }

  const unit = indentUnit(source);
  const imports = findMember(source, root, "imports");
  if (imports === undefined) {
    return { source: insertMember(source, root, `"imports": { ${entry} }`, unit), changed: true };
  }
  if (source.charAt(imports.valueStart) !== "{") {
    throw shapeError("`imports` is not an object", target, name);
  }

  const existing = findMember(source, imports.valueStart, name);
  if (existing !== undefined) {
    const points = source.slice(existing.valueStart, endOfValue(source, existing.valueStart));
    return points.includes(`"./${target}"`)
      ? { source, changed: false }
      : { source, changed: false, conflict: points.trim() };
  }
  return { source: insertMember(source, imports.valueStart, entry, unit), changed: true };
}

function renderTsconfig(target: string, alias: string): string {
  return `{\n  "compilerOptions": {\n    "paths": { "${alias}": ["${target}"] }\n  }\n}\n`;
}

/*
 * The steps themselves. Each returns what it did so the caller reports it.
 */

export function ensurePenvDir(root: string): InitStep {
  const dir = resolve(root, PENV_DIR);
  if (existsSync(dir)) {
    return { target: "penv-dir", action: "kept", text: `Found ${PENV_DIR}/` };
  }
  mkdirSync(dir, { recursive: true });
  return { target: "penv-dir", action: "created", text: `Created ${PENV_DIR}/` };
}

/**
 * Invariant 2: the schema module is scaffolded once and never regenerated. An
 * existing file is the user's, whatever penv would have written instead — and
 * that holds wherever they keep it, so the check is against the chosen path and
 * not the default one.
 */
export function writeSchemaFile(
  root: string,
  fields: readonly SchemaField[],
  draft: boolean,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const file = join(root, ...decisions.schemaFile.split("/"));
  if (existsSync(file)) {
    return {
      target: "schema",
      action: "kept",
      text: `Kept ${decisions.schemaFile}`,
      note: "(yours — penv never regenerates it)",
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSchemaModule(fields, draft, decisions.inject), "utf8");
  return {
    target: "schema",
    action: "created",
    text: `Generated ${decisions.schemaFile}`,
    note: draft ? "(draft schema — review it, it's yours)" : "(schema + loader — yours to edit)",
  };
}

export function writeConfigFile(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    return { target: "config", action: "kept", text: `Kept ${CONFIG_FILE}` };
  }
  writeFileSync(file, renderConfigModule(decisions), "utf8");
  return { target: "config", action: "created", text: `Generated ${CONFIG_FILE}` };
}

export function writeTsconfigAlias(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const alias = decisions.alias;
  // `#env` is Node's mechanism and lives in the manifest; `@env` is TypeScript's
  // and lives in the tsconfig. Writing one into the other's file produces a key
  // nothing reads — the alias would simply never resolve, and penv would have
  // reported writing it.
  const imports = alias.startsWith(IMPORTS_PREFIX);
  const file = join(root, imports ? PACKAGE_FILE : TSCONFIG_FILE);
  const where = imports ? PACKAGE_FILE : TSCONFIG_FILE;

  if (!existsSync(file)) {
    // A project with no manifest is not one penv invents a manifest for: the
    // manifest is the project's identity, and `imports` is a key on something
    // that already exists. A tsconfig penv can honestly create from nothing.
    if (imports) {
      return {
        target: "tsconfig",
        action: "conflicted",
        text: `No ${PACKAGE_FILE} to add the ${alias} import to`,
        note: `(run \`npm init\` first, or use \`--alias @env\` to alias through ${TSCONFIG_FILE})`,
      };
    }
    writeFileSync(file, renderTsconfig(decisions.schemaFile, alias), "utf8");
    return {
      target: "tsconfig",
      action: "created",
      text: `Created ${TSCONFIG_FILE} with the ${alias} path alias`,
    };
  }

  const source = readFileSync(file, "utf8");
  const edit = imports
    ? insertImportsAlias(source, decisions.schemaFile, alias)
    : insertEnvAlias(source, decisions.schemaFile, alias);

  if (edit.conflict !== undefined) {
    return {
      target: "tsconfig",
      action: "conflicted",
      text: `${where} already maps ${alias} to ${edit.conflict}`,
      note: `(left alone — \`import { env } from "${alias}"\` will not reach ${decisions.schemaFile})`,
    };
  }
  if (!edit.changed) {
    return {
      target: "tsconfig",
      action: "kept",
      text: `Kept the ${alias} alias in ${where}`,
    };
  }
  writeFileSync(file, edit.source, "utf8");
  return {
    target: "tsconfig",
    action: "updated",
    text: `Added ${alias} alias to ${where}`,
  };
}

/**
 * The ignore file lives inside `.penv/`, where the value files are: penv owns it
 * outright, so it is rewritten when it drifts. A weakened ignore file is how a
 * plaintext secret gets committed, which invariant 17 exists to prevent.
 */
export function writeGitignore(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const file = join(root, PENV_DIR, GITIGNORE_FILE);
  const relative = `${PENV_DIR}/${GITIGNORE_FILE}`;
  const wanted = renderGitignore(decisions);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (existing === wanted) {
    return { target: "gitignore", action: "kept", text: `Kept ${relative}` };
  }
  mkdirSync(join(root, PENV_DIR), { recursive: true });
  writeFileSync(file, wanted, "utf8");
  return {
    target: "gitignore",
    action: existing === undefined ? "created" : "updated",
    text: `${existing === undefined ? "Created" : "Updated"} ${relative}`,
  };
}

/** `"src/"` when the project keeps its modules under `src/`, else `""` — the layout the seams key off. */
function srcDirOf(root: string): string {
  return existsSync(join(root, "src")) ? "src/" : "";
}

/**
 * Places the injection seam for the detected framework — the file whose one
 * `import "@env"` runs before app code, so an injected `process.env` is populated
 * before a library reads it. penv scaffolds a fresh seam file, but never edits a
 * hook the user already owns: an existing file, or a framework with no file penv
 * can safely own, becomes a printed instruction instead. Returns nothing when
 * injection was not chosen.
 */
export function writeSeam(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep | undefined {
  if (!decisions.inject) {
    return undefined;
  }
  const framework = detectFramework(root)?.name;
  const seam = seamFor(framework, { alias: decisions.alias, srcDir: srcDirOf(root) });

  if (seam.kind === "none") {
    return { target: "seam", action: "info", text: "No injection seam needed", note: seam.reason };
  }
  if (seam.kind === "instruct") {
    return {
      target: "seam",
      action: "info",
      text: "Place the injection seam",
      note: seam.instruction,
    };
  }

  const file = join(root, ...seam.file.split("/"));
  const notes = seam.notes.length === 0 ? "" : `\n${seam.notes.map((n) => `  ${n}`).join("\n")}`;
  if (existsSync(file)) {
    return {
      target: "seam",
      action: "info",
      text: `Add the injection seam to ${seam.file}`,
      note: `${seam.ifPresent}${notes}`,
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, seam.content, "utf8");
  return {
    target: "seam",
    action: "created",
    text: `Wrote ${seam.file} (runs the injection before your app)`,
    ...(notes === "" ? {} : { note: notes.trimStart() }),
  };
}

/** Everything `init` scaffolds, in the order it is reported. */
export function scaffold(
  root: string,
  fields: readonly SchemaField[],
  draft: boolean,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep[] {
  const steps = [
    ensurePenvDir(root),
    writeSchemaFile(root, fields, draft, decisions),
    writeConfigFile(root, decisions),
    writeTsconfigAlias(root, decisions),
    writeGitignore(root, decisions),
  ];
  const seam = writeSeam(root, decisions);
  return seam === undefined ? steps : [...steps, seam];
}

export function runInit(options: InitOptions): InitResult {
  const root = resolve(options.cwd);
  const decisions = options.decisions ?? planInit(root).decisions;
  return { root, decisions, steps: scaffold(root, [], false, decisions) };
}

export function renderInit(result: InitResult): string[] {
  const steps: Step[] = result.steps.map((step) => {
    // A conflict is the one step that is not a success, so it must not wear the
    // glyph every success wears: a ✓ beside "penv could not wire your alias" is
    // the line a reader skims past. An `info` step is a thing left for the user
    // to do, so it wears the tip arrow rather than a ✓ it did not earn.
    const glyph = step.action === "conflicted" ? WARN : step.action === "info" ? "→" : CHECK;
    return step.note === undefined
      ? { glyph, text: step.text }
      : { glyph, text: step.text, note: step.note };
  });
  return [
    ...formatSteps(steps),
    "",
    `${out.green(CHECK)} ${out.bold("Done.")} Declare your parameters in ${result.decisions.schemaFile}, then:`,
    tip(out.cyan("penv set <key>")),
    ...(result.decisions.environments.length === 0
      ? [
          `Then declare your environments in ${CONFIG_FILE}: penv leaves the whitelist empty ` +
            `rather than inventing one, and every command needs it.`,
        ]
      : []),
  ];
}

/** The prompt runs only against a real terminal; anything else has nobody to ask. */
async function askOnTty(plan: InitPlan): Promise<InitDecisions | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptForDecisions(plan, {
      ask: (question) => rl.question(question),
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    rl.close();
  }
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize a project (.penv/, env.ts, config, @env alias)" },
  args: {
    yes: {
      type: "boolean",
      description:
        "Take the detected defaults without asking. Environments still start empty — penv " +
        "cannot see your infrastructure",
    },
    schema: {
      type: "string",
      description: `Where the schema module goes, e.g. src/env.ts (default: ${DEFAULT_SCHEMA_FILE})`,
    },
    alias: {
      type: "string",
      description:
        "How your code names the schema: @env (tsconfig paths, needs a bundler) or #env " +
        "(package.json imports, resolved by node itself)",
    },
    env: {
      type: "string",
      description:
        "Declare an environment. Repeatable, or comma-separated: --env development,production",
    },
  },
  run({ args }) {
    return guard(async () => {
      const root = resolve(process.cwd());
      const environments = environmentsFromFlag(args.env);
      const plan = planInit(root, {
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        ...(args.alias === undefined ? {} : { alias: args.alias }),
        ...(environments === undefined ? {} : { environments }),
      });

      // No terminal is not a reason to guess: it is a reason to take the
      // defaults and say what they were, so a CI log carries the decisions.
      const asked = process.stdin.isTTY === true && args.yes !== true && environments === undefined;
      const decisions = asked ? await askOnTty(plan) : plan.decisions;
      if (decisions === undefined) {
        write(["Nothing written. Re-run `penv init` when you want to scaffold."]);
        return;
      }
      if (!asked) {
        write([...plan.notes, ""]);
      }
      write(renderInit(runInit({ cwd: root, decisions })));
    });
  },
});
