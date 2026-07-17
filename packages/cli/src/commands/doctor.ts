/**
 * `penv doctor` — one report of everything that has drifted.
 *
 * Each check earns its place by catching something no other command can:
 *
 * - **missing** — meta marks a parameter required for this environment and it
 *   resolves to nothing. Requiredness per environment is meta policy, not a
 *   second schema (invariant 1).
 * - **declared** — the schema declares a parameter the tree has no value for.
 *   The other half of the same distance `unused` measures, and a different
 *   question from `missing`: this one is asked of the schema and answered for
 *   every declared key, including one with no file anywhere — which no
 *   tree-driven check can see, because a parameter with no file has no meta
 *   either. It reports, and never writes: see `../schema.ts`.
 * - **weak** — the schema declares a minimum length the value does not meet.
 * - **unused** — a value file exists that the schema has no key for.
 * - **unscoped-fallback** — a real environment resolving via the unscoped
 *   default. Invariant 13: fallback is never silent.
 * - **plaintext-secret** — meta declares the parameter a secret and the winning
 *   value file carries no `.enc` marker. Invariant 14: encryption is
 *   policy-driven, so the filename is checked *against* the policy and is never
 *   the authority on what is secret.
 * - **public-secret** — meta declares the parameter a secret and its generated
 *   variable carries a prefix the framework inlines into the client bundle.
 *
 * Warnings are reported; failures are reported and exit non-zero.
 */

import type {
  Meta,
  PenvConfig,
  Resolution,
  SecretScope,
  Sink,
  SinkConfig,
  SinkSecret,
} from "@penvhq/core";
import {
  accessPath,
  effectiveMeta,
  isPublicVariable,
  isRequired,
  isSecret,
  resolveAll,
  variableName,
} from "@penvhq/core";
import { createGithubSink } from "@penvhq/sink-github";
import { defineCommand } from "citty";
import type { z } from "zod";
import type { Project } from "../project.js";
import { keySourceFor, openProject, targetEnvironment } from "../project.js";
import type { DriftReport } from "../schema.js";
import { computeDrift, lookup, minLengthOf } from "../schema.js";
import { CHECK, formatRows, guard, type Row, UNKNOWN, WARN, write } from "../ui.js";
import { LAST_PUSHED_KEY } from "./push.js";
import { loadSchema } from "./validate.js";

/**
 * A check reports one of four verdicts. `unknown` — a check that ran but could
 * not reach a verdict — is never rendered as a pass: "I looked and found nothing
 * wrong" and "I could not look" are opposite situations with opposite remedies,
 * and a write-only sink makes most of what doctor can say the second kind.
 */
export type DoctorSeverity = "pass" | "warning" | "failure" | "unknown";

export type DoctorCheck =
  | "schema"
  | "missing"
  | "declared"
  | "weak"
  | "unused"
  | "unscoped-fallback"
  | "plaintext-secret"
  | "public-secret"
  | "encryption"
  | "provider"
  | "sink-unreachable"
  | "sink-name-drift"
  | "sink-manual-edit"
  | "sink-value-drift";

export interface DoctorFinding {
  readonly check: DoctorCheck;
  readonly severity: DoctorSeverity;
  readonly label: string;
  readonly subject?: string;
  readonly detail?: string;
  /** A line the reader can act on — the `penv set` to paste, where there is one. */
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly environment: string;
  readonly findings: readonly DoctorFinding[];
  /** False when any finding is a failure. Warnings and unknowns do not fail the run. */
  readonly ok: boolean;
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Injected in tests: the sink to check against. Defaults to the one the config declares. */
  readonly sink?: Sink;
}

interface Subject {
  readonly resolution: Resolution;
  readonly meta: Meta | undefined;
}

/**
 * A check the schema failure above made impossible: `unknown`, not `warning`.
 * penv did not look, so it cannot claim there is nothing to find — and it cannot
 * claim a problem either. The verdict is "I could not tell".
 */
