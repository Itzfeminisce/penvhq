/**
 * `penv fill` — walk the schema's required-but-missing parameters and ask for
 * each one, deriving the value file's name so the user never has to.
 *
 * The schema-first flow writes `.penv/env.ts` before any value exists, and there
 * the user hits a translation they should not have to make: `databaseUrl` in the
 * schema is `database-url` on disk, and typing the wrong one writes a file the
 * schema still cannot see. `fill` reads the same declared drift `validate`
 * computes, and for each missing parameter asks for a value and writes it through
 * the one writer — `runSet` — deriving the kebab filename from the schema key.
 *
 * A value is never invented: a blank answer skips the parameter, because the
 * silent value reaching runtime is the failure penv exists to delete, and a
 * placeholder written here is exactly that value by a friendlier route.
 *
 * Optional parameters — `.optional()`, `.default()` — are asked too, after the
 * required gaps, tagged so the reader knows an answer is an override and Enter
 * keeps what the schema declared. Skipping them silently was the old behavior,
 * and it hid a real choice: a schema default reaching runtime is legal, but the
 * user who never heard the question never chose it.
 */

import { PenvError } from "@penvhq/core";
import { defineCommand } from "citty";
import { shorthandCandidates } from "../env-flags.js";
import { lineReader } from "../input.js";
import { PENV_DIR } from "../project.js";
import { out } from "../style.js";
import { CHECK, formatRows, guard, prompt as promptLine, type Row, WARN, write } from "../ui.js";
import { runSet } from "./set.js";
import { runValidate, type ValidateIssueKind } from "./validate.js";

/**
 * The validation issue kinds that stop `fill` before it writes a thing. A
 * `schema` issue is, on the ordinary run, the missing value `fill` is about to
 * ask for — so it is deliberately absent here, or `fill` would refuse the very
 * gap it exists to close. A collision, a reserved token, or a config/load
 * failure is a structural fault of the tree itself, and filling would only paper
 * over it: `generate` would still drop a value, and "what is missing" is not even
 * a meaningful question against a config that does not load.
 */
const BLOCKING: ReadonlySet<ValidateIssueKind> = new Set(["config", "collision", "reserved"]);

/** One question `fill` puts to the user: which parameter, in which environment. */
export interface FillPrompt {
  /** The value file's key, kebab and slash-separated — the name the user need never derive. */
  readonly parameter: string;
  readonly environment: string;
  /**
   * Whether meta says this is a secret. Carried so a wrapper can mute the echo;
   * v1 does not, and the drift carries no meta, so this is `false` today.
   */
  readonly secret: boolean;
  /**
   * Whether the schema excuses absence — `.optional()`, `.default()`. An answer
   * writes an override; a blank one leaves the schema's own behavior in place,
   * which is a kept default rather than a lingering gap.
   */
  readonly optional: boolean;
  /** What the schema falls back to, rendered for display, when it declares one penv can read. */
  readonly defaultValue?: string;
  readonly description?: string;
}

export interface FillOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
  /**
   * How a value is obtained for one prompt. `undefined` or an empty answer skips
   * the parameter — the readline half lives only in the wrapper, so `runFill`
   * stays pure and unit-testable.
   */
  readonly ask: (prompt: FillPrompt) => Promise<string | undefined>;
}

export interface FillResult {
  readonly environment: string;
  /** The value files written, one per answered prompt. */
  readonly written: ReadonlyArray<{
    readonly parameter: string;
    /** The value file written, relative to `.penv/`. */
    readonly location: string;
    readonly encrypted: boolean;
  }>;
  /** The parameters a blank answer left for later — never written as an empty value. */
  readonly skipped: readonly string[];
  /**
   * The optional parameters a blank answer left to the schema. Not `skipped`:
   * a skipped parameter is still a gap, and one of these is a decision — the
   * schema's default (or declared absence) is the value, on purpose.
   */
  readonly kept: readonly string[];
  /**
   * The declared keys no filename reaches (`apiURL`, a reserved token). `fill`
   * cannot ask for a value it could never write, so it carries the rename remedy
   * out rather than prompting for a file that would error.
   */
  readonly unreachable: ReadonlyArray<{ readonly subject: string; readonly remedy: string }>;
}

