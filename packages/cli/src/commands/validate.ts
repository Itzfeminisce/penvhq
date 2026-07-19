/**
 * `penv validate` — build the target environment's configuration and check it
 * against the one schema.
 *
 * Three failures land here rather than anywhere else, and all three are errors:
 * a reserved token in a name (invariant 11), two parameters mapping to one
 * generated variable (invariant 12 — never last-write-wins), and a config object
 * the schema rejects. A passing run means the schema is internally consistent;
 * it does not mean the schema is correct. That is your review, especially after
 * an inferred import.
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParameterRef, ValueFile } from "@penvhq/core";
import {
  accessPath,
  checkNameCollisions,
  jitiFor,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  resolveAll,
  SCHEMA_HARVEST_ENV,
  schemaFileOf,
  validateConfig,
} from "@penvhq/core";
import { defineCommand } from "citty";
import type { z } from "zod";
import { shorthandCandidates } from "../env-flags.js";
import type { Project } from "../project.js";
import { keySourceFor, openProject, refsFrom, targetEnvironment } from "../project.js";
import type { DriftReport } from "../schema.js";
import { computeDrift, EMPTY_DRIFT } from "../schema.js";
import { out } from "../style.js";
import { CHECK, CROSS, formatRows, guard, type Row, tip, write } from "../ui.js";

export type ValidateIssueKind = "config" | "reserved" | "collision" | "schema" | "undecryptable";

export interface ValidateIssue {
  readonly kind: ValidateIssueKind;
  /** What the line is about: a parameter, a variable, a token, or a file. */
  readonly subject: string;
  readonly message: string;
  readonly remedy?: string;
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly environment: string;
  readonly parameters: number;
  readonly issues: readonly ValidateIssue[];
  /**
   * The distance between the schema and the tree, carried for the callers
   * that report it (`watch`). Never folded into `ok` and never rendered by
   * `renderValidate`: drift is a report, and CI's verdict must not move because
   * a parameter the schema tolerates is absent. Empty when the schema did not
   * load, since there is nothing to measure against.
   */
  readonly drift: DriftReport;
}

export interface ValidateOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
}

const SCHEMA_EXPORT = "schema";

const LABELS: Readonly<Record<ValidateIssueKind, string>> = {
  config: "Config",
  reserved: "Reserved token",
  collision: "Name collision",
  schema: "Invalid parameter",
  undecryptable: "Undecryptable value",
};

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function issueFrom(error: PenvError, fallbackSubject: string): ValidateIssue {
  const base = {
    message: firstLine(error.message),
    ...(error.remedy === undefined ? {} : { remedy: error.remedy }),
  };
  if (error instanceof ReservedTokenError) {
    return { kind: "reserved", subject: error.token, ...base };
  }
  if (error instanceof NameCollisionError) {
    return { kind: "collision", subject: error.variable, ...base };
  }
  return { kind: "config", subject: fallbackSubject, ...base };
}

/**
 * Places a value at its access path. Values are placed exactly as the provider
 * holds them: coercion is the schema's job, so a value file's contents stay a
 * string here.
 */
function place(root: Record<string, unknown>, path: readonly string[], value: string): void {
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    return;
  }
  let node = root;
  for (const key of path.slice(0, -1)) {
    const existing = node[key];
    if (typeof existing === "object" && existing !== null) {
      node = existing as Record<string, unknown>;
      continue;
    }
    const child: Record<string, unknown> = {};
    node[key] = child;
    node = child;
  }
  node[leaf] = value;
}

function isZodType(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse: unknown }).safeParse === "function"
  );
}

export interface SchemaLoad {
  /** Absent when the module could not be evaluated. `issues` says why. */
  readonly schema?: z.ZodType;
  readonly issues: readonly ValidateIssue[];
}

/**
 * A penv error raised inside the user's own schema module, identified by its
 * `code` rather than by `instanceof`.
 *
 * The error is thrown by *their* copy of penv, which is a different module realm
 * from this one, so `instanceof` is false across the boundary. `code` is the
 * stable, machine-readable discriminator, and this is exactly what it is for.
 */
function validationIssuesOf(
  cause: unknown,
  schemaPath: string,
): readonly ValidateIssue[] | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const error = cause as { code?: unknown; issues?: unknown };
  if (error.code !== "VALIDATION_FAILED" || !Array.isArray(error.issues)) {
    return undefined;
  }
  return error.issues.map((issue: unknown) => {
    const { parameter, message } = issue as { parameter?: unknown; message?: unknown };
    return {
      kind: "schema" as const,
      subject: typeof parameter === "string" && parameter !== "" ? parameter : schemaPath,
      message: typeof message === "string" ? message : String(issue),
      remedy: `Fix the value, or adjust the schema in ${schemaPath} if the shape is wrong.`,
    };
  });
}

