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
 * - **rotation-overdue** — meta declares a rotation policy and more than its
 *   interval has elapsed since the last completed rotation. A clock no other
 *   check keeps: `missing` sees an absent value, never a stale present one.
 * - **rotation-stuck** — a `dual-valid` grace window opened and never closed. The
 *   overdue clock's opposite: not a rotation that never ran, but one that started
 *   and stalled with two credentials live at once.
 * - **provider-value-drift** — the local tree and the environment's readable
 *   source-of-truth provider hold different opaque values for the same address.
 *   The one drift a value-withholding destination can never report, because a
 *   record-holding provider can be read back and a projection cannot.
 *
 * Warnings are reported; failures are reported and exit non-zero.
 */

import type {
  Meta,
  PenvConfig,
  ProjectionProvider,
  ProjectionSecret,
  Provider,
  Resolution,
  Scope,
  SecretScope,
  ValueFile,
} from "@penvhq/core";
import {
  accessPath,
  assertNever,
  effectiveMeta,
  formatValueFile,
  holdsProjection,
  holdsRecords,
  isPublicVariable,
  isRequired,
  isSecret,
  isStuck,
  openValue,
  resolveAll,
  rotationOf,
  tryParseDuration,
  variableName,
} from "@penvhq/core";
import { defineCommand } from "citty";
import type { z } from "zod";
import { shadowedEnvironments, shorthandCandidates } from "../env-flags.js";
import type { Project } from "../project.js";
import { keySourceFor, openProject, sourceProviderFor, targetEnvironment } from "../project.js";
import { LOCAL_TREE_TYPE } from "../registry.js";
import type { DriftReport } from "../schema.js";
import { computeDrift, lookup, minLengthOf } from "../schema.js";
import { out } from "../style.js";
import {
  CHECK,
  CROSS,
  formatRows,
  guard,
  heading,
  type Row,
  tip,
  UNKNOWN,
  WARN,
  write,
} from "../ui.js";
import { LAST_PUSHED_KEY } from "./push.js";
import { loadSchema } from "./validate.js";

/**
 * A check reports one of four verdicts. `unknown` — a check that ran but could
 * not reach a verdict — is never rendered as a pass: "I looked and found nothing
 * wrong" and "I could not look" are opposite situations with opposite remedies,
 * and a value-withholding destination makes most of what doctor can say the
 * second kind.
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
  | "rotation-overdue"
  | "rotation-stuck"
  | "provider-value-drift"
  | "provider"
  | "projection-unreachable"
  | "projection-name-drift"
  | "projection-manual-edit"
  | "projection-value-drift"
  | "environment-flag-shadow";

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
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
  /** Injected in tests: the projection-holding destination to check against. Defaults to the one the config declares. */
  readonly projection?: ProjectionProvider;
  /**
   * Injected in tests: the source-of-truth provider to compare the local tree
   * against. Defaults to the one the config declares (`sourceProviderFor`).
   * Mirrors `projection`, for the same reason — the drift checks stay driveable
   * without a live backend.
   */
  readonly source?: Provider;
  /** Injected in tests: the wall-clock reading the rotation clocks are read against. Defaults to now. */
  readonly now?: string;
  /** Injected in tests: how long a `dual-valid` window may stay open before it reads as stuck. Defaults to 24h. */
  readonly stuckThresholdMs?: number;
}

/**
 * How long a `dual-valid` grace window may stay open before `rotation-stuck`
 * flags it. A day is generous for the overlap most rotations need — long enough
 * that a healthy rotation completing within a deploy or two never trips it, short
 * enough that a window left open for a week is caught while it still matters.
 */
