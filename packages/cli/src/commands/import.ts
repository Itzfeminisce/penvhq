/**
 * `penv import <file>` — adopt an existing dotenv file.
 *
 * Invariant 15: this is one-directional. After it runs, `.penv/` is the source of
 * truth and `.env` is an artifact `penv generate` writes; there is no reverse
 * sync of hand-edits back out of the generated file.
 *
 * It takes one file; `penv init` takes a whole cascade in one cutover. The
 * checks and the write they share live in `adopt.ts`.
 *
 * Scope, unlike namespace, *is* readable from the source: the filename says it,
 * in the four-level vocabulary invariant 4 adopts wholesale. `.env.production`
 * carries `production` the way `.env` carries nothing, so import reads it rather
 * than flattening it — a `.env.development.local` written to the unscoped default
 * would serve every environment, and one developer's machine would become
 * production's fallback.
 *
 * `--env` is the other half of that reading. A file the filename says nothing
 * about — `prod-secrets.txt`, or a plain `.env` the user is adopting as one
 * environment's values — has its scope named by the flag instead, because "these
 * are production's values" is what `--env production` means at an import. Only a
 * file that names neither is the unscoped default.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { PenvConfig, Scope } from "@penvhq/core";
import {
  assertNever,
  environmentNames,
  FilenameGrammarError,
  findConfigFile,
  loadConfigFrom,
  lookupEnvironment,
  PenvError,
  parseDotenv,
  schemaFileOf,
  UnknownEnvironmentError,
} from "@penvhq/core";
import { defineCommand } from "citty";
import { assertNoCollisions, refsForEntries, writeEntries } from "../adopt.js";
import { detectAlias } from "../detect.js";
import { draftFields } from "../draft-schema.js";
import { localTree, openProject } from "../project.js";
import { CHECK, formatSteps, guard, type Step, WARN, write } from "../ui.js";
import type { InitDecisions, InitStep } from "./init.js";
import { planInit, scaffold, writeConfigFile } from "./init.js";
import type { ValidateResult } from "./validate.js";
import { renderValidate, runValidate } from "./validate.js";

export interface ImportOptions {
  readonly cwd: string;
  /** The dotenv file to adopt, absolute or relative to `cwd`. */
  readonly file: string;
  /**
   * `--env`. It reads as "these are <environment>'s values", so for a file whose
   * name carries no environment it names the *scope* as well as the environment
   * to run against: `penv import prod-secrets.txt --env production` writes
   * `<name>.production`, and `--env production` on `.env.local` writes
   * `<name>.production.local`. The filename supplies both when it carries an
   * environment, so the flag is needed only for a file that does not — and
   * contradicting the filename is an error rather than a silent choice between
   * the two.
   */
  readonly environment?: string;
}

export interface ImportReport {
  readonly root: string;
  readonly file: string;
  readonly backup: string;
  /** The scope the source named — filename, `--env`, or both — and the scope every value was written at. */
  readonly scope: Scope;
  /**
   * The environment the import ran against, or `undefined` when none is set.
   *
   * Undefined only ever accompanies the unscoped default: any other scope names
   * an environment, so it always has one. It means the values were written and
   * the closing validation was skipped, which the output states.
   */
  readonly environment: string | undefined;
  /** The declared environments, so a skipped validation can name one to pass. */
  readonly environments: readonly string[];
  readonly variables: number;
  /**
   * Comment blocks that belonged to no variable. Reported rather than discarded
   * silently: a file header has no parameter to describe, but that is not a
   * reason to pretend it was never there.
   */
  readonly orphanComments: number;
  readonly steps: readonly InitStep[];
}

const BACKUP_SUFFIX = ".backup";

/** The segment that starts a dotenv filename's scope. `.env`, `.env.production`. */
const DOTENV_SEGMENT = "env";
const LOCAL = "local";

/**
 * Invariant 10: a segment is an environment because `penv.config.ts` declares
 * it, never because it looks like one. This matches the whitelist — the thing
 * the invariant permits — and refuses everything else.
 *
 * Refusing is the whole point. Falling back to the unscoped default for an
 * undeclared segment is precisely the leak: `.env.staging` in a project that
 * never declared `staging` would become the value every environment reads.
 */
function assertDeclared(segment: string, config: PenvConfig): string {
  const declared = environmentNames(config);
  if (declared.includes(segment)) {
    return segment;
  }
  throw new UnknownEnvironmentError(segment, declared);
}