function skipped(check: DoctorCheck, label: string): DoctorFinding {
  return {
    check,
    severity: "unknown",
    label,
    subject: "not checked",
    detail: "the schema did not load, so this check could not run",
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const findings: DoctorFinding[] = [];

  const { schema, issues } = await loadSchema(project, environment);
  if (schema !== undefined) {
    findings.push({ check: "schema", severity: "pass", label: "Schema valid" });
  } else {
    for (const issue of issues) {
      findings.push({
        check: "schema",
        severity: "failure",
        label: "Schema",
        subject: issue.subject,
        detail: issue.message,
      });
    }
  }

  const resolutions = await resolveAll(
    environment,
    project.provider,
    keySourceFor(project, environment),
  );
  const subjects: Subject[] = await Promise.all(
    resolutions.map(async (resolution) => ({
      resolution,
      meta: await project.provider.readMeta(resolution.ref),
    })),
  );

  const missing = missingFindings(subjects, environment);
  findings.push(...missing);
  // A check that could not run says so. Printing nothing where a check belongs
  // reads as "nothing found", which is the one thing a report must never imply.
  if (schema === undefined) {
    findings.push(
      skipped("declared", "Schema coverage"),
      skipped("weak", "Secret strength"),
      skipped("unused", "Value coverage"),
    );
  } else {
    const drift = computeDrift({
      schema,
      resolutions: subjects.map(({ resolution }) => resolution),
      config: project.config,
      environment,
    });
    findings.push(...declaredFindings(drift, missing, environment));
    findings.push(...weakFindings(subjects, schema));
    findings.push(...unusedFindings(drift));
  }
  findings.push(...fallbackFindings(subjects, environment));
  findings.push(...plaintextSecretFindings(subjects, environment));
  findings.push(...publicSecretFindings(subjects, environment, project.config));
  findings.push(...encryptionFindings(subjects, environment));
  findings.push(...(await sinkFindings(project, environment, options.sink)));

  findings.push({
    check: "provider",
    severity: "pass",
    label: "Provider",
    subject: project.config.providers[environment]?.type ?? project.provider.type,
  });

  return {
    environment,
    findings,
    ok: !findings.some((finding) => finding.severity === "failure"),
  };
}

function missingFindings(subjects: readonly Subject[], environment: string): DoctorFinding[] {
  const required = subjects.filter(({ meta }) => isRequired(meta, environment));
  const findings: DoctorFinding[] = required
    .filter(({ resolution }) => resolution.winner === undefined)
    .map(({ resolution }) => ({
      check: "missing",
      severity: "failure",
      label: "Missing parameter",
      subject: resolution.parameter,
      detail: `required for ${environment}, absent`,
      remedy: `penv set ${[...resolution.ref.namespace, resolution.ref.name].join("/")} --env ${environment}`,
    }));

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "missing",
      severity: "pass",
      label: "Required parameters",
      subject:
        required.length === 0
          ? `none required for ${environment}`
          : `${required.length} required for ${environment}, all present`,
    },
  ];
}

/**
 * Schema → tree: declared, with no value for this environment.
 *
 * A warning, not a failure. The schema decides whether an absent value is fatal
 * and `penv validate` is where that verdict is reached; saying it twice, in two
 * voices, would make this report the second authority the design does not have.
 *
 * Parameters the `missing` check already named are dropped rather than repeated:
 * that line is the same absence with meta's stronger verdict on it, and it now
 * carries the same paste line. One absence, one line.
 */
function declaredFindings(
  drift: DriftReport,
  missing: readonly DoctorFinding[],
  environment: string,
): DoctorFinding[] {
  const reported = new Set(missing.filter((f) => f.severity !== "pass").map((f) => f.subject));

  const findings: DoctorFinding[] = drift.declared
    .filter((item) => !reported.has(item.subject))
    .map((item) => ({
      check: "declared",
      severity: "warning",
      label: "Declared, no value",
      subject: item.subject,
      detail: item.detail,
      remedy: item.remedy,
    }));

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "declared",
      severity: "pass",
      label: "Schema coverage",
      subject: `every parameter .penv/env.ts requires has a value for ${environment}`,
    },
  ];
}