/**
 * Serialises the `PENV_ENV` pin in {@link loadSchema}.
 *
 * The environment reaches the user's module through a process global, because
 * that is the only channel their scaffolded `load(schema)` reads. A global
 * pinned across an `await` is not re-entrant: two overlapping loads interleave,
 * the second captures the first's value as `previous`, and restoring it on the
 * way out leaves the global pinned to an environment nobody asked for — every
 * later cycle then silently validates the wrong one. The window is real because
 * `runValidate` is exported and nothing stops a caller validating two
 * environments at once; `watch` is safe only by accident of its single-flight.
 *
 * A queue rather than a fix to the channel: the global *is* the contract with
 * the user's module, so the pin cannot go away. Only one load may hold it.
 */
let schemaLoads: Promise<unknown> = Promise.resolve();

function exclusively<T>(work: () => Promise<T>): Promise<T> {
  const result = schemaLoads.then(work, work);
  // Never let a rejection break the chain for the next caller.
  schemaLoads = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * The one schema, read from wherever `schemaFile` puts it.
 *
 * Only the `schema` export is read, never `env` — a command whose job is to
 * *report* on configuration must not be stopped by it. That is the whole reason
 * the docs tell type-only consumers to import `schema`: a type-only import is
 * erased and never evaluates the module at all.
 *
 * A *runtime* read cannot have that guarantee: evaluating the module runs its
 * top level, and the scaffolded module ends in an eager
 * `export const env = load(schema)`. Against a tree with no values yet that load
 * would throw and take the whole namespace — including the `schema` export —
 * down with it, leaving `fill` blind to the very gap it exists to close. So the
 * schema-harvest flag is pinned alongside `PENV_ENV` for this one import:
 * `load()` defers under it (see `SCHEMA_HARVEST_ENV` in core), the module
 * evaluates, and the schema is always reachable. A module that fails for its own
 * reasons still reports honestly — a penv validation error raised at its top
 * level is unwrapped back into per-parameter issues, and anything else is a
 * config issue naming the file.
 *
 * The pins are process globals, so only one load may hold them at a time — see
 * {@link exclusively}. Loads queue rather than overlap.
 */
export function loadSchema(project: Project, environment: string): Promise<SchemaLoad> {
  // Resolved against the project root, not `.penv/`: `schemaFile` is relative to
  // penv.config.ts, so a schema at `src/env.ts` is looked for where it is.
  const schemaPath = schemaFileOf(project.config);
  const file = pathToFileURL(resolvePath(project.root, schemaPath)).href;
  return exclusively(() => loadSchemaExclusively(file, schemaPath, environment));
}

/** {@link loadSchema}'s body, run only while it holds the `PENV_ENV` + harvest pins. */
async function loadSchemaExclusively(
  file: string,
  schemaPath: string,
  environment: string,
): Promise<SchemaLoad> {
  // Resolved from the user's own file: `zod` and `penv` are their dependencies,
  // not the CLI's. Shared with config loading (jitiFor) so both evaluate user modules
  // identically — including resolving `server-only` to its no-throw variant so a
  // server-guarded `.penv/env.ts` still yields its `schema` export.
  const jiti = jitiFor(file);

  // Two pins, one window: `PENV_ENV` so anything the module resolves targets the
  // environment being validated, and the schema-harvest flag so the scaffolded
  // eager `export const env = load(schema)` defers instead of throwing — a tree
  // with no values yet would otherwise take the `schema` export down with it,
  // and `fill` could never see the gap it exists to close.
  const previous = process.env.PENV_ENV;
  const previousHarvest = process.env[SCHEMA_HARVEST_ENV];
  process.env.PENV_ENV = environment;
  process.env[SCHEMA_HARVEST_ENV] = "1";
  let loaded: unknown;
  try {
    loaded = await jiti.import(file);
  } catch (cause) {
    const issues = validationIssuesOf(cause, schemaPath);
    if (issues !== undefined) {
      return { issues };
    }
    const detail = cause instanceof Error ? firstLine(cause.message) : String(cause);
    return {
      issues: [
        {
          kind: "config",
          subject: schemaPath,
          message: `${schemaPath} could not be loaded: ${detail}`,
          remedy: `Fix the error above. penv reads the \`${SCHEMA_EXPORT}\` export of ${schemaPath}, which is yours to edit.`,
        },
      ],
    };
  } finally {
    if (previous === undefined) {
      delete process.env.PENV_ENV;
    } else {
      process.env.PENV_ENV = previous;
    }
    if (previousHarvest === undefined) {
      delete process.env[SCHEMA_HARVEST_ENV];
    } else {
      process.env[SCHEMA_HARVEST_ENV] = previousHarvest;
    }
  }

  const exported =
    typeof loaded === "object" && loaded !== null
      ? (loaded as Record<string, unknown>)[SCHEMA_EXPORT]
      : undefined;

  if (!isZodType(exported)) {
    return {
      issues: [
        {
          kind: "config",
          subject: schemaPath,
          message: `${schemaPath} exports no \`${SCHEMA_EXPORT}\``,
          remedy: `Export the shape as \`export const ${SCHEMA_EXPORT} = z.object({ ... })\`. One schema drives both validation and types.`,
        },
      ],
    };
  }
  return { schema: exported, issues: [] };
}

export async function runValidate(options: ValidateOptions): Promise<ValidateResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment, options.envFlags);
  const schemaPath = schemaFileOf(project.config);
  const issues: ValidateIssue[] = [];

  // Invariant 11: a reserved token in a filename is an error, never a silent
  // misparse — so listing the tree is itself a check.
  let files: ValueFile[];
  try {
    files = await project.provider.list();
  } catch (error) {
    if (!(error instanceof PenvError)) {
      throw error;
    }
    return {
      ok: false,
      environment,
      parameters: 0,
      issues: [issueFrom(error, schemaPath)],
      drift: EMPTY_DRIFT,
    };
  }

  const refs: ParameterRef[] = refsFrom(files);

  // The config decides what an environment is, so a broken config is not a
  // smaller problem than a broken value — it is the problem that makes value
  // files unreadable. `validateConfig` collects every one of them, and until it
  // was called from here it collected them for nobody: a config declaring an
  // environment with no provider, or a name no filename can hold, passed
  // `penv validate` with a ✓.
  for (const error of validateConfig(project.config)) {
    issues.push(issueFrom(error, "penv.config.ts"));
  }

  // Invariant 12: two parameters mapping to one generated variable would lose a
  // value on `penv generate`. It fails here rather than there.
  for (const collision of checkNameCollisions(refs, project.config)) {
    issues.push(issueFrom(collision, collision.variable));
  }

  const { schema, issues: schemaIssues } = await loadSchema(project, environment);
  issues.push(...schemaIssues);

  let drift: DriftReport = EMPTY_DRIFT;

  if (schema !== undefined) {
    const resolutions = await resolveAll(
      environment,
      project.provider,
      keySourceFor(project, environment),
    );
    const object: Record<string, unknown> = {};
    // The access paths whose value exists and could not be read. Nothing is
    // placed at them, so the schema will call each one absent — see below.
    const undecryptable = new Set<string>();
    for (const resolution of resolutions) {
      if (resolution.undecryptable !== undefined) {
        undecryptable.add(accessPath(resolution.ref).join("."));
        issues.push({
          kind: "undecryptable",
          subject: resolution.parameter,
          message: `${resolution.winner?.location ?? "the winning value file"} could not be decrypted: ${resolution.undecryptable.detail}`,
          remedy:
            "Make the key available, or re-seal the value under a key you hold with `penv encrypt`. " +
            "The value is there — penv cannot read it.",
        });
        continue;
      }
      if (resolution.value !== undefined) {
        place(object, accessPath(resolution.ref), resolution.value);
      }
    }
    // Measured from the same resolutions the verdict below is reached on, so the
    // report can never describe a tree the verdict did not read.
    drift = computeDrift({ schema, resolutions, config: project.config, environment });

    const result = schema.safeParse(object);
    if (!result.success) {
      for (const problem of result.error.issues) {
        const path = problem.path.join(".");
        // One absence, one line. The schema is right that nothing is there, but
        // "expected string, received undefined" is the wrong answer to why: the
        // value exists and penv could not read it, which is already reported
        // above with the remedy that fixes it. Printing both puts the true line
        // and the misleading one next to each other and lets the reader pick.
        if (undecryptable.has(path)) {
          continue;
        }
        issues.push({
          kind: "schema",
          subject: path || schemaPath,
          message: problem.message,
          remedy: `Fix the value, or adjust the schema in ${schemaPath} if the shape is wrong.`,
        });
      }
    }
  }

  return { ok: issues.length === 0, environment, parameters: refs.length, issues, drift };
}