const STUCK_THRESHOLD_MS = 86_400_000;

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
  const environment = targetEnvironment(project, options.environment, options.envFlags);
  const findings: DoctorFinding[] = [];
  // The wall clock, read once and passed down — never read inside a check — so the
  // rotation boundaries the roadmap names are testable without mocking time, the
  // same discipline `rotation.ts` and `push.ts` keep.
  const now = new Date(options.now ?? new Date().toISOString());
  const stuckThresholdMs = options.stuckThresholdMs ?? STUCK_THRESHOLD_MS;

  // Rule 1 of the environment shorthand flags: a real flag always wins, so an
  // environment sharing a flag's name simply has no shorthand. Said here, once,
  // rather than discovered as a flag that quietly means something else.
  for (const shadowed of shadowedEnvironments(project.config)) {
    findings.push({
      check: "environment-flag-shadow",
      severity: "warning",
      label: "Environment shadows a flag",
      subject: shadowed,
      detail: `\`--${shadowed}\` is a flag penv defines, so this environment has no shorthand — \`--env ${shadowed}\` always works`,
    });
  }

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
  // The rotation clocks read the environment's SOURCE provider, not `subjects`,
  // whose meta is the local tree's. `penv rotate` writes `rotatingSince` /
  // `state` / `lastRotated` to the source of truth (a `dual-valid` rotation
  // REQUIRES a retaining backend, so its rotating-state meta is never in the
  // local tree at all) — reading `subjects` here saw stale local meta and never
  // fired for a backend-backed environment.
  const rotation = await rotationSubjects(project, environment, subjects, options.source);
  if (rotation.kind === "unreachable") {
    findings.push(rotation.finding);
  } else {
    findings.push(...overdueFindings(rotation.subjects, environment, now));
    findings.push(...stuckFindings(rotation.subjects, environment, now, stuckThresholdMs));
  }
  findings.push(...(await providerDriftFindings(project, environment, options.source)));
  findings.push(...(await projectionFindings(project, environment, options.projection)));

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
 * `override` entry is what decides the string the framework sees, and it is the
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
 * A report against a projection-holding, value-withholding provider is mostly
 * `unknown` by construction, and honest about it. Three tiers, rendered
 * differently (RFC "Everything the config names is a provider"):
 *
 * - **names** are exact, because listing them is the one read the destination
 *   allows: declared-but-never-pushed, and present-in-the-destination-but-
 *   undeclared — the `declared`/`unused` pair pointed at the store.
 * - **manual edits** are detectable indirectly: GitHub's `updated_at` newer than
 *   penv's own last-push time (kept per environment in committed meta) means the
 *   secret was touched outside penv. A warning, never a failure — it detects that
 *   something was touched, not that the copies differ.
 * - **values** are `unknown`, permanently, because they cannot be read back.
 *
 * The whole report is `unknown` when the destination cannot be reached — the
 * fourth verdict earning its keep against a value-withholding store.
 */
/** Slack between penv's local push time and the destination's server `updated_at` before a difference reads as a hand-edit. */
const EDIT_SKEW_MS = 120_000;

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

async function projectionFindings(
  project: Project,
  environment: string,
  override: ProjectionProvider | undefined,
): Promise<DoctorFinding[]> {
  let projection: ProjectionProvider;
  if (override !== undefined) {
    projection = override;
  } else {
    const declared = project.config.providers[environment];
    if (declared === undefined || declared.type === LOCAL_TREE_TYPE) {
      return [];
    }
    let source: Awaited<ReturnType<typeof sourceProviderFor>>;
    try {
      source = await sourceProviderFor(project, environment);
    } catch (error) {
      return [
        {
          check: "projection-unreachable",
          severity: "unknown",
          label: "Destination",
          subject: `could not build the ${declared.type} provider for ${environment}`,
          detail: errorDetail(error),
        },
      ];
    }
    // A record-holding source is checked value by value in
    // `providerDriftFindings`; these tiers exist only for the store that
    // withholds its values.
    if (!holdsProjection(source)) {
      return [];
    }
    projection = source;
  }

  try {
    await projection.verify();
  } catch (error) {
    return [
      {
        check: "projection-unreachable",
        severity: "unknown",
        label: "Destination",
        subject: `could not reach the ${projection.type} destination for ${environment}`,
        detail: errorDetail(error),
      },
    ];
  }

  let repoSecrets: ProjectionSecret[];
  let envSecrets: ProjectionSecret[];
  try {
    repoSecrets = await projection.list({ kind: "repository" });
    envSecrets = await projection.list({ kind: "environment", environment });
  } catch (error) {
    return [
      {
        check: "projection-unreachable",
        severity: "unknown",
        label: "Destination",
        subject: `could not list secrets in the ${projection.type} destination for ${environment}`,
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
  const destOf = (scope: SecretScope): Map<string, ProjectionSecret> =>
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
        check: "projection-name-drift",
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
        check: "projection-name-drift",
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
        check: "projection-name-drift",
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
      check: "projection-manual-edit",
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
            check: "projection-name-drift" as const,
            severity: "pass" as const,
            label: "Destination names",
            subject: `every parameter resolving for ${environment} is present, and nothing undeclared is`,
          },
        ]),
  );
  findings.push(
    ...(manualEdits.length > 0
      ? manualEdits
      : [
          {
            check: "projection-manual-edit" as const,
            severity: "pass" as const,
            label: "Destination hand-edits",
            subject: `no secret has changed outside penv since its last push for ${environment}`,
          },
        ]),
  );
  findings.push({
    check: "projection-value-drift",
    severity: "unknown",
    label: "Destination values",
    subject: "cannot be read back from a write-only destination",
    detail: "value drift between the tree and the destination is unknowable by design",
  });
  return findings;
}