function weakFindings(subjects: readonly Subject[], schema: z.ZodType): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  let checked = 0;

  for (const { resolution } of subjects) {
    const value = resolution.value;
    // A decrypted secret has a value here, so it is length-checked like any
    // other — an encrypted secret used to be invisible to this check, which made
    // "the schema declares a minimum" a promise that quietly excluded exactly the
    // values a minimum is for. Absence is two other checks' business: an
    // undecryptable winner is the encryption check's, and nothing at all is the
    // missing check's.
    if (value === undefined) {
      continue;
    }
    const field = lookup(schema, accessPath(resolution.ref));
    if (field.kind !== "found") {
      continue;
    }
    const minimum = minLengthOf(field.node);
    if (minimum === undefined) {
      continue;
    }
    checked += 1;
    if (value.length >= minimum) {
      continue;
    }
    findings.push({
      check: "weak",
      severity: "failure",
      label: "Weak secret",
      subject: resolution.parameter,
      detail: `${value.length} chars, schema requires ≥${minimum}`,
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "weak",
      severity: "pass",
      label: "Secret strength",
      subject:
        checked === 0
          ? "no schema field declares a minimum length"
          : checked === 1
            ? "1 value meets the schema minimum"
            : `${checked} values meet the schema minimum`,
    },
  ];
}

/** Tree → schema: a value the application has no declared way to read. */
function unusedFindings(drift: DriftReport): DoctorFinding[] {
  const findings: DoctorFinding[] = drift.undeclared.map((item) => ({
    check: "unused",
    severity: "warning",
    label: "Unused parameter",
    subject: item.variable,
    detail: "present, not in schema",
  }));

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "unused",
      severity: "pass",
      label: "Value coverage",
      subject: "every value file has a schema key",
    },
  ];
}

function fallbackFindings(subjects: readonly Subject[], environment: string): DoctorFinding[] {
  const findings: DoctorFinding[] = subjects
    .filter(({ resolution }) => resolution.viaUnscopedFallback)
    .map(({ resolution }) => ({
      check: "unscoped-fallback",
      severity: "warning",
      label: "Unscoped fallback in use",
      subject: resolution.parameter,
      detail: `${environment} resolving to default`,
    }));

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "unscoped-fallback",
      severity: "pass",
      label: "Scoped resolution",
      subject: `no parameter falls back to the unscoped default for ${environment}`,
    },
  ];
}