export function renderValidate(result: ValidateResult): string[] {
  if (result.ok) {
    return formatRows([
      {
        glyph: CHECK,
        label: "Schema valid",
        subject: `${result.parameters} parameters for environment ${result.environment}`,
      },
    ]);
  }

  // Every issue validate reports is an error — that is the command's contract
  // with CI — so the glyph is the failure cross, never the warning sign.
  const rows: Row[] = result.issues.map((issue) => ({
    glyph: CROSS,
    label: LABELS[issue.kind],
    subject: issue.subject,
    detail: issue.message,
  }));

  const lines = formatRows(rows);
  const remedies = [...new Set(result.issues.map((issue) => issue.remedy))].filter(
    (remedy): remedy is string => remedy !== undefined,
  );
  if (remedies.length > 0) {
    lines.push("");
    for (const remedy of remedies) {
      lines.push(tip(remedy));
    }
  }
  const count = result.issues.length;
  lines.push(
    "",
    `${out.red(CROSS)} ${count} ${count === 1 ? "issue" : "issues"} for environment ${result.environment}`,
  );
  return lines;
}

export const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate configuration against the schema; non-zero on failure",
  },
  args: {
    env: { type: "string", description: "The environment to validate" },
  },
  run({ args }) {
    return guard(async () => {
      const result = await runValidate({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        envFlags: shorthandCandidates(args, ["env"]),
      });
      write(renderValidate(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  },
});