/** A rough, human-facing span — the largest whole unit that fits. Never precise, and never claims to be. */
function humanizeMs(ms: number): string {
  const abs = Math.max(0, ms);
  const day = 86_400_000;
  const hour = 3_600_000;
  const minute = 60_000;
  const round = (value: number, unit: string): string => {
    const n = Math.round(value);
    return `${n} ${unit}${n === 1 ? "" : "s"}`;
  };
  if (abs >= day) return round(abs / day, "day");
  if (abs >= hour) return round(abs / hour, "hour");
  if (abs >= minute) return round(abs / minute, "minute");
  return round(abs / 1000, "second");
}

/** The `<namespace>/<name>` path a `penv rotate` remedy pastes. */
function refPathOf(ref: Resolution["ref"]): string {
  return [...ref.namespace, ref.name].join("/");
}

/**
 * The rotation clocks read the environment's source of truth, so this reads each
 * parameter's meta from the SOURCE provider rather than the local tree.
 *
 * `penv rotate` writes rotation state (`rotatingSince` / `state` / `lastRotated`)
 * to `sourceProviderFor(environment)` — a backend for a vault/mock env — and a
 * `dual-valid` rotation cannot run without one, so a backend-backed env's
 * rotating-state meta is NEVER in the local `.penv` tree. Reading `subjects`
 * (whose meta is the local tree's) left the overdue/stuck checks reading stale
 * local meta that never fired.
 *
 * When the source IS the local tree — the env declares no backend, or declares
 * `filesystem` — the two coincide, so the metas already read for `subjects` are
 * reused rather than round-tripping the identical files a second time. A backend
 * is read once, wrapped in try/catch: an unreachable source yields a single
 * `unknown` rotation finding, mirroring `projectionFindings`' tiering, because "the
 * clock says overdue" and "penv could not read the clock" are opposite verdicts.
 */
type RotationSubjects =
  | { readonly kind: "read"; readonly subjects: readonly Subject[] }
  | { readonly kind: "unreachable"; readonly finding: DoctorFinding };

async function rotationSubjects(
  project: Project,
  environment: string,
  local: readonly Subject[],
  override: Provider | undefined,
): Promise<RotationSubjects> {
  const providerConfig = project.config.providers[environment];
  // No override and a local-tree source: the meta is the same meta `subjects`
  // already hold, so reuse it and make no extra round-trips.
  if (
    override === undefined &&
    (providerConfig === undefined || providerConfig.type === LOCAL_TREE_TYPE)
  ) {
    return { kind: "read", subjects: local };
  }

  const source = override ?? (await sourceProviderFor(project, environment));
  // A projection-holding destination stores no meta at all, so the local tree
  // stays the keeper of this environment's rotation clocks.
  if (!holdsRecords(source)) {
    return { kind: "read", subjects: local };
  }
  try {
    const subjects: Subject[] = await Promise.all(
      local.map(async ({ resolution }) => ({
        resolution,
        meta: await source.readMeta(resolution.ref),
      })),
    );
    return { kind: "read", subjects };
  } catch (error) {
    return {
      kind: "unreachable",
      finding: {
        check: "rotation-overdue",
        severity: "unknown",
        label: "Rotation",
        subject: `could not reach the ${providerConfig?.type ?? source.type} source of truth for ${environment}`,
        detail: errorDetail(error),
      },
    };
  }
}

/**
 * A staleness clock no other check keeps: `missing` reports a value that is
 * absent, and this reports one that is present and too old. The two are opposite
 * failures — a value nobody set, and a value nobody has changed in longer than
 * its own policy allows — and only meta's `rotationPolicy` plus `lastRotated`
 * make the second visible at all.
 *
 * The policy is parsed ONCE, here, inside `tryParseDuration`. The old code called
 * `isOverdue` (which parses via the throwing `parseDuration`) in this unguarded
 * loop, then parsed a SECOND time for the `overdueBy` text — so a single policy
 * `parseDuration` rejects (`1h30m`, `3 months`) threw straight out and aborted
 * the entire doctor run through `guard()`, blinding every other check on one bad
 * meta field. Now an unparseable policy is a warning on that one parameter and
 * the sweep continues, and the single parsed interval feeds both the overdue
 * decision and the message. A parameter with no policy, or one that has never
 * rotated, is not on a clock and is silently not overdue.
 */
