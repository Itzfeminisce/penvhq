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
 *
 * Warnings are reported; failures are reported and exit non-zero.
 */

import type { Meta, Resolution } from "@penv/core";
import { accessPath, isRequired, isSecret, resolveAll } from "@penv/core";
import { defineCommand } from "citty";
import type { z } from "zod";
import { keySourceFor, openProject, targetEnvironment } from "../project.js";
import type { DriftReport } from "../schema.js";
import { computeDrift, lookup, minLengthOf } from "../schema.js";
import { CHECK, formatRows, guard, type Row, WARN, write } from "../ui.js";
import { loadSchema } from "./validate.js";

export type DoctorSeverity = "pass" | "warning" | "failure";

export type DoctorCheck =
  | "schema"
  | "missing"
  | "declared"
  | "weak"
  | "unused"
  | "unscoped-fallback"
  | "plaintext-secret"
  | "encryption"
  | "provider";

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
  /** False when any finding is a failure. Warnings do not fail the run. */
  readonly ok: boolean;
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly environment?: string;
}

interface Subject {
  readonly resolution: Resolution;
  readonly meta: Meta | undefined;
}

/** A check the schema failure above made impossible. Reported, never omitted. */
function skipped(check: DoctorCheck, label: string): DoctorFinding {
  return {
    check,
    severity: "warning",
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
  findings.push(...encryptionFindings(subjects, environment));

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

export function renderDoctor(report: DoctorReport): string[] {
  const rows: Row[] = report.findings.map((finding) => ({
    glyph: finding.severity === "pass" ? CHECK : WARN,
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
    description: "Report missing, weak, unused, fallback, and plaintext-secret issues",
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