/**
 * The scope the source filename names, in the vocabulary invariant 4 shares with
 * Next.js and Vite: `.env` > unscoped, `.env.<env>`, `.env.local`, and
 * `.env.<env>.local`.
 *
 * Parsing starts at the first `env` segment, because `import` reads whatever
 * file it is pointed at and the basename may carry a prefix. A file with no
 * `env` segment at all is the plain-`.env` case — there is no scope written on
 * it, so there is none to read, and the unscoped default is what it means.
 */
function scopeFromFilename(file: string, config: PenvConfig): Scope {
  const name = basename(file);
  const segments = name.split(".");
  const start = segments.indexOf(DOTENV_SEGMENT);
  if (start === -1) {
    return { kind: "unscoped" };
  }

  const rest = segments.slice(start + 1).filter((segment) => segment.length > 0);
  const first = rest[0];
  const second = rest[1];

  if (first === undefined) {
    return { kind: "unscoped" };
  }

  if (second === undefined) {
    if (first === LOCAL) {
      return { kind: LOCAL };
    }
    return { kind: "environment", environment: assertDeclared(first, config) };
  }

  if (rest.length === 2 && second === LOCAL && first !== LOCAL) {
    return { kind: "environment-local", environment: assertDeclared(first, config) };
  }

  // The order is fixed at both ends of the import: the environment precedes
  // `local` in the dotenv filename this reads and in the value filename it
  // writes, so `.env.local.production` is an error rather than a synonym.
  if (first === LOCAL && rest.length === 2) {
    throw new FilenameGrammarError(
      name,
      "`local` precedes the environment segment",
      `The environment segment always precedes \`local\` — \`.env.${second}.${LOCAL}\` is the ` +
        `file Next.js and Vite read, and \`.env.${LOCAL}.${second}\` is not a synonym for it. ` +
        `Rename it to \`.env.${second}.${LOCAL}\`, then import it again. Nothing was imported.`,
    );
  }

  throw new FilenameGrammarError(
    name,
    `\`${rest.join("` and `")}\` are ${rest.length} scope segments`,
    "A dotenv file carries exactly one scope: `.env`, `.env.<environment>`, `.env.local`, or " +
      "`.env.<environment>.local`. Point `penv import` at one of those. Nothing was imported.",
  );
}

/**
 * The environment a scope names, or `undefined` when it names none.
 *
 * The `default` is load-bearing rather than ceremonial: a fifth scope carrying
 * an environment would otherwise report `undefined` here, and import would fall
 * back to `--env` — silently widening exactly the way the three-level cascade did.
 */
function environmentOf(scope: Scope): string | undefined {
  switch (scope.kind) {
    case "environment":
    case "environment-local":
      return scope.environment;
    case "unscoped":
    case "local":
      return undefined;
    default:
      return assertNever(scope, "scope");
  }
}

/**
 * The scope `--env <environment>` names, given the scope the filename named.
 *
 * `--env` reads as "these are <environment>'s values", so it names a scope and
 * not merely a validation target. Deriving the scope from the filename alone was
 * the scope-widening leak: `penv import prod-secrets.txt --env production` wrote
 * the unscoped default, and `development` read the production secret.
 *
 * A filename that already names an environment keeps its scope untouched: by the
 * time this runs the two agree, because a contradiction is an error. `.env.local`
 * names a scope but no environment, so the two compose — the filename says
 * personal override, `--env` says which environment it overrides, and together
 * they are `.env.<environment>.local`.
 */
function scopeWithEnvironment(scope: Scope, environment: string): Scope {
  switch (scope.kind) {
    case "unscoped":
      return { kind: "environment", environment };
    case LOCAL:
      return { kind: "environment-local", environment };
    case "environment":
    case "environment-local":
      return scope;
    default:
      return assertNever(scope, "scope");
  }
}

/**
 * `--env`, normalized the way `resolveEnvironment` normalizes it — but a flag
 * that is present and blank is refused rather than normalized away.
 *
 * `--env "$ENVIRONMENT"` with the variable unset arrives here as `""`. Reading
 * that as "no `--env`" silently demotes the scope the user asked for to the
 * unscoped default, so `penv import prod-secrets.txt --env ""` writes the
 * production secret to the file every environment falls back to — the leak this
 * flag exists to close, through a quieter door. An absent flag still means the
 * unscoped default: that is the user declining to name a scope, not failing to.
 */