function overdueFindings(
  subjects: readonly Subject[],
  environment: string,
  now: Date,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { resolution, meta } of subjects) {
    const { policy, lastRotated } = rotationOf(meta, environment);
    // Not on a clock: no interval declared, or never rotated. Not late.
    if (policy === undefined || lastRotated === null) {
      continue;
    }
    // Parse once, non-throwing. A policy penv cannot read used to throw here and
    // abort the whole run; now it is this parameter's own warning and nothing
    // else is lost.
    const interval = tryParseDuration(policy);
    if (interval === undefined) {
      findings.push({
        check: "rotation-overdue",
        severity: "warning",
        label: "Rotation policy invalid",
        subject: resolution.parameter,
        detail: `rotationPolicy \`${policy}\` is not a duration penv can parse (e.g. \`90d\`, \`24h\`)`,
      });
      continue;
    }
    const last = Date.parse(lastRotated);
    if (Number.isNaN(last)) {
      continue;
    }
    // The same boundary `isOverdue` keeps: exactly at the interval is not yet
    // overdue, strictly past it is. Reusing `interval` is what kills the second
    // parse the old `overdueBy` line made.
    const overdueBy = now.getTime() - last - interval;
    if (overdueBy <= 0) {
      continue;
    }
    findings.push({
      check: "rotation-overdue",
      severity: "warning",
      label: "Rotation overdue",
      subject: resolution.parameter,
      detail: `overdue by ~${humanizeMs(overdueBy)}, policy ${policy}`,
      remedy: `penv rotate ${refPathOf(resolution.ref)} --env ${environment}`,
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "rotation-overdue",
      severity: "pass",
      label: "Rotation freshness",
      subject: `no parameter is past its rotation policy for ${environment}`,
    },
  ];
}

/**
 * The overdue clock's opposite: not a rotation that never ran, but one that
 * started and stalled. A `dual-valid` window is meant to open, let readers move
 * over, and close; a `rotatingSince` older than the threshold is a window that
 * opened and never did.
 *
 * Gated to `dual-valid` entirely — `isStuck` refuses every other mechanism, and
 * that refusal is the point. An `atomic-cutover` parameter overlaps only at the
 * infra layer and holds no penv-layer grace window, so a long-lived
 * `rotatingSince` on one is not stuck and must never be flagged; this check keeps
 * that promise by asking `isStuck` and never re-deriving the mechanism itself.
 */
function stuckFindings(
  subjects: readonly Subject[],
  environment: string,
  now: Date,
  stuckThresholdMs: number,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { resolution, meta } of subjects) {
    if (!isStuck(meta, environment, now, stuckThresholdMs)) {
      continue;
    }
    const { rotatingSince } = rotationOf(meta, environment);
    // isStuck was true, so the window is open with a parseable clock; the guard is
    // for the types, not a reachable path.
    if (rotatingSince === null) {
      continue;
    }
    const openFor = now.getTime() - Date.parse(rotatingSince);
    findings.push({
      check: "rotation-stuck",
      severity: "warning",
      label: "Rotation stuck",
      subject: resolution.parameter,
      detail: `dual-valid window open ~${humanizeMs(openFor)}, past the ${humanizeMs(stuckThresholdMs)} grace window`,
      remedy: `penv rotate ${refPathOf(resolution.ref)} --complete --env ${environment}`,
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "rotation-stuck",
      severity: "pass",
      label: "Rotation progress",
      subject: `no dual-valid rotation has stayed open past its grace window for ${environment}`,
    },
  ];
}

/** One value file the drift check has read, kept with its raw stored string so a sealed local value can still be opened. */
interface DriftEntry {
  readonly file: ValueFile;
  readonly stored: string;
}

/**
 * The LOGICAL identity of a value file — namespace, name, and scope — with the
 * `.enc` marker deliberately dropped.
 *
 * `formatValueFile` encodes `encrypted`, so keying by it split an encrypted-local
 * value from its plaintext-source twin: the same logical parameter at the same
 * scope read as two one-sided addresses, a perpetual false drift the byte compare
 * never got to run. Encryption is a property of the local envelope, not of the
 * address, so it must not be part of the key two stores are matched on. Mirrors
 * the mock provider's `valueKey`, minus exactly that `encrypted` field.
 */
