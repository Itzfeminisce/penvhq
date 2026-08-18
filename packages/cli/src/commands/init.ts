/**
 * `penv init` — scaffold a project, and adopt its dotenv files completely.
 *
 * A project with `.env` files gets a cutover: init lists every dotenv file it
 * found, the developer picks the ones penv takes, and then penv either takes all
 * of them or none. There is no half-adopted state, because a project whose
 * values live half in `.env` and half in penv has two truths about its own
 * configuration — the drift penv exists to delete, introduced by penv itself. So
 * everything is preflighted first: the selection, the environments it declares,
 * every variable name, the draft schema, the dependency install, and the
 * generated variable each parameter maps to. A failed preflight moves nothing,
 * writes nothing, and never reports partial success.
 *
 * Only after the imported values validate do the dotenv files move — into one
 * ignored `.penv/state/rollback/dotenv/` bundle, recorded in
 * `.penv/state/cutover.json`, which `penv init undo` restores by exact name and
 * `penv cleanup` drops.
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
 * Selecting `.env.production` is the developer declaring production; selecting
 * `.env` alone declares nothing, and init asks which environment those values
 * are for rather than deciding.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { DotenvDiagnostic, DotenvEntry, ParameterRef, Scope } from "@penvhq/core";
import {
  CUTOVER_PATH,
  DEFAULT_SCHEMA_FILE,
  isLegalEnvironmentName,
  loadConfigFrom,
  PENV_DIR,
  type PenvConfig,
  PenvError,
  parameterId,
  parseDotenv,
  RECORDS_PATH,
  RESERVED_TOKENS,
  ROLLBACK_DOTENV_PATH,
  renderStateGitignore,
  SCHEMA_SHAPE_FILE,
  STATE_GITIGNORE_PATH,
  schemaFileOf,
  validateConfig,
  validateSchemaFile,
} from "@penvhq/core";
import { defineCommand } from "citty";
import { assertNoCollisions, refsForEntries, writeEntries } from "../adopt.js";
import { bundleDotenvFiles, bundleUnresolved, runUndo } from "../cutover.js";
import {
  DEFAULT_ALIAS,
  type Detected,
  detectAlias,
  detectFramework,
  srcPrefix,
} from "../detect.js";
import type { DotenvFile } from "../dotenv-files.js";
import { cascadeFor, discoverDotenvFiles, environmentsDeclaredBy } from "../dotenv-files.js";
import type { DraftField, SchemaField } from "../draft-schema.js";
import { draftFieldsAcross } from "../draft-schema.js";
import type { InstallPlan, InstallRuntime } from "../install.js";
import {
  detectPackageManager,
  installWithPackageManager,
  planInstall,
  renderInstallPlan,
} from "../install.js";
import { localTree, openProject, selfContainedSchemaModule } from "../project.js";
import { type ScaffoldSeam, type Seam, seamFor } from "../seams.js";
import { out } from "../style.js";
import { CHECK, columns, formatSteps, guard, prompt, type Step, tip, WARN, write } from "../ui.js";
import type { ValidateResult } from "./validate.js";
import { checkEnvironment } from "./validate.js";

export const SCHEMA_FILE = "env.ts";

/**
 * The shape module, at the project root beside `penv.config.ts`. It is pure — a
 * `z.object` and the type registration, no `load` — so importing it never loads
 * configuration, which is what lets a tooling config (drizzle-kit, a CI script)
 * import the one schema without a side effect instead of hand-inlining a second
 * `z.object` that drifts (invariant 2). `.penv/env.ts` is the thin wrapper that
 * re-exports it and calls `load`.
 *
 * Fixed at the root rather than following `schemaFile`: `schemaFile` names the
 * *wrapper* (see {@link writeEnvFile}), and the shape is the one file every
 * consumer derives from wherever the wrapper is kept.
 *
 * `schemaFile` stays on the wrapper `.penv/env.ts` rather than being pointed at
 * this shape module: the wrapper is what `load` runs, and the harvester
 * (loadSchema) reads one `schema` export from `schemaFile`, which the wrapper
 * re-exports. Neither module sits in the records tree, so the walker meets
 * neither.
 *
 * The path itself (`penv.schema.ts`, at the root) is core's — `watch` watches it,
 * the grammar excludes it, and one authority answers where it is.
 */
export { SCHEMA_SHAPE_FILE };

/** The basename the wrapper imports the shape by, extension appended per {@link shapeSpecifier}. */
const SCHEMA_SHAPE_BASENAME = "penv.schema";

export const CONFIG_FILE = "penv.config.ts";
export const TSCONFIG_FILE = "tsconfig.json";

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
export type InitTarget =
  | "penv-dir"
  | "schema"
  | "env"
  | "config"
  | "tsconfig"
  | "gitignore"
  | "seam";
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
  /**
   * The environment every command falls back to when `--env` is absent (seal 3).
   * Written only when the cutover adopted one — a declared decision, so the
   * whitelist rule is untouched, and CI keeps naming `--env` anyway.
   */
  readonly defaultEnvironment?: string;
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
  /** The detected framework name, passed by the command so the seam step need not re-detect it. */
  readonly framework?: string;
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
  /**
   * `--yes` on a project with nothing to adopt. It takes `development` and the
   * local provider — the machine the command was typed on, which is the one
   * environment penv can declare without claiming a deployment exists.
   */
  readonly yes?: boolean;
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
  // `--yes` takes `development` and nothing else (PRD §6). It is the machine the
  // command was typed on rather than a claim that a deployment exists, which is
  // what separates it from the production/staging/preview it still never invents.
  const safeDefault = flags.yes === true && declared === undefined;
  const environments =
    flags.environments ?? declared?.environments ?? (safeDefault ? [DEVELOPMENT] : []);
  const defaultEnvironment =
    declared?.defaultEnvironment ?? (safeDefault ? DEVELOPMENT : undefined);
  if (safeDefault) {
    notes.push(
      `\`--yes\` declares ${DEVELOPMENT} with the local provider — the one environment penv can ` +
        "name without inventing a deployment.",
    );
  }
  // The empty whitelist is worth a line only when it is still empty. A project
  // that declared `production` being told it has declared nothing is penv
  // reading its own config wrong out loud.
  if (environments.length === 0) {
    notes.push("No environments declared: penv does not infer them.");
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
      // A recorded decision, carried forward so a re-run reports the project as
      // it is. `writeConfigFile` keeps an existing config either way.
      ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
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

  // `Proceed?` is asked FIRST, so the confirmation muscle-memory — Enter, then a
  // decline — still declines: a new question inserted above it would otherwise
  // eat the "n" and default Proceed to yes, scaffolding a project someone meant to
  // refuse. Injection is a refinement of a scaffold already agreed to, so it is
  // asked only after that yes — and never on a runtime injection cannot serve.
  const proceed = (await io.ask(prompt("Proceed?", "Y/n"))).trim().toLowerCase();
  if (proceed.length > 0 && proceed !== "y" && proceed !== "yes") {
    return undefined;
  }
  const inject = seamKindFor(plan) === "none" ? false : await askInject(io);
  return { ...plan.decisions, environments, inject };
}