function explicitEnvironment(options: ImportOptions, source: string, config: PenvConfig): string {
  const value = options.environment?.trim() ?? "";
  if (value.length > 0) {
    return value;
  }
  throw new PenvError(
    "IMPORT_ENV_FLAG_EMPTY",
    `\`--env\` for the import of ${source} names no environment`,
    `Pass a declared environment — ${environmentNames(config)
      .map((e) => `\`${e}\``)
      .join(", ")} — e.g. ` +
      `\`--env production\`, or drop \`--env\` to import ${source} as the scope that has no ` +
      `environment. Nothing was imported.`,
  );
}

/**
 * `penv import .env.production --env development` names two environments and
 * means one of them. penv cannot know which, and both readings are destructive:
 * honouring `--env` validates the wrong environment, honouring the filename
 * ignores what the user typed. It says so instead of choosing.
 */
function assertEnvironmentAgrees(
  derived: string | undefined,
  explicit: string | undefined,
  source: string,
): void {
  if (derived === undefined || explicit === undefined || derived === explicit) {
    return;
  }
  throw new PenvError(
    "IMPORT_ENV_CONFLICT",
    `The file ${source} is scoped to environment ${derived}, but \`--env ${explicit}\` names ${explicit}`,
    `Drop \`--env\` to import ${source} as ${derived}, pass \`--env ${derived}\` to say the same ` +
      `thing twice, or point \`penv import\` at the file that holds ${explicit}'s values. ` +
      `Nothing was imported.`,
  );
}

/**
 * The config `import` must judge names against: the project's own when it has
 * one, and otherwise the one `penv init` writes, since that is the config the
 * scaffold below is about to put in place.
 *
 * Writing it *first* is what lets every name check run before a single value
 * file exists. It is safe to leave behind if a check then fails: it is byte for
 * byte the file `penv init` writes, it holds nothing read out of the `.env`, and
 * it is the file the reserved-token and `override` remedies both tell the user to
 * go and edit.
 */
/**
 * The environment this run names, read lexically — before any config exists to
 * check it against.
 *
 * `scopeFromFilename` cannot answer this: it validates against the whitelist, and
 * on a greenfield project the whitelist is the thing being written. So the
 * segment is read here without being believed, handed to the scaffold as a
 * declaration, and then checked by the ordinary path like any other.
 *
 * Reading it is not inference. Invariant 10 forbids penv deciding that a file in
 * a tree belongs to an environment nobody declared; this is the user typing
 * `penv import .env.production` and thereby saying which environment the file is
 * for. The command line is a declaration — the only one available on a project
 * that has no config yet.
 */
function environmentNamed(file: string, explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const segments = basename(file).split(".");
  const start = segments.indexOf(DOTENV_SEGMENT);
  if (start === -1) {
    return undefined;
  }
  const first = segments.slice(start + 1).filter((segment) => segment.length > 0)[0];
  return first === undefined || first === LOCAL ? undefined : first;
}

/**
 * The config to check every name against, scaffolding one when the project has none.
 *
 * Writing it *first* is what lets every name check run before a single value
 * file exists. It is safe to leave behind if a check then fails: it holds
 * nothing read out of the `.env`, and it is the file the reserved-token and
 * `override` remedies both tell the user to go and edit.
 *
 * The scaffold declares the environment this import names, and nothing else.
 * `penv init` refuses to invent environments because it cannot observe a
 * deployment — but here the user has named one, and a config that omitted it
 * would be penv writing a file that makes penv's own next step fail.
 */
interface Adoption {
  readonly config: PenvConfig;
  /**
   * What the rest of the scaffold must write, and the reason this is returned
   * rather than recomputed.
   *
   * `scaffold` takes `decisions` with a default, so a caller that forgot them
   * compiled and quietly wrote `DEFAULT_DECISIONS` instead. Import forgot them:
   * the config it wrote said `schemaFile: "src/env.ts"` while the schema it
   * scaffolded a moment later went to `.penv/env.ts`, and the two disagreed for
   * exactly as long as the project lived. The optional parameter is what hid it
   * from the compiler; carrying the decisions is what stops the two halves of one
   * scaffold answering the same question differently.
   */
  readonly decisions: InitDecisions;
}

/** The decisions a config already records. The alias is read from the files that resolve it. */
function decisionsOf(config: PenvConfig, cwd: string): InitDecisions {
  return {
    environments: environmentNames(config),
    // `import` re-scaffolds env.ts for an existing project; injection is an init
    // choice, so it is not turned on here.
    inject: false,
    schemaFile: schemaFileOf(config),
    publicPrefixes: config.publicPrefixes ?? [],
    alias: detectAlias(cwd),
  };
}