function driftKey(file: ValueFile): string {
  return [file.namespace.join("/"), file.name, scopeKey(file.scope)].join(" ");
}

function scopeKey(scope: Scope): string {
  switch (scope.kind) {
    case "unscoped":
      return "unscoped";
    case "environment":
      return `environment:${scope.environment}`;
    case "local":
      return "local";
    case "environment-local":
      return `environment-local:${scope.environment}`;
    default:
      return assertNever(scope, "scope");
  }
}

/**
 * The value files that have a source-of-truth twin to drift against: the pushable
 * set for this environment — the unscoped default and this environment's own
 * scope, and nothing else.
 *
 * The old check compared the ENTIRE local tree (`project.provider.list()` is
 * every environment's files) against one env's source, so `doctor --env
 * production` flooded "Only in the local tree" for every development/staging
 * value. Both `.local` scopes are personal and never reach a backend; every other
 * environment's scoped file is that environment's business, not this one's. The
 * same filter is applied to both sides.
 */
function relevantToEnvironment(file: ValueFile, environment: string): boolean {
  const scope = file.scope;
  if (scope.kind === "unscoped") return true;
  if (scope.kind === "environment") return scope.environment === environment;
  // Both `.local` scopes, and every other environment's scope: not pushed here.
  return false;
}

/**
 * Reads a provider's value files relevant to this environment into a logical
 * address → entry map, the raw stored strings kept unopened.
 *
 * Values are read in `list` order and mapped afterwards, so a same-address
 * collision (a plaintext and a sealed file at one scope) resolves the same way on
 * every machine rather than by Promise race. An address that `list` names but
 * `read` returns absent — a concurrent prune — is dropped, nothing to compare.
 */
async function readRelevant(
  provider: Provider,
  environment: string,
): Promise<Map<string, DriftEntry>> {
  const files = (await provider.list()).filter((file) => relevantToEnvironment(file, environment));
  const stored = await Promise.all(files.map((file) => provider.read(file)));
  const entries = new Map<string, DriftEntry>();
  for (const [index, file] of files.entries()) {
    const value = stored[index];
    if (value !== undefined) {
      entries.set(driftKey(file), { file, stored: value });
    }
  }
  return entries;
}

/**
 * The one drift a value-withholding destination can never report. `projection-value-drift` is permanently
 * `unknown` because a write-only destination cannot be read back; a provider is
 * the system of record precisely because it can, so here penv actually looks —
 * comparing PLAINTEXT, value by value.
 *
 * Custody model: the source of truth holds verbatim plaintext (the way `pull` and
 * `rotate` move it there), while the local tree may hold the value sealed. So a
 * sealed local value is opened before the compare — an encrypted-local vs
 * plaintext-source pair carrying the same secret is IN SYNC, not drift. A sealed
 * value that cannot be opened (the key is gone) is `unknown` for that parameter,
 * never a false disagreement: penv could not read one side, so it cannot say the
 * two agree or differ.
 *
 * When the environment keeps its values in the local tree there is no second
 * system of record, so this is a plain `pass` — "not applicable", never
 * `unknown`: penv could look and there was one copy by design. An unreachable
 * source *is* `unknown`, mirroring `projectionFindings`' try/catch tiering: a differing
 * value and an unreachable store are opposite verdicts with opposite remedies.
 */