function plaintextSecretFindings(
  subjects: readonly Subject[],
  environment: string,
): DoctorFinding[] {
  const secrets = subjects.filter(({ meta }) => isSecret(meta, environment));
  const findings: DoctorFinding[] = [];

  for (const { resolution } of secrets) {
    const winner = resolution.winner;
    // Nothing resolves: that is the missing check's business, not this one's.
    if (winner === undefined || winner.file.encrypted) {
      continue;
    }
    findings.push({
      check: "plaintext-secret",
      severity: "failure",
      label: "Plaintext secret",
      subject: winner.location,
      detail: "value file is not encrypted",
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "plaintext-secret",
      severity: "pass",
      label: "Encryption policy",
      subject:
        secrets.length === 0
          ? `no parameter is declared secret for ${environment}`
          : `every secret resolving for ${environment} is encrypted`,
    },
  ];
}

/**
 * The third face of the same policy: is it sealed, can it be opened, and is it
 * public. A secret whose generated variable starts with a framework's public
 * prefix is inlined into the client bundle — `NEXT_PUBLIC_STRIPE_SECRET` reaches
 * every browser that loads the page, permanently, in a bundle nobody can recall.
 *
 * Nothing else in the stack can see this. To the framework the prefix *is* the
 * intent: Next inlines `NEXT_PUBLIC_*` by definition and has no notion that the
 * value is secret. The application's own env module knows the name and not the
 * policy. penv holds both — meta says secret, the name transform says public —
 * so this contradiction is only visible from here.
 *
 * Read of the *generated* variable rather than the parameter name, because a
 * `names` override is what decides the string the framework sees, and it is the
 * one place the prefix can appear with nothing in the tree hinting at it.
 * Absence of a value is deliberately not a reprieve: the name is already wrong,
 * and the next `penv set` is what ships it.
 */
function publicSecretFindings(
  subjects: readonly Subject[],
  environment: string,
  config: PenvConfig,
): DoctorFinding[] {
  const prefixes = config.publicPrefixes ?? [];
  // Nothing declared, nothing checkable: a prefix penv was never told about is
  // one it cannot recognise. This is the "I cannot tell" answer, and it is not
  // the same as a clean report — saying "no secret is exposed" here would be a
  // promise made by a check that never looked at anything.
  if (prefixes.length === 0) {
    return [
      {
        check: "public-secret",
        severity: "unknown",
        label: "Browser exposure",
        subject: "not checked — penv.config.ts declares no `publicPrefixes`",
        detail: "penv cannot tell which variables a framework inlines into the browser",
      },
    ];
  }

  const secrets = subjects.filter(({ meta }) => isSecret(meta, environment));
  const findings: DoctorFinding[] = [];

  for (const { resolution } of secrets) {
    const variable = variableName(resolution.ref, config);
    if (!isPublicVariable(variable, config)) {
      continue;
    }
    // Which prefix matched is for the message alone; core stays the authority on
    // whether the variable is public at all.
    const prefix = prefixes.find((candidate) => variable.startsWith(candidate));
    findings.push({
      check: "public-secret",
      severity: "failure",
      label: "Secret exposed to the browser",
      subject: variable,
      detail:
        prefix === undefined
          ? "meta declares this a secret, and its public prefix makes it public"
          : `meta declares this a secret, and the \`${prefix}\` prefix makes it public`,
      remedy:
        "rename the parameter so it carries no public prefix, or drop `secret` from its meta if it is not one",
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "public-secret",
      severity: "pass",
      label: "Browser exposure",
      subject: `no secret is exposed to the browser for ${environment}`,
    },
  ];
}

/**
 * The other half of the encryption policy: `plaintext-secret` catches a secret
 * that should be sealed and is not; this catches a sealed value penv cannot open.
 *
 * A failure, not a warning. An unopenable value is indistinguishable from an
 * absent one to everything downstream — the app gets nothing either way — and
 * the whole point of the `undecryptable` field is that penv can tell the
 * difference even when the application cannot.
 */
function encryptionFindings(subjects: readonly Subject[], environment: string): DoctorFinding[] {
  const sealed = subjects.filter(({ resolution }) => resolution.winner?.file.encrypted === true);
  const findings: DoctorFinding[] = [];

  for (const { resolution } of sealed) {
    const failure = resolution.undecryptable;
    if (failure === undefined) {
      continue;
    }
    findings.push({
      check: "encryption",
      severity: "failure",
      label: "Undecryptable value",
      subject: resolution.winner?.location ?? resolution.parameter,
      detail: failure.detail,
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  // Two different quiets, reported differently. "Nothing is encrypted here" and
  // "everything encrypted here opens" are both passes, and a reader who cannot
  // tell them apart cannot tell whether the check ran.
  return [
    {
      check: "encryption",
      severity: "pass",
      label: "Encryption",
      subject:
        sealed.length === 0
          ? `no encrypted value resolves for ${environment}`
          : `every encrypted value resolving for ${environment} decrypts`,
    },
  ];
}

/**
 * A sink report is mostly `unknown` by construction, and honest about it. Three
 * tiers, rendered differently (RFC "A sink is a destination, not a provider"):
 *
 * - **names** are exact, because listing them is the one read the destination
 *   allows: declared-but-never-pushed, and present-in-the-destination-but-
 *   undeclared — the `declared`/`unused` pair pointed at a sink.
 * - **manual edits** are detectable indirectly: GitHub's `updated_at` newer than
 *   penv's own last-push time (kept per environment in committed meta) means the
 *   secret was touched outside penv. A warning, never a failure — it detects that
 *   something was touched, not that the copies differ.
 * - **values** are `unknown`, permanently, because they cannot be read back.
 *
 * The whole report is `unknown` when the destination cannot be reached — the
 * fourth verdict earning its keep against a write-only store.
 */
/** Slack between penv's local push time and the destination's server `updated_at` before a difference reads as a hand-edit. */
const EDIT_SKEW_MS = 120_000;

function buildSink(declared: SinkConfig, override: Sink | undefined): Sink | undefined {
  if (override !== undefined) {
    return override;
  }
  if (declared.type === "github") {
    return createGithubSink(declared.repo === undefined ? {} : { repo: declared.repo });
  }
  return undefined;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split("\n")[0] ?? error.message;
  }
  return String(error);
}

function scopeLabel(scope: SecretScope): string {
  return scope.kind === "repository"
    ? "repository secrets"
    : `environment secrets for ${scope.environment}`;
}

interface Expected {
  readonly ref: Resolution["ref"];
  readonly variable: string;
  readonly scope: SecretScope;
}

async function sinkFindings(
  project: Project,
  environment: string,
  override: Sink | undefined,
): Promise<DoctorFinding[]> {
  const declared = project.config.sinks?.[environment];
  if (declared === undefined) {
    return [];
  }

  const sink = buildSink(declared, override);
  if (sink === undefined) {
    return [
      {
        check: "sink-unreachable",
        severity: "unknown",
        label: "Sink",
        subject: `sink type \`${declared.type}\` is not one penv knows`,
        detail: "penv cannot check a sink it cannot build",
      },
    ];
  }

  try {
    await sink.verify();
  } catch (error) {
    return [
      {
        check: "sink-unreachable",
        severity: "unknown",
        label: "Sink",
        subject: `could not reach the ${declared.type} sink for ${environment}`,
        detail: errorDetail(error),
      },
    ];
  }

  let repoSecrets: SinkSecret[];
  let envSecrets: SinkSecret[];
  try {
    repoSecrets = await sink.list({ kind: "repository" });
    envSecrets = await sink.list({ kind: "environment", environment });
  } catch (error) {
    return [
      {
        check: "sink-unreachable",
        severity: "unknown",
        label: "Sink",
        subject: `could not list secrets in the ${declared.type} sink for ${environment}`,
        detail: errorDetail(error),
      },
    ];
  }

  // The push view: what a push would place, `.local` dropped, so doctor compares
  // the same set a push would send.
  const resolutions = await resolveAll(
    environment,
    project.provider,
    keySourceFor(project, environment),
    true,
  );
  const expected: Expected[] = [];
  for (const resolution of resolutions) {
    const winner = resolution.winner;
    if (winner === undefined) {
      continue;
    }
    expected.push({
      ref: resolution.ref,
      variable: variableName(resolution.ref, project.config),
      scope:
        winner.file.scope.kind === "unscoped"
          ? { kind: "repository" }
          : { kind: "environment", environment },
    });
  }

  // GitHub secret names are case-insensitive, and the pre-flight already refused
  // any case collision, so comparing by uppercase is exact and safe.
  const upper = (name: string): string => name.toUpperCase();
  const repoByName = new Map(repoSecrets.map((secret) => [upper(secret.name), secret]));
  const envByName = new Map(envSecrets.map((secret) => [upper(secret.name), secret]));
  const destOf = (scope: SecretScope): Map<string, SinkSecret> =>
    scope.kind === "repository" ? repoByName : envByName;

  const nameDrift: DoctorFinding[] = [];
  const expectedEnv = new Set<string>();
  // Every variable this environment maps, at any scope. A repository secret is
  // shared across all environments, so it is "declared" as long as *some*
  // parameter produces its name — even one this environment resolves to an
  // environment-scoped override. Judging a repository secret against only this
  // environment's unscoped winners would flag another environment's default.
  const allVariables = new Set<string>();
  for (const item of expected) {
    const key = upper(item.variable);
    allVariables.add(key);
    if (item.scope.kind === "environment") {
      expectedEnv.add(key);
    }
    if (!destOf(item.scope).has(key)) {
      nameDrift.push({
        check: "sink-name-drift",
        severity: "warning",
        label: "Declared, not pushed",
        subject: item.variable,
        detail: `resolves for ${environment} but is absent from the ${scopeLabel(item.scope)}`,
        remedy: `penv push --env ${environment}`,
      });
    }
  }
  for (const secret of repoSecrets) {
    if (!allVariables.has(upper(secret.name))) {
      nameDrift.push({
        check: "sink-name-drift",
        severity: "warning",
        label: "In destination, not declared",
        subject: secret.name,
        detail: `a repository secret with no parameter penv pushes for ${environment}`,
      });
    }
  }
  for (const secret of envSecrets) {
    if (!expectedEnv.has(upper(secret.name))) {
      nameDrift.push({
        check: "sink-name-drift",
        severity: "warning",
        label: "In destination, not declared",
        subject: secret.name,
        detail: `an environment secret with no parameter resolving for ${environment}`,
      });
    }
  }

  const manualEdits: DoctorFinding[] = [];
  for (const item of expected) {
    const secret = destOf(item.scope).get(upper(item.variable));
    if (secret === undefined) {
      continue;
    }
    const pushed = effectiveMeta(await project.provider.readMeta(item.ref), environment)[
      LAST_PUSHED_KEY
    ];
    if (typeof pushed !== "string") {
      continue;
    }
    const destTime = Date.parse(secret.updatedAt);
    const pushTime = Date.parse(pushed);
    // The tolerance absorbs the skew between penv's local clock and GitHub's
    // server clock (and GitHub's whole-second truncation of `updated_at`), so a
    // clean push does not read as an edit. A genuine UI edit lands minutes to
    // days later, well outside it — this is a sensitive detector, not a proof.
    if (Number.isNaN(destTime) || Number.isNaN(pushTime) || destTime <= pushTime + EDIT_SKEW_MS) {
      continue;
    }
    manualEdits.push({
      check: "sink-manual-edit",
      severity: "warning",
      label: "Edited outside penv",
      subject: item.variable,
      detail: `changed in the destination at ${secret.updatedAt}, after penv last pushed it`,
    });
  }

  const findings: DoctorFinding[] = [];
  findings.push(
    ...(nameDrift.length > 0
      ? nameDrift
      : [
          {
            check: "sink-name-drift" as const,
            severity: "pass" as const,
            label: "Sink names",
            subject: `every parameter resolving for ${environment} is present, and nothing undeclared is`,
          },
        ]),
  );
  findings.push(
    ...(manualEdits.length > 0
      ? manualEdits
      : [
          {
            check: "sink-manual-edit" as const,
            severity: "pass" as const,
            label: "Sink hand-edits",
            subject: `no secret has changed outside penv since its last push for ${environment}`,
          },
        ]),
  );
  findings.push({
    check: "sink-value-drift",
    severity: "unknown",
    label: "Sink values",
    subject: "cannot be read back from a write-only destination",
    detail: "value drift between the tree and the destination is unknowable by design",
  });
  return findings;
}

export function renderDoctor(report: DoctorReport): string[] {
  const rows: Row[] = report.findings.map((finding) => ({
    glyph: finding.severity === "pass" ? CHECK : finding.severity === "unknown" ? UNKNOWN : WARN,
    label: finding.label,
    ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    ...(finding.detail === undefined ? {} : { detail: finding.detail }),
  }));

  const lines = formatRows(rows);
  // Below the table rather than beside it: these are lines to paste, and a line
  // to paste has to survive being selected without a report's columns coming
  // with it. Deduped, because two parameters can share a remedy.
  const remedies = [
    ...new Set(
      report.findings
        .filter((finding) => finding.severity !== "pass")
        .map((finding) => finding.remedy)
        .filter((remedy): remedy is string => remedy !== undefined),
    ),
  ];
  for (const remedy of remedies) {
    lines.push(`  ${remedy}`);
  }
  return lines;
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Report missing, weak, unused, fallback, plaintext-secret, and sink-drift issues",
  },
  args: {
    env: { type: "string", description: "The environment to report on" },
  },
  run({ args }) {
    return guard(async () => {
      const report = await runDoctor({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
      });
      write(renderDoctor(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
  },
});