function configInEffect(cwd: string, environment: string | undefined): Adoption {
  const existing = findConfigFile(cwd);
  if (existing !== undefined) {
    const config = loadConfigFrom(existing);
    return { config, decisions: decisionsOf(config, cwd) };
  }
  // The same plan `penv init` would make without being asked anything — import
  // is a scaffold too, and two scaffolds that disagreed about where the schema
  // goes would make the answer depend on which command the user reached for.
  const planned = planInit(cwd).decisions;
  const decisions: InitDecisions = {
    ...planned,
    environments: environment === undefined ? planned.environments : [environment],
  };
  writeConfigFile(cwd, decisions);
  return { config: openProject(cwd).config, decisions };
}

/**
 * Adopts the file: parses it, scaffolds the project, writes one value file per
 * variable and each attached comment into that parameter's meta, and backs the
 * source up. Validation is the caller's next step rather than part of adoption —
 * an inferred schema is a draft, and a draft that needs correcting has still
 * imported every value correctly.
 *
 * Adoption is all or nothing. Every name is checked against the config, and any
 * environment the source names resolved, before the tree is scaffolded or a
 * value written. The two names that fail here fail *destructively*: a reserved
 * name bricks every later command, and a lossy name renames the user's variable
 * behind their back. What the source names is resolved here rather than left to
 * the closing `validate` because a command that writes a tree and *then*
 * discovers it cannot name an environment has already half-adopted the project
 * it just refused. A half-imported tree would be the drift penv exists to
 * remove, introduced by penv itself.
 *
 * An environment nothing names is a different case, and not an error: an
 * unscoped import writes at the unscoped default, which needs no environment.
 * Only the validation that follows needs one, so it is skipped and said to be
 * skipped. Requiring one here would fail `penv import .env` on a greenfield
 * project — the first command the quickstart gives, where no environment could
 * plausibly be set yet — to satisfy a step that is the caller's next one.
 */
export function importDotenv(options: ImportOptions): ImportReport {
  const cwd = resolve(options.cwd);
  const file = isAbsolute(options.file) ? options.file : resolve(cwd, options.file);
  if (!existsSync(file)) {
    throw new PenvError(
      "IMPORT_FILE_MISSING",
      `There is no file at ${file} to import`,
      "Point `penv import` at an existing dotenv file, e.g. `penv import .env`.",
    );
  }

  const parsed = parseDotenv(readFileSync(file, "utf8"));
  const { config, decisions } = configInEffect(cwd, environmentNamed(file, options.environment));
  const source = displayPath(cwd, file);

  const named = scopeFromFilename(file, config);
  const derived = environmentOf(named);
  // Absent means the unscoped default; present-but-blank is refused, never
  // normalized into absent.
  const explicit =
    options.environment === undefined ? undefined : explicitEnvironment(options, source, config);
  assertEnvironmentAgrees(derived, explicit, source);
  // `--env` must reach the scope, not just the environment: reading it into the
  // environment alone is what wrote a production secret to the unscoped default.
  // Invariant 10 first — an undeclared `--env` names no scope to write at.
  const scope =
    explicit === undefined ? named : scopeWithEnvironment(named, assertDeclared(explicit, config));
  // The filename is an environment the user has already stated, so `penv import
  // .env.production` needs no `--env` to mean production. Nothing naming one is
  // the unscoped default's ordinary case, not a failure — the values still have
  // a scope to be written at, and only the closing validate goes without.
  const environment = lookupEnvironment(config, explicit ?? derived);

  const refs = refsForEntries(parsed.entries, source, config);
  assertNoCollisions(refs, config);

  // Every check has passed, so from here the import runs to completion.
  // The decisions the config was written from, not the defaults: the two halves
  // of one scaffold must not disagree about where the schema lives.
  const steps = scaffold(cwd, draftFields(parsed.entries), true, decisions);
  const project = openProject(cwd);
  const tree = localTree(project);

  // A comment sitting directly above a variable describes it, so it becomes that
  // parameter's meta description and `generate` re-emits it as a comment.
  writeEntries(tree, parsed.entries, refs, scope);

  const backup = `${file}${BACKUP_SUFFIX}`;
  copyFileSync(file, backup);

  return {
    root: project.root,
    file,
    backup,
    scope,
    environment,
    environments: environmentNames(config),
    variables: parsed.entries.length,
    orphanComments: parsed.orphanComments,
    steps,
  };
}