/** The seam kind for the plan's framework, so the prompt can skip a runtime injection cannot serve. */
function seamKindFor(plan: InitPlan): Seam["kind"] {
  return seamFor(plan.detected?.name, {
    alias: plan.decisions.alias,
    srcDir: plan.decisions.schemaFile.startsWith("src/") ? "src/" : "",
    schemaFile: plan.decisions.schemaFile,
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

export type { SchemaField };

const EMPTY_SCHEMA_BODY =
  "  // One key per parameter, e.g. `databaseUrl: z.url(),`. Nesting a key nests\n" +
  "  // the parameter: `redis: z.object({ password: z.string() })` is redis/password.";

const DRAFT_HEADER =
  "// DRAFT — generated from the dotenv values penv adopted, and yours to correct.\n" +
  "// Inference from a sample cannot know that a boolean seen as `true` must also\n" +
  "// accept `1`/`0`, or that a string is really a URL. A field every adopted\n" +
  "// environment had starts required; one that was missing anywhere starts\n" +
  "// optional. penv scaffolds this file once and never regenerates it, so edits\n" +
  "// here are safe.\n";

/**
 * `penv.schema.ts` — the shape, and nothing that loads. This is the side-effect
 * free half of the split: a `z.object` plus the type registration, so importing
 * it (or `z.infer<typeof schema>`) never touches configuration. Tooling that
 * needs the schema imports *this* — never a second `z.object` over the same
 * store, which is the drift invariant 2 exists to prevent.
 *
 * The draft header and the harvested fields land here, because this is where the
 * parameters live: `penv import` writes the shape it inferred into the shape
 * module, and `.penv/env.ts` wraps whatever it finds.
 */
export function renderSchemaShapeModule(fields: readonly SchemaField[], draft: boolean): string {
  const body =
    fields.length === 0
      ? EMPTY_SCHEMA_BODY
      : fields.map((field) => `  ${field.key}: ${field.type},`).join("\n");

  return (
    `${draft ? DRAFT_HEADER : ""}import { z } from "zod";\n` +
    `\n` +
    `// The shape — the one definition every consumer derives from. Import this (or\n` +
    `// z.infer<typeof schema>) when you only need the type — tests, tooling — so you\n` +
    `// don't trigger config loading. .penv/env.ts wraps it with load().\n` +
    `export const schema = z.object({\n${body}\n});\n` +
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
 * The specifier `.penv/env.ts` imports the shape by, relative to wherever the
 * wrapper is kept. The shape is always at the project root, so this is the climb
 * back up to it: `.penv/env.ts` → `../penv.schema.js`, a root `env.ts` →
 * `./penv.schema.js`, `src/lib/env.ts` → `../../penv.schema.js`.
 *
 * The `.js` extension is deliberate, not a typo for the `.ts` file it names: a
 * relative import under `moduleResolution: node16`/`nodenext` must carry the
 * *output* extension, and TypeScript maps `penv.schema.js` back to
 * `penv.schema.ts` for the type. Bundler resolution accepts it too, so one
 * specifier is correct everywhere — an extensionless one would fail to resolve for
 * a project on nodenext.
 */
function shapeSpecifier(schemaFile: string): string {
  const depth = schemaFile.split("/").length - 1;
  const climb = depth === 0 ? "./" : "../".repeat(depth);
  return `${climb}${SCHEMA_SHAPE_BASENAME}.js`;
}

/**
 * `.penv/env.ts` — the thin wrapper. It imports the shape from
 * `penv.schema.ts`, re-exports it so a type-only consumer can reach the schema
 * through `@env` without loading, and calls `load`. This is the module the
 * `@env`/`#env` alias resolves to and the module `schemaFile` names, so
 * application code still `import { env } from "@env"` exactly as before.
 *
 * The re-export is what keeps the harvester (loadSchema) working unchanged: it
 * reads the `schema` export of `schemaFile`, and the wrapper has one.
 */
export function renderEnvModule(schemaFile: string, inject = false): string {
  const loadComment = inject
    ? "// The loaded, validated values for the current environment. Import this in app\n" +
      "// code. `inject: true` also copies the values into process.env, for libraries\n" +
      "// that read process.env directly.\n"
    : "// The loaded, validated values for the current environment. Import this in app\n" +
      "// code. Importing it loads configuration and throws (naming the parameter and\n" +
      "// environment) if anything required is missing or invalid.\n";
  const loadCall = inject
    ? "export const env = load(schema, { inject: true });\n"
    : "export const env = load(schema);\n";

  return (
    `import { load } from "@penvhq/penv";\n` +
    `import { schema } from "${shapeSpecifier(schemaFile)}";\n` +
    `\n` +
    `// Re-exported so type-only consumers can import the shape through @env without\n` +
    `// triggering config loading — the shape itself lives in ${SCHEMA_SHAPE_FILE}.\n` +
    `export { schema };\n` +
    `\n` +
    loadComment +
    loadCall
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
      '  //   providers: { development: { type: "@penvhq/provider-filesystem" }, production: { type: "@penvhq/provider-vault" } },\n' +
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

  // Seal 3: what turns `penv run --env development -- pnpm dev` into
  // `penv run -- pnpm dev`. A declared decision, so invariant 10 is untouched —
  // this is not `NODE_ENV`, a branch name or a filename being believed.
  if (decisions.defaultEnvironment !== undefined) {
    body +=
      "\n  // The environment a command uses when `--env` is absent. A pipeline names\n" +
      "  // `--env` anyway: a deploy that leans on this is one edit from the wrong one.\n" +
      `  defaultEnvironment: ${JSON.stringify(decisions.defaultEnvironment)},\n`;
  }

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
 * Invariant 2, first half: the shape module `penv.schema.ts` is scaffolded once
 * and never regenerated. It holds the parameters (and the draft `penv import`
 * infers), so an existing one is the user's schema — keeping it, rather than
 * overwriting it, is the whole point.
 */
export function writeSchemaShapeFile(
  root: string,
  fields: readonly SchemaField[],
  draft: boolean,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const file = join(root, SCHEMA_SHAPE_FILE);
  if (existsSync(file)) {
    return {
      target: "schema",
      action: "kept",
      text: `Kept ${SCHEMA_SHAPE_FILE}`,
      note: "(yours — penv never regenerates it)",
    };
  }
  // A project scaffolded before the split keeps its `z.object` inside the module
  // `schemaFile` names (0.5+ also its `PenvSchemaShape` augmentation there), not
  // in a separate `penv.schema.ts`. Writing one now would stand a second, empty
  // `z.object` beside the real one — the second drifting schema invariant 2
  // forbids — and, for a 0.5+ layout, a duplicate `PenvSchemaShape` block that
  // fails to typecheck (TS2717). So the old file stays the one schema, and penv
  // says how to split it by hand rather than doing it destructively.
  const oldLayout = selfContainedSchemaModule(root, decisions.schemaFile);
  if (oldLayout !== undefined) {
    return {
      target: "schema",
      action: "conflicted",
      text: `Kept your schema in ${oldLayout}`,
      note:
        `(the shape lives there, from before the ${SCHEMA_SHAPE_FILE} split — penv did not add a ` +
        `second one. To adopt the split: move the \`z.object\` (and any \`declare module\` block) ` +
        `into ${SCHEMA_SHAPE_FILE}, leaving ${oldLayout} importing \`schema\` from it and calling \`load\`.)`,
    };
  }
  writeFileSync(file, renderSchemaShapeModule(fields, draft), "utf8");
  return {
    target: "schema",
    action: "created",
    text: `Generated ${SCHEMA_SHAPE_FILE}`,
    note: draft ? "(draft schema — review it, it's yours)" : "(the shape — yours to edit)",
  };
}

/**
 * Invariant 2, second half: the wrapper `.penv/env.ts` is scaffolded once and
 * never regenerated either. It is the module the alias resolves to and the
 * module `schemaFile` names, so it goes wherever the decisions put it — the
 * default `.penv/env.ts`, or a framework's `src/env.ts`. An existing one is the
 * user's, whatever penv would have written, and that holds at any path.
 */
export function writeEnvFile(root: string, decisions: InitDecisions = DEFAULT_DECISIONS): InitStep {
  const file = join(root, ...decisions.schemaFile.split("/"));
  if (existsSync(file)) {
    return {
      target: "env",
      action: "kept",
      text: `Kept ${decisions.schemaFile}`,
      note: "(yours — penv never regenerates it)",
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderEnvModule(decisions.schemaFile, decisions.inject), "utf8");
  return {
    target: "env",
    action: "created",
    text: `Generated ${decisions.schemaFile}`,
    note: "(loads the shape — yours to edit)",
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
 * The ignore file lives at the top of `state/`, over everything penv manages:
 * penv owns it outright, so it is rewritten when it drifts. A weakened ignore
 * file is how a plaintext secret gets committed, which invariant 20 exists to
 * prevent.
 */
export function writeGitignore(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
): InitStep {
  const file = join(root, ...STATE_GITIGNORE_PATH.split("/"));
  const wanted = renderStateGitignore(configOf(decisions));
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (existing === wanted) {
    return { target: "gitignore", action: "kept", text: `Kept ${STATE_GITIGNORE_PATH}` };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, wanted, "utf8");
  return {
    target: "gitignore",
    action: existing === undefined ? "created" : "updated",
    text: `${existing === undefined ? "Created" : "Updated"} ${STATE_GITIGNORE_PATH}`,
  };
}

/** The first `@penvhq/penv` release whose `load` honours `{ inject: true }`. */
const INJECT_MIN_VERSION = "0.6.0";

/**
 * A warning when the project's installed runtime is too old to honour
 * `{ inject: true }` — the option is ignored on an older `@penvhq/penv`, so the
 * seam would run and `process.env` would stay empty while init reported success.
 * `undefined` when the runtime is new enough, or absent (init may run before an
 * install, and penv does not warn about what it cannot see).
 */
function outdatedRuntimeWarning(root: string): string | undefined {
  const version = installedPenvVersion(root);
  if (version === undefined || !isBelow(version, INJECT_MIN_VERSION)) {
    return undefined;
  }
  return `Injection needs @penvhq/penv ${INJECT_MIN_VERSION}+ — this project has ${version}, whose \`load\` ignores \`{ inject: true }\`. Upgrade, or process.env stays empty.`;
}

function installedPenvVersion(root: string): string | undefined {
  const file = join(root, "node_modules", "@penvhq", "penv", "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const version = JSON.parse(readFileSync(file, "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The `[major, minor, patch]` of a semver, pre-release tag ignored, missing parts zero. */
function releaseTriple(version: string): [number, number, number] {
  const parts = (version.split("-")[0] ?? "").split(".");
  const at = (i: number) => Number.parseInt(parts[i] ?? "0", 10) || 0;
  return [at(0), at(1), at(2)];
}

/** True when semver `a` is strictly below `b`, comparing the release triple. */
function isBelow(a: string, b: string): boolean {
  const [am, an, ap] = releaseTriple(a);
  const [bm, bn, bp] = releaseTriple(b);
  if (am !== bm) return am < bm;
  if (an !== bn) return an < bn;
  return ap < bp;
}

/**
 * Places the injection seam for the detected framework — the file whose one
 * `import "@env"` runs before app code, so an injected `process.env` is populated
 * before a library reads it. penv scaffolds a fresh seam file, but never edits a
 * hook the user already owns: an existing file, or a framework with no file penv
 * can safely own, becomes a printed instruction instead. Returns nothing when
 * injection was not chosen. `framework` is passed by the command (which already
 * detected it) to avoid re-reading `package.json`; it falls back to detecting.
 */
export function writeSeam(
  root: string,
  decisions: InitDecisions = DEFAULT_DECISIONS,
  framework: string | undefined = detectFramework(root)?.name,
): InitStep | undefined {
  if (!decisions.inject) {
    return undefined;
  }
  const seam = seamFor(framework, {
    alias: decisions.alias,
    srcDir: srcPrefix(root),
    schemaFile: decisions.schemaFile,
  });

  // Regardless of the seam's shape, `env.ts` now carries `{ inject: true }`, so an
  // outdated runtime is the same silent no-op everywhere — warn once, here.
  const outdated = outdatedRuntimeWarning(root);

  if (seam.kind === "none") {
    return { target: "seam", action: "info", text: "No injection seam needed", note: seam.reason };
  }
  if (seam.kind === "instruct") {
    return {
      target: "seam",
      action: "info",
      text: "Place the injection seam",
      note: withWarning(seam.instruction, outdated),
    };
  }

  // A companion file the seam also needs (Bun's bunfig.toml). Same rule: write it
  // when absent, otherwise print where to add the entry. Its outcome joins the
  // seam step's note, so the whole setup is one line to read.
  const alsoNote = writeAlso(root, seam.also);

  const file = join(root, ...seam.file.split("/"));
  const baseNotes = [...seam.notes, ...(alsoNote === undefined ? [] : [alsoNote])];
  const notes = baseNotes.length === 0 ? "" : `\n${baseNotes.map((n) => `  ${n}`).join("\n")}`;
  if (existsSync(file)) {
    return {
      target: "seam",
      action: "info",
      text: `Add the injection seam to ${seam.file}`,
      note: withWarning(`${seam.ifPresent}${notes}`, outdated),
    };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, seam.content, "utf8");
  return {
    target: "seam",
    action: outdated === undefined ? "created" : "info",
    text: `Wrote ${seam.file} (runs the injection before your app)`,
    ...(notes === "" && outdated === undefined
      ? {}
      : { note: withWarning(notes.trimStart(), outdated) }),
  };
}

/**
 * The companion file (Bun's `bunfig.toml`), written when absent and reported as a
 * note; when present it is the user's, so the note tells them where to add the
 * entry rather than penv editing their config. `undefined` when there is none.
 */
function writeAlso(root: string, also: ScaffoldSeam["also"]): string | undefined {
  if (also === undefined) {
    return undefined;
  }
  const file = join(root, ...also.file.split("/"));
  if (existsSync(file)) {
    return also.ifPresent;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, also.content, "utf8");
  return `Wrote ${also.file} to register it.`;
}

/** Appends a runtime warning to a seam note, when there is one. */
function withWarning(note: string, warning: string | undefined): string {
  if (warning === undefined) {
    return note;
  }
  return note === "" ? warning : `${note}\n  ⚠ ${warning}`;
}

/** Everything `init` scaffolds, in the order it is reported. */
export function scaffold(
  root: string,
  fields: readonly SchemaField[],
  draft: boolean,
  decisions: InitDecisions = DEFAULT_DECISIONS,
  framework: string | undefined = detectFramework(root)?.name,
): InitStep[] {
  const steps = [
    ensurePenvDir(root),
    // The shape at the root, then the wrapper that loads it — both write-once.
    // The shape step needs the decisions too: an old-layout `schemaFile` already
    // holds the shape, and a second `penv.schema.ts` beside it would not compile.
    writeSchemaShapeFile(root, fields, draft, decisions),
    writeEnvFile(root, decisions),
    writeConfigFile(root, decisions),
    writeTsconfigAlias(root, decisions),
    writeGitignore(root, decisions),
  ];
  const seam = writeSeam(root, decisions, framework);
  return seam === undefined ? steps : [...steps, seam];
}

/*
 * The cutover.
 *
 * Everything from here down is all-or-nothing by construction: `planCutover`
 * reads and checks, `applyCutover` writes and moves, and nothing between them
 * decides anything. That split is what lets a preflight failure be a refusal
 * with no cleanup to do.
 */

/** The environment `--yes` takes and the file list preselects. */
export const DEVELOPMENT = "development";

/** The provider a scaffolded environment reads from until the project says otherwise. */
const LOCAL_PROVIDER = "@penvhq/provider-filesystem";

/** One adopted file: what it holds, and the scope its values are written at. */
interface Adopted {
  readonly file: DotenvFile;
  readonly entries: readonly DotenvEntry[];
  readonly refs: readonly ParameterRef[];
  readonly scope: Scope;
}

export interface AdoptionPlan {
  readonly root: string;
  /** Every dotenv file penv found, in the order the list shows them. */
  readonly found: readonly DotenvFile[];
  /** Checked when the list is first shown: the development cascade, where it exists. */
  readonly preselected: readonly string[];
}

/** What there is to adopt, and what penv proposes taking. */
export function planAdoption(root: string): AdoptionPlan {
  const found = discoverDotenvFiles(root);
  return {
    root,
    found,
    preselected: found
      .filter((file) => file.environment === undefined || file.environment === DEVELOPMENT)
      .map((file) => file.name),
  };
}

/** The scope a file's values are written at — invariant 4's four levels, unchanged. */
function scopeOf(file: DotenvFile): Scope {
  if (file.kind === "shared") {
    return { kind: "unscoped" };
  }
  if (file.kind === "local") {
    return { kind: "local" };
  }
  const environment = file.environment ?? "";
  return file.kind === "environment"
    ? { kind: "environment", environment }
    : { kind: "environment-local", environment };
}

export interface CutoverPlan {
  readonly root: string;
  readonly selected: readonly DotenvFile[];
  readonly adopted: readonly Adopted[];
  /** The whitelist after this cutover — what the config declares, or is about to. */
  readonly environments: readonly string[];
  /**
   * The environments this cutover is *about*: the ones its files name. Narrower
   * than the whitelist on a project that already declared more, and the ones the
   * draft is judged against and the import is validated for — an environment
   * this cutover did not touch must not fail it for a state it was already in.
   */
  readonly adopting: readonly string[];
  readonly decisions: InitDecisions;
  readonly fields: readonly DraftField[];
  readonly variables: number;
  /** Values the parser read but that look like a mistake. Shown, never fixed. */
  readonly diagnostics: readonly DotenvDiagnostic[];
  readonly install: InstallPlan;
  readonly framework: string | undefined;
  /** True when `penv.config.ts` already existed, so init keeps every decision it records. */
  readonly configured: boolean;
}

export interface CutoverInput {
  readonly root: string;
  /** What init would scaffold anyway: detection, the schema's home, the alias. */
  readonly base: InitPlan;
  readonly selected: readonly DotenvFile[];
  /** The environment named when the selection declares none — `.env` alone declares nothing. */
  readonly environment?: string;
  /** The `@penvhq/penv` version to pin. Defaults to this engine's own. */
  readonly version?: string;
  readonly inject?: boolean;
}

/**
 * Everything a cutover needs, checked before anything is written.
 *
 * The order is the order the failures matter in: an unresolved bundle first
 * (there is nothing to plan on top of it), then what the selection declares,
 * then whether the selection is complete, then every variable name, and only
 * then the schema and the install. Each one throws, so the caller has a plan or
 * a refusal and never a half-answer.
 */
export function planCutover(input: CutoverInput): CutoverPlan {
  const { root, base } = input;
  assertBundleResolved(root);

  const selected = [...input.selected];
  if (selected.length === 0) {
    throw new PenvError(
      "INIT_NOTHING_SELECTED",
      "No dotenv file was selected, so there is nothing to migrate",
      "Run `penv init` again and choose the files penv should adopt.",
    );
  }

  const declared = declaredIn(root);
  const named = environmentsDeclaredBy(selected);
  const chosen = named.length > 0 ? named : [requireEnvironment(input)];
  const environments = declared === undefined ? chosen : declared.environments;
  for (const environment of chosen) {
    if (!environments.includes(environment)) {
      throw new PenvError(
        "INIT_ENVIRONMENT_UNDECLARED",
        `${CONFIG_FILE} declares ${describeList(environments)}, and adopting these files needs \`${environment}\` declared too`,
        `Add \`${environment}\` to \`environments\` in ${CONFIG_FILE}, with a provider for it, then run \`penv init\` again. Nothing was changed.`,
      );
    }
  }

  const defaultEnvironment =
    declared === undefined ? proposedDefault(chosen) : declared.defaultEnvironment;
  const decisions: InitDecisions = {
    ...base.decisions,
    environments,
    ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
    ...(input.inject === undefined ? {} : { inject: input.inject }),
  };

  // The config init is about to write, judged by the same validator `penv
  // validate` will judge it by — before it exists, rather than after.
  const config = declared ?? configFor(decisions);
  const configError = validateConfig(config)[0];
  if (configError !== undefined) {
    throw configError;
  }

  assertCascadeComplete(root, selected, chosen);

  const adopted: Adopted[] = [];
  const refs: ParameterRef[] = [];
  const diagnostics: DotenvDiagnostic[] = [];
  let variables = 0;
  for (const file of selected) {
    const parsed = parseDotenv(readFileSync(join(root, file.name), "utf8"));
    const fileRefs = refsForEntries(parsed.entries, file.name, config);
    adopted.push({ file, entries: parsed.entries, refs: fileRefs, scope: scopeOf(file) });
    refs.push(...fileRefs);
    diagnostics.push(...parsed.diagnostics);
    variables += parsed.entries.length;
  }
  // Invariant 12, across the whole cutover rather than one file at a time: two
  // files may each be fine and still map two parameters to one variable. One
  // parameter written at four scopes is not that — `DATABASE_URL` in `.env` and
  // in `.env.development.local` is the cascade doing its job — so the refs are
  // deduplicated first.
  assertNoCollisions(distinct(refs), config);

  const fields = draftFieldsAcross(
    adopted.map((entry) => ({
      ...(entry.file.environment === undefined ? {} : { environment: entry.file.environment }),
      entries: entry.entries,
    })),
    chosen,
  );

  return {
    root,
    selected,
    adopted,
    environments,
    adopting: chosen,
    decisions,
    fields,
    variables,
    diagnostics,
    install: planInstall(root, input.version),
    framework: base.detected?.name,
    configured: declared !== undefined,
  };
}

/**
 * Seal 3, decided once: `development` when the development cascade was adopted,
 * and otherwise the single environment this cutover is about. Two or more
 * environments and no development among them is a project whose daily
 * environment penv cannot know, so it declares none and `--env` keeps its job.
 */
function proposedDefault(chosen: readonly string[]): string | undefined {
  if (chosen.includes(DEVELOPMENT)) {
    return DEVELOPMENT;
  }
  return chosen.length === 1 ? chosen[0] : undefined;
}

/** One entry per parameter, whatever number of scopes it was seen at. */
function distinct(refs: readonly ParameterRef[]): ParameterRef[] {
  const seen = new Map<string, ParameterRef>();
  for (const ref of refs) {
    seen.set(parameterId(ref), ref);
  }
  return [...seen.values()];
}

function configFor(decisions: InitDecisions): PenvConfig {
  return {
    environments: decisions.environments,
    providers: Object.fromEntries(
      decisions.environments.map((environment) => [environment, { type: LOCAL_PROVIDER }]),
    ),
    schemaFile: decisions.schemaFile,
    ...(decisions.defaultEnvironment === undefined
      ? {}
      : { defaultEnvironment: decisions.defaultEnvironment }),
    ...(decisions.publicPrefixes.length === 0
      ? {}
      : { publicPrefixes: [...decisions.publicPrefixes] }),
  };
}

function describeList(names: readonly string[]): string {
  return names.length === 0 ? "no environments" : names.map((name) => `\`${name}\``).join(", ");
}

/**
 * `.env` alone declares no environment (PRD §6), and penv will not pick one for
 * it. The caller asks; this is the guard that the answer arrived.
 */
function requireEnvironment(input: CutoverInput): string {
  const environment = input.environment?.trim() ?? "";
  if (environment.length > 0) {
    return environment;
  }
  throw new PenvError(
    "INIT_ENVIRONMENT_UNNAMED",
    "The selected files name no environment, and penv does not invent one",
    `Run \`penv init --env ${DEVELOPMENT}\` to say which environment these values are for.`,
  );
}

/**
 * PRD §6: every framework-discoverable file in an adopted environment's cascade
 * has to come too. Adopting `.env.development` while leaving `.env` behind
 * leaves the framework loading values penv does not hold — a project with two
 * live sources, which is the state a complete cutover exists to prevent.
 */
function assertCascadeComplete(
  root: string,
  selected: readonly DotenvFile[],
  environments: readonly string[],
): void {
  const present = new Set(discoverDotenvFiles(root).map((file) => file.name));
  const taken = new Set(selected.map((file) => file.name));
  for (const environment of environments) {
    for (const name of cascadeFor(environment)) {
      if (present.has(name) && !taken.has(name)) {
        throw new PenvError(
          "INIT_CUTOVER_INCOMPLETE",
          `${name} is part of ${environment}'s cascade and was not selected, so your framework would keep reading it beside penv`,
          "Run `penv init` again and take every file penv listed for that environment. Nothing was changed.",
        );
      }
    }
  }
}

/**
 * A second migration over an unresolved bundle would bury the first one's files.
 *
 * The bundle decides, not the record: an interrupted cutover can leave files in
 * it, and keying this off `cutover.json` alone let a re-run write a fresh record
 * naming only the files that had not moved yet.
 */
function assertBundleResolved(root: string): void {
  if (!bundleUnresolved(root)) {
    return;
  }
  throw new PenvError(
    "INIT_BUNDLE_UNRESOLVED",
    `The dotenv files from the last cutover are still in ${ROLLBACK_DOTENV_PATH}/, and penv will not migrate a second time over them`,
    "Run `penv init undo` to put them back, or `penv cleanup` to drop them once you are happy with the migration.",
  );
}

/**
 * `--yes` takes the development cascade, and refuses when another environment is
 * leaning on the shared `.env` this cutover would move (PRD §6). Which files
 * that environment should keep is a decision, and `--yes` means "I trust your
 * defaults", never "decide my other environments for me".
 */
export function selectionForYes(plan: AdoptionPlan): DotenvFile[] {
  const shared = plan.found.find((file) => file.kind === "shared");
  const other = plan.found.find(
    (file) => file.environment !== undefined && file.environment !== DEVELOPMENT,
  );
  if (shared !== undefined && other !== undefined) {
    throw new PenvError(
      "INIT_YES_SHARED_FALLBACK",
      `${other.name} falls back to the shared ${shared.name} this cutover would move, so \`--yes\` will not decide what happens to ${other.environment ?? ""}`,
      "Run `penv init` without `--yes` and choose every file the cutover takes. Nothing was changed.",
    );
  }
  return plan.found.filter((file) => plan.preselected.includes(file.name));
}

export interface CutoverResult {
  readonly plan: CutoverPlan;
  readonly steps: readonly InitStep[];
  /** The dotenv files moved into the bundle, by name. */
  readonly moved: readonly string[];
  /** The environments whose imported values were validated before the move. */
  readonly validated: readonly string[];
}

export interface CutoverOptions {
  /** Injected in tests: how the runtime dependency is installed. Never spawns there. */
  readonly install?: InstallRuntime;
}

/**
 * Installs, scaffolds, imports, validates — and only then moves the dotenv
 * files aside. The order is the guarantee: every step before the move leaves a
 * project whose `.env` files are exactly where they were, so a refusal at any
 * of them costs a re-run and nothing else.
 */
export async function applyCutover(
  plan: CutoverPlan,
  options: CutoverOptions = {},
): Promise<CutoverResult> {
  if (!plan.install.satisfied) {
    await (options.install ?? installWithPackageManager)(plan.install);
  }

  const steps = scaffold(plan.root, plan.fields, true, plan.decisions, plan.framework);
  const project = openProject(plan.root);
  const tree = localTree(project);
  for (const adopted of plan.adopted) {
    writeEntries(tree, adopted.entries, adopted.refs, adopted.scope);
  }

  // Every environment this cutover adopted, not just the daily one: the draft is
  // the weakest shape all of them satisfy, so if one of them does not, the draft
  // is wrong and the files must stay where they are. An environment the cutover
  // did not touch is not judged here — it was already in whatever state it was in.
  for (const environment of plan.adopting) {
    const check = await checkEnvironment(project, environment);
    if (!check.result.ok) {
      throw invalidAfterImport(check.result);
    }
  }

  const cutover = bundleDotenvFiles(
    plan.root,
    plan.selected.map((file) => file.name),
    plan.environments,
  );
  return { plan, steps, moved: cutover.files, validated: plan.adopting };
}

function invalidAfterImport(result: ValidateResult): PenvError {
  const lines = result.issues.map((issue) => `  ${issue.subject}: ${issue.message}`).join("\n");
  return new PenvError(
    "INIT_CUTOVER_INVALID",
    `The imported values do not satisfy the draft schema for ${result.environment}, so your dotenv files were left where they are:\n${lines}`,
    `Correct ${SCHEMA_SHAPE_FILE} or the values above, then run \`penv init\` again.`,
  );
}

/*
 * The cutover's screens.
 */

/** The file list, checkboxes and all — the one screen the selection is made on. */
export function renderSelection(
  plan: AdoptionPlan,
  selected: readonly string[] = plan.preselected,
): string[] {
  const rows = plan.found.map((file) => [
    `  ${selected.includes(file.name) ? "[x]" : "[ ]"}`,
    file.name,
    out.dim(file.label),
  ]);
  return [out.bold("Found dotenv files. Which should penv adopt?"), "", ...columns(rows), ""];
}

/** The plan, and the install it is conditional on. Nothing here has happened yet. */
export function renderCutoverPlan(plan: CutoverPlan): string[] {
  const required = plan.fields.filter((field) => field.required).length;
  const optional = plan.fields.length - required;
  const rows: string[][] = [
    [`  ${out.dim("environments")}`, out.cyan(`[${plan.environments.join(", ")}]`), ""],
  ];
  if (plan.decisions.defaultEnvironment !== undefined) {
    rows.push([
      `  ${out.dim("default")}`,
      plan.decisions.defaultEnvironment,
      out.dim("← so `penv run -- pnpm dev` needs no --env"),
    ]);
  }
  rows.push([
    `  ${out.dim("schema")}`,
    `${plan.fields.length} parameters`,
    out.dim(`← ${required} required, ${optional} optional — a draft you own`),
  ]);
  rows.push([
    `  ${out.dim("values")}`,
    `${RECORDS_PATH}/`,
    out.dim(`← from ${plan.variables} variables`),
  ]);
  rows.push([
    `  ${out.dim("dotenv")}`,
    `${ROLLBACK_DOTENV_PATH}/`,
    out.dim("← recoverable with `penv init undo`"),
  ]);

  return [
    out.bold("The cutover"),
    "",
    ...columns(rows),
    "",
    ...plan.diagnostics.map((diagnostic) => `${out.yellow(WARN)} ${diagnostic.detail}`),
    ...(plan.diagnostics.length === 0 ? [] : [""]),
    ...renderInstallPlan(plan.install),
    "",
  ];
}

/** What actually happened, and the one command the project starts through now. */
export function renderCutover(result: CutoverResult): string[] {
  const { plan } = result;
  const plural = plan.environments.length === 1 ? "environment" : "environments";
  const steps: Step[] = [
    {
      glyph: plan.configured ? WARN : CHECK,
      text: `Declared ${plural}`,
      note: plan.configured
        ? `${plan.environments.join(", ")} (already in ${CONFIG_FILE} — penv kept it)`
        : plan.environments.join(", "),
    },
    ...result.steps.map((step) => {
      const glyph = step.action === "conflicted" ? WARN : step.action === "info" ? "→" : CHECK;
      return step.note === undefined
        ? { glyph, text: step.text }
        : { glyph, text: step.text, note: step.note };
    }),
    ...(plan.install.satisfied
      ? []
      : [{ glyph: CHECK, text: `Installed ${plan.install.package}`, note: plan.install.version }]),
    {
      glyph: CHECK,
      text: `Imported ${plan.fields.length} parameters`,
      note: `into ${RECORDS_PATH}/`,
    },
    { glyph: CHECK, text: `Validated ${result.validated.join(", ")}` },
    {
      glyph: CHECK,
      text: `Moved ${result.moved.length} dotenv ${result.moved.length === 1 ? "file" : "files"}`,
      note: `${ROLLBACK_DOTENV_PATH}/ (penv init undo restores them)`,
    },
  ];

  return [
    ...formatSteps(steps),
    "",
    `${out.green(CHECK)} ${out.bold("Done.")} Start your app with penv:`,
    tip(out.cyan(dailyCommand(plan.root))),
  ];
}

/**
 * The daily command, shown and never written (seal 1 as amended). penv cannot
 * compose a script line containing a command it did not write, and wrapping
 * inside a script would run `pre*`/`post*` hooks outside penv's environment — so
 * the wrapper stays outside, and this is copy.
 */
export function dailyCommand(root: string): string {
  return `penv run -- ${detectPackageManager(root)} ${devScript(root)}`;
}

/** The script the project already has, so the line shown is one the reader can paste. */
function devScript(root: string): string {
  const file = join(root, PACKAGE_FILE);
  if (!existsSync(file)) {
    return "dev";
  }
  try {
    const scripts: unknown = JSON.parse(readFileSync(file, "utf8")).scripts;
    if (scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)) {
      const named = Object.keys(scripts);
      return ["dev", "start"].find((script) => named.includes(script)) ?? named[0] ?? "dev";
    }
  } catch {
    // An unreadable manifest is not a reason to print nothing: `dev` is what the
    // reader will recognise, and the line is copy either way.
  }
  return "dev";
}

export function runInit(options: InitOptions): InitResult {
  const root = resolve(options.cwd);
  const decisions = options.decisions ?? planInit(root).decisions;
  // `options.framework` is the name the command already detected; passing it (or
  // `undefined`, which lets `scaffold` detect) avoids a second `package.json` read.
  return { root, decisions, steps: scaffold(root, [], false, decisions, options.framework) };
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
  // The shape is in `penv.schema.ts` for a project on the split, but a project
  // whose old-layout schema init just kept (the `conflicted` step) still holds it
  // in `schemaFile` — penv wrote no `penv.schema.ts` there, so pointing at one
  // would name a file that does not exist.
  const schemaStep = result.steps.find((step) => step.target === "schema");
  const shapeFile =
    schemaStep?.action === "conflicted" ? result.decisions.schemaFile : SCHEMA_SHAPE_FILE;
  return [
    ...formatSteps(steps),
    "",
    `${out.green(CHECK)} ${out.bold("Done.")} Declare your parameters in ${shapeFile}, then:`,
    tip(out.cyan("penv set <key>")),
    ...(result.decisions.environments.length === 0
      ? [
          `Then declare your environments in ${CONFIG_FILE}: penv leaves the whitelist empty ` +
            `rather than inventing one, and every command needs it.`,
        ]
      : []),
  ];
}

/*
 * The cutover conversation: one screen at a time, and every answer a decision
 * penv could not observe. The io is a parameter throughout, so the tests drive
 * the conversation without a terminal.
 */

/**
 * The files to adopt. `undefined` is the developer declining, which is an
 * outcome and not a failure — nothing is written and the run says so.
 *
 * Enter takes the checked list, because the checked list is the complete
 * development cascade and taking all of it is what makes the cutover complete.
 */
export async function promptForSelection(
  plan: AdoptionPlan,
  io: PromptIo,
): Promise<DotenvFile[] | undefined> {
  for (const line of renderSelection(plan)) {
    io.write(line);
  }

  const answer = (await io.ask(prompt("files", "Enter to take the checked ones"))).trim();
  if (answer.toLowerCase() === "none") {
    return undefined;
  }
  const names =
    answer.length === 0
      ? plan.preselected
      : answer.toLowerCase() === "all"
        ? plan.found.map((file) => file.name)
        : answer
            .split(/[\s,]+/)
            .map((name) => name.trim())
            .filter((name) => name.length > 0);

  const selected: DotenvFile[] = [];
  for (const name of names) {
    const file = plan.found.find((candidate) => candidate.name === name);
    if (file === undefined) {
      throw new PenvError(
        "INIT_SELECTION_UNKNOWN",
        `\`${name}\` is not one of the dotenv files penv found`,
        "Run `penv init` again and name the files exactly as they are listed, e.g. `.env.production`.",
      );
    }
    selected.push(file);
  }
  return selected.length === 0 ? undefined : selected;
}

/**
 * Which environment a selection that declares none is for. Offered, never
 * assumed: `development` is the answer for almost every project adopting a plain
 * `.env`, and pressing Enter is the developer giving it.
 */
export async function askEnvironment(io: PromptIo, offered: string): Promise<string> {
  io.write("");
  io.write("Selecting `.env` alone declares no environment, and penv never infers one.");
  const answer = (await io.ask(prompt("environment", `Enter for ${offered}`))).trim();
  return answer.length === 0 ? offered : answer;
}

/** The last question before anything is written. */
async function askProceed(io: PromptIo): Promise<boolean> {
  const answer = (await io.ask(prompt("Proceed?", "Y/n"))).trim().toLowerCase();
  return answer.length === 0 || answer === "y" || answer === "yes";
}

/** A terminal, or `undefined` when there is nobody to ask. */
function terminal(): { readonly io: PromptIo; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    io: {
      ask: (question) => rl.question(question),
      write: (line) => process.stdout.write(`${line}\n`),
    },
    close: () => rl.close(),
  };
}

/** The prompt runs only against a real terminal; anything else has nobody to ask. */
async function askOnTty(plan: InitPlan): Promise<InitDecisions | undefined> {
  const rl = terminal();
  try {
    return await promptForDecisions(plan, rl.io);
  } finally {
    rl.close();
  }
}

/** The scaffold-only path: a project with no dotenv files to adopt. */
async function scaffoldOnly(root: string, plan: InitPlan, asked: boolean): Promise<void> {
  const decisions = asked ? await askOnTty(plan) : plan.decisions;
  if (decisions === undefined) {
    write(["Nothing written. Re-run `penv init` when you want to scaffold."]);
    return;
  }
  if (!asked) {
    write([...plan.notes, ""]);
  }
  write(
    renderInit(
      runInit({ cwd: root, decisions, ...(plan.detected && { framework: plan.detected.name }) }),
    ),
  );
}

/** The cutover path, asked one screen at a time. */
async function cutoverInteractively(
  root: string,
  base: InitPlan,
  adoption: AdoptionPlan,
): Promise<void> {
  const rl = terminal();
  let plan: CutoverPlan;
  let inject = false;
  try {
    const selected = await promptForSelection(adoption, rl.io);
    if (selected === undefined) {
      write(["Nothing written. Re-run `penv init` when you want to migrate."]);
      return;
    }
    const named = environmentsDeclaredBy(selected);
    const environment =
      named.length > 0 ? undefined : await askEnvironment(rl.io, offeredEnvironment(root));

    plan = planCutover({
      root,
      base,
      selected,
      ...(environment === undefined ? {} : { environment }),
    });
    for (const line of renderCutoverPlan(plan)) {
      rl.io.write(line);
    }
    if (!(await askProceed(rl.io))) {
      write(["Nothing written. Re-run `penv init` when you want to migrate."]);
      return;
    }
    inject = seamKindFor(base) === "none" ? false : await askInject(rl.io);
  } finally {
    rl.close();
  }

  write([""]);
  write(renderCutover(await applyCutover({ ...plan, decisions: { ...plan.decisions, inject } })));
}

/** What the environment question offers: what the project already declared, else development. */
function offeredEnvironment(root: string): string {
  const declared = declaredIn(root);
  if (declared === undefined) {
    return DEVELOPMENT;
  }
  return (
    declared.defaultEnvironment ??
    (declared.environments.includes(DEVELOPMENT)
      ? DEVELOPMENT
      : (declared.environments[0] ?? DEVELOPMENT))
  );
}

/** `penv init --yes`: the development cascade, the filesystem provider, and no questions. */
async function cutoverWithYes(root: string, base: InitPlan, adoption: AdoptionPlan): Promise<void> {
  const selected = selectionForYes(adoption);
  const plan = planCutover({ root, base, selected, environment: DEVELOPMENT });
  write([...renderCutoverPlan(plan), ""]);
  write(renderCutover(await applyCutover(plan)));
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Adopt your dotenv files, or scaffold a project (.penv/, env.ts, config, @env)",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "`undo` puts the dotenv files of the last cutover back, under their exact names",
    },
    yes: {
      type: "boolean",
      description:
        `Take the development cascade and the ${LOCAL_PROVIDER} provider without asking. It ` +
        "never invents production, staging or preview",
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
      if (args.action !== undefined) {
        runUndoAction(root, String(args.action));
        return;
      }

      const environments = environmentsFromFlag(args.env);
      const adoption = planAdoption(root);
      // The `--yes` default is for a project with nothing to adopt; where there
      // is a cascade, the files declare the environments and the flag only means
      // "take the checked ones".
      const bare = adoption.found.length === 0;
      const plan = planInit(root, {
        ...(args.schema === undefined ? {} : { schema: args.schema }),
        ...(args.alias === undefined ? {} : { alias: args.alias }),
        ...(environments === undefined ? {} : { environments }),
        ...(bare && args.yes === true ? { yes: true } : {}),
      });

      const tty = process.stdin.isTTY === true;
      if (bare) {
        // No terminal is not a reason to guess: it is a reason to take the
        // defaults and say what they were, so a CI log carries the decisions.
        await scaffoldOnly(root, plan, tty && args.yes !== true && environments === undefined);
        return;
      }
      if (args.yes === true) {
        await cutoverWithYes(root, plan, adoption);
        return;
      }
      if (!tty) {
        // A cutover moves the developer's files, so it is never taken by a
        // script that did not ask for it. The plan is printed; nothing is done.
        write([...renderSelection(adoption), "penv found dotenv files to migrate."]);
        write([tip(out.cyan("penv init --yes"))]);
        return;
      }
      await cutoverInteractively(root, plan, adoption);
    });
  },
});

/** `penv init undo` — the only positional this command takes. */
function runUndoAction(root: string, action: string): void {
  if (action !== "undo") {
    throw new PenvError(
      "INIT_UNKNOWN_ACTION",
      `\`penv init ${action}\` is not something init does`,
      "Run `penv init undo` to put back the dotenv files of the last cutover.",
    );
  }
  const result = runUndo({ cwd: root });
  write([
    ...formatSteps([
      ...result.restored.map((name) => ({
        glyph: CHECK,
        text: `Restored ${name}`,
        note: `from ${ROLLBACK_DOTENV_PATH}/`,
      })),
      ...result.alreadyBack.map((name) => ({
        glyph: CHECK,
        text: `${name} was already back`,
        note: "put there by an earlier undo",
      })),
      ...result.missing.map((name) => ({
        glyph: WARN,
        text: `${name} is gone`,
        note: "not in the bundle, not at the project root",
      })),
    ]),
    "",
    result.missing.length === 0
      ? `${out.green(CHECK)} ${out.bold("Undone.")} Your dotenv files are back exactly as they were, and ` +
        `${CUTOVER_PATH} is gone.`
      : `${out.yellow(WARN)} ${out.bold("Undone as far as penv could.")} Everything still in the bundle is back, and ` +
        `${CUTOVER_PATH} is gone.`,
    `penv's records are still in ${RECORDS_PATH}/ — nothing penv scaffolded is yours to lose.`,
  ]);
}