/**
 * Asks for every declared-but-missing parameter, and writes the ones answered.
 *
 * The drift is `validate`'s, not a second reading of the schema: `runValidate`
 * already computes exactly the required-but-absent set, so `fill` and `validate`
 * can never disagree about what is missing. The writing is `runSet`'s, so a
 * filled secret is sealed exactly as a `set` one is — `fill` owns neither the
 * resolution nor the write, only the prompting between them.
 */
export async function runFill(options: FillOptions): Promise<FillResult> {
  const validation = await runValidate({
    cwd: options.cwd,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.envFlags === undefined ? {} : { envFlags: options.envFlags }),
  });
  const environment = validation.environment;

  // A tree that fails validation for a *structural* reason is not one `fill`
  // should write into, so it refuses and hands the reasons back rather than
  // prompting. Keying off the issue kinds — not `validation.ok` — is the load-
  // bearing choice: a required parameter with no value fails the schema too, and
  // that failure *is* the drift `fill` exists to close, so blocking on `ok` would
  // refuse every ordinary run. The `EMPTY_DRIFT` sentinel is not consulted: a
  // schema that never loaded surfaces here as a `config` blocker with its real
  // reason, so a provider-list failure no longer masquerades as "no schema".
  const blockers = validation.issues.filter((issue) => BLOCKING.has(issue.kind));
  if (blockers.length > 0) {
    const detail = blockers
      .map(
        (issue) => `  - ${issue.message}${issue.remedy === undefined ? "" : ` (${issue.remedy})`}`,
      )
      .join("\n");
    throw new PenvError(
      "FILL_BLOCKED",
      `penv fill cannot run: environment ${environment} has ${blockers.length} unresolved ` +
        `configuration ${blockers.length === 1 ? "issue" : "issues"}:\n${detail}`,
      "Fix these — `penv validate` reports them — then run `penv fill`. If you have not written a " +
        `schema yet, declare the required parameters in ${PENV_DIR}/env.ts.`,
    );
  }

  const written: Array<{ parameter: string; location: string; encrypted: boolean }> = [];
  const skipped: string[] = [];
  const kept: string[] = [];
  const unreachable: Array<{ subject: string; remedy: string }> = [];

  for (const drift of validation.drift.declared) {
    // A key outside the name transform's image, or a reserved token: no value
    // file reaches it, so the remedy is a rename, not a value. Prompting here
    // would ask for a file penv would then refuse to write.
    if (drift.ref === undefined) {
      unreachable.push({ subject: drift.subject, remedy: drift.remedy });
      continue;
    }

    const ref = drift.ref;
    const key = [...ref.namespace, ref.name].join("/");
    // `secret` stays false: the drift carries no meta, and echo-muting is not a
    // v1 feature. The write below still seals per meta — `runSet` reads it there.
    const value = await options.ask({
      parameter: key,
      environment,
      secret: false,
      optional: false,
    });
    if (value === undefined || value === "") {
      skipped.push(drift.subject);
      continue;
    }

    const result = await runSet({ cwd: options.cwd, key, value, environment });
    written.push({
      parameter: drift.subject,
      location: result.location,
      encrypted: result.encrypted,
    });
  }

  // The optional parameters, asked after the required gaps: the schema excuses
  // their absence, so a blank answer here is a decision to keep the schema's
  // default rather than a gap left open — `kept`, not `skipped`. Asking at all
  // is the point: an override the user never hears about is one they can never
  // choose, and the tag on the prompt is what keeps the choice a free one.
  for (const item of validation.drift.optional) {
    if (item.ref === undefined) {
      unreachable.push({ subject: item.subject, remedy: item.remedy });
      continue;
    }

    const ref = item.ref;
    const key = [...ref.namespace, ref.name].join("/");
    const value = await options.ask({
      parameter: key,
      environment,
      secret: false,
      optional: true,
      ...(item.defaultValue === undefined ? {} : { defaultValue: item.defaultValue }),
    });
    if (value === undefined || value === "") {
      kept.push(item.subject);
      continue;
    }

    const result = await runSet({ cwd: options.cwd, key, value, environment });
    written.push({
      parameter: item.subject,
      location: result.location,
      encrypted: result.encrypted,
    });
  }

  return { environment, written, skipped, kept, unreachable };
}