function displayPath(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split("\\").join("/");
}

/**
 * Invariant 2 kept the user's `env.ts`; invariant 13 says so out loud.
 *
 * `penv init` then `penv import` is the ordinary path, and it lands here: the
 * schema penv scaffolded is an empty `z.object({})`, the draft that would have
 * declared the imported parameters is not written, and the closing `validate`
 * passes — an empty object validates against an empty schema. A ✓ on that line
 * reports a project where nothing is declared as a project that is fine.
 *
 * The count is every imported parameter, because penv declared none of them: it
 * did not write the draft, and it does not read the user's schema to guess which
 * ones they had already declared themselves.
 */
function keptSchemaStep(step: InitStep, variables: number): Step {
  const plural = variables === 1 ? "parameter" : "parameters";
  return {
    glyph: WARN,
    // The step's own text, which names the file that was actually kept. This
    // line rebuilt it from a hardcoded `.penv/env.ts`, so a project whose schema
    // lives in `src/` was told penv had kept a file it does not have — the one
    // line whose whole job is "your schema is untouched" naming the wrong
    // schema. Only the glyph and the note are this function's business.
    text: step.text,
    note: `(yours — ${variables} imported ${plural} undeclared, draft schema skipped)`,
  };
}

/**
 * Invariant 13: the validation that did not run says so.
 *
 * A skipped check and a passed check must never look alike — the import wrote
 * every value, so a silent skip would read as a validated tree. The remedy names
 * a declared environment because the user has not chosen one yet; that is the
 * whole reason this line exists.
 */
function skippedValidationStep(environments: readonly string[]): Step {
  const example = environments[0] ?? "<environment>";
  return {
    glyph: WARN,
    text: "Skipped validation",
    note: `(no environment set — run \`penv validate --env ${example}\`)`,
  };
}

export function renderImport(
  result: ImportReport,
  validation: ValidateResult | undefined,
): string[] {
  const steps: Step[] = [{ glyph: CHECK, text: `Found ${result.variables} variables` }];

  // Dropped, but never silently: a comment attached to nothing has no parameter
  // to belong to, and how many there were is the user's to know.
  if (result.orphanComments > 0) {
    const plural = result.orphanComments === 1 ? "comment" : "comments";
    steps.push({
      glyph: WARN,
      text: `Dropped ${result.orphanComments} orphan ${plural}`,
      note: "attached to no variable, so nothing to describe",
    });
  }

  for (const step of result.steps) {
    if (step.target === "schema" && step.action === "kept") {
      steps.push(keptSchemaStep(step, result.variables));
      continue;
    }
    // A conflicted step is the one init reports that is not a success — the same
    // reason it wears a warning there.
    const glyph = step.action === "conflicted" ? WARN : CHECK;
    steps.push(
      step.note === undefined
        ? { glyph, text: step.text }
        : { glyph, text: step.text, note: step.note },
    );
  }
  steps.push({ glyph: CHECK, text: `Created ${displayPath(result.root, result.backup)}` });

  const lines = formatSteps(steps);
  if (validation === undefined) {
    lines.push(...formatSteps([skippedValidationStep(result.environments)]));
  } else if (validation.ok) {
    lines.push(...formatSteps([{ glyph: CHECK, text: "Validated configuration" }]));
  } else {
    lines.push(...renderValidate(validation));
  }

  lines.push("", "Done. The records tree is now your source of truth.");
  return lines;
}

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import an existing dotenv file; it becomes the source of truth",
  },
  args: {
    file: {
      type: "positional",
      required: true,
      description: "The dotenv file to import, e.g. .env",
    },
    env: {
      type: "string",
      description:
        "The environment these are the values of; scopes them to it. The filename supplies it " +
        "when it carries one",
    },
  },
  run({ args }) {
    return guard(async () => {
      const cwd = process.cwd();
      const report = importDotenv({
        cwd,
        file: args.file,
        ...(args.env === undefined ? {} : { environment: args.env }),
      });
      // The environment `import` already resolved, so the closing validate cannot
      // target a different one than the values were just written for. Without one
      // there is nothing to validate against, and the render says it was skipped.
      const validation =
        report.environment === undefined
          ? undefined
          : await runValidate({ cwd, environment: report.environment });
      write(renderImport(report, validation));
    });
  },
});