async function providerDriftFindings(
  project: Project,
  environment: string,
  override: Provider | undefined,
): Promise<DoctorFinding[]> {
  const providerConfig = project.config.providers[environment];
  if (providerConfig === undefined || providerConfig.type === LOCAL_TREE_TYPE) {
    return [
      {
        check: "provider-value-drift",
        severity: "pass",
        label: "Provider values",
        subject: `${environment} keeps its values in the local .penv tree, so there is no other source of truth to compare against`,
      },
    ];
  }

  const source = override ?? (await sourceProviderFor(project, environment));
  // A value-withholding destination has nothing to compare value by value; its
  // tiers — exact names, unknown values, indirect hand-edits — are
  // `projectionFindings`' and are reported there.
  if (!holdsRecords(source)) {
    return [];
  }

  let local: Map<string, DriftEntry>;
  let remote: Map<string, DriftEntry>;
  try {
    local = await readRelevant(project.provider, environment);
    remote = await readRelevant(source, environment);
  } catch (error) {
    return [
      {
        check: "provider-value-drift",
        severity: "unknown",
        label: "Provider values",
        subject: `could not reach the ${providerConfig.type} provider for ${environment}`,
        detail: errorDetail(error),
      },
    ];
  }

  const keys = keySourceFor(project, environment);
  const findings: DoctorFinding[] = [];
  // Sorted so the report is identical on every machine, the same rule `refsFrom` keeps.
  const addresses = [...new Set([...local.keys(), ...remote.keys()])].sort();
  for (const address of addresses) {
    const here = local.get(address);
    const there = remote.get(address);
    if (here !== undefined && there !== undefined) {
      // Open the local value if it is sealed; the source is verbatim plaintext.
      // `openValue` returns a plaintext file unchanged, so this is unconditional.
      const opened = openValue(here.file, here.stored, keys);
      if (opened.kind !== "plaintext") {
        // A sealed value penv cannot open: the key is gone. Not drift — penv
        // could not read this side, so it cannot claim the two stores agree or
        // differ. The opposite of a false failure.
        findings.push({
          check: "provider-value-drift",
          severity: "unknown",
          label: "Provider value unreadable",
          subject: formatValueFile(here.file),
          detail: `the local value is sealed and did not open, so it cannot be compared against the ${providerConfig.type} source of truth`,
        });
        continue;
      }
      // A plaintext comparison. Drift in the system of record is serious: the
      // tree and the backend claim different truths for one address, and
      // something deploys the wrong one.
      if (opened.value !== there.stored) {
        findings.push({
          check: "provider-value-drift",
          severity: "failure",
          label: "Provider value drift",
          subject: formatValueFile(here.file),
          detail: `the local tree and the ${providerConfig.type} source of truth hold different values`,
        });
      }
      continue;
    }
    const present = here ?? there;
    // `present` is defined: the address is in the union, so at least one side has it.
    if (present === undefined) {
      continue;
    }
    findings.push({
      check: "provider-value-drift",
      severity: "warning",
      label: here !== undefined ? "Only in the local tree" : "Only in the source",
      subject: formatValueFile(present.file),
      detail:
        here !== undefined
          ? `present locally, absent from the ${providerConfig.type} source of truth`
          : `present in the ${providerConfig.type} source of truth, absent from the local tree`,
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "provider-value-drift",
      severity: "pass",
      label: "Provider values",
      subject: `every value matches the ${providerConfig.type} source of truth for ${environment}`,
    },
  ];
}

const GLYPHS: Readonly<Record<DoctorSeverity, string>> = {
  pass: CHECK,
  warning: WARN,
  failure: CROSS,
  unknown: UNKNOWN,
};

/** The one-line verdict under the table: every severity counted, colored to match its glyph. */
function summarize(report: DoctorReport): string {
  const counts = { pass: 0, warning: 0, failure: 0, unknown: 0 };
  for (const finding of report.findings) {
    counts[finding.severity] += 1;
  }
  const parts = [out.green(`${counts.pass} passed`)];
  if (counts.warning > 0) {
    parts.push(out.yellow(`${counts.warning} ${counts.warning === 1 ? "warning" : "warnings"}`));
  }
  if (counts.failure > 0) {
    parts.push(out.red(`${counts.failure} ${counts.failure === 1 ? "failure" : "failures"}`));
  }
  if (counts.unknown > 0) {
    parts.push(out.dim(`${counts.unknown} could not be checked`));
  }
  const verdict = report.ok ? out.green(CHECK) : out.red(CROSS);
  return `${verdict} ${report.findings.length} checks: ${parts.join(out.dim(" · "))}`;
}

export function renderDoctor(report: DoctorReport): string[] {
  const rows: Row[] = report.findings.map((finding) => ({
    glyph: GLYPHS[finding.severity],
    label: finding.label,
    ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    ...(finding.detail === undefined ? {} : { detail: finding.detail }),
  }));

  const lines = [heading("penv doctor", `environment ${report.environment}`), ""];
  lines.push(...formatRows(rows));
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
  if (remedies.length > 0) {
    lines.push("");
    for (const remedy of remedies) {
      lines.push(tip(remedy));
    }
  }
  lines.push("", summarize(report));
  return lines;
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Report missing, weak, unused, fallback, plaintext-secret, and drift issues",
  },
  args: {
    env: { type: "string", description: "The environment to report on" },
  },
  run({ args }) {
    return guard(async () => {
      const report = await runDoctor({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        envFlags: shorthandCandidates(args, ["env"]),
      });
      write(renderDoctor(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    });
  },
});