/** The one line that reports the run's shape when nothing else needs a row. */
function summaryLine(result: FillResult): string {
  const filled = result.written.length;
  if (
    filled === 0 &&
    result.skipped.length === 0 &&
    result.kept.length === 0 &&
    result.unreachable.length === 0
  ) {
    return `${out.green(CHECK)} Nothing to fill for environment ${result.environment}: every declared parameter has a value`;
  }
  const parts = [`${filled} written`];
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} skipped`);
  }
  if (result.kept.length > 0) {
    parts.push(`${result.kept.length} left to the schema's defaults`);
  }
  if (result.unreachable.length > 0) {
    parts.push(`${result.unreachable.length} unreachable`);
  }
  return `${parts.join(", ")} for environment ${result.environment}`;
}

export function renderFill(result: FillResult): string[] {
  const rows: Row[] = result.written.map((entry) => ({
    glyph: CHECK,
    label: "Wrote",
    subject: `${PENV_DIR}/${entry.location}`,
    // Meta decided the seal, not the answer, so the line says so — as `set` does.
    ...(entry.encrypted ? { detail: "encrypted, per the parameter's meta policy" } : {}),
  }));

  // A key no filename reaches is not skipped — it is unwritable until it is
  // renamed, so it carries its rename remedy rather than a value prompt.
  for (const entry of result.unreachable) {
    rows.push({ glyph: WARN, label: "Unreachable", subject: entry.subject, detail: entry.remedy });
  }

  const lines = formatRows(rows);
  lines.push(summaryLine(result));
  return lines;
}

/**
 * The prompt's aside: what Enter does. For a required gap it skips; for an
 * optional parameter it keeps whatever the schema declared — named exactly,
 * with the default shown when penv can read it, because "optional" alone tells
 * the user a choice exists without telling them what not choosing means. A
 * default too long to sit inside a prompt is elided rather than allowed to push
 * the cursor off the line.
 */
function contextFor(prompt: FillPrompt): string {
  if (!prompt.optional) {
    return `${prompt.environment}, Enter to skip`;
  }
  if (prompt.defaultValue === undefined) {
    return `${prompt.environment} · optional, Enter leaves it unset`;
  }
  const shown =
    prompt.defaultValue.length > 24 ? `${prompt.defaultValue.slice(0, 23)}…` : prompt.defaultValue;
  return `${prompt.environment} · optional, Enter keeps ${shown}`;
}

export const fillCommand = defineCommand({
  meta: {
    name: "fill",
    description: "Prompt for each declared parameter the tree has no value for",
  },
  args: {
    env: { type: "string", description: "The environment to fill" },
  },
  run({ args }) {
    return guard(async () => {
      const reader = lineReader();
      // TODO: a `prompt.secret` answer still echoes — echo-muting is out of scope
      // for v1. The prompt shows the derived key, so a reader sees the file name
      // their answer becomes. An empty answer skips — the prompt's aside says so,
      // because the skip is a feature and an undiscoverable feature is not one.
      const ask = (prompt: FillPrompt): Promise<string | undefined> =>
        reader.ask(promptLine(prompt.parameter, contextFor(prompt)));
      try {
        write(
          renderFill(
            await runFill({
              cwd: process.cwd(),
              ...(args.env === undefined ? {} : { environment: args.env }),
              ask,
              envFlags: shorthandCandidates(args, ["env"]),
            }),
          ),
        );
      } finally {
        reader.close();
      }
    });
  },
});
