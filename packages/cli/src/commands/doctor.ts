/**
 * `penv doctor` — one report of everything that has drifted.
 *
 * Each check earns its place by catching something no other command can:
 *
 * - **missing** — meta marks a parameter required for this environment and it
 *   resolves to nothing. Requiredness per environment is meta policy, not a
 *   second schema (invariant 1).
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

import type { Meta, PenvConfig, Resolution } from "@penv/core";
import { accessPath, isRequired, isSecret, variableName } from "@penv/core";
import { defineCommand } from "citty";
import type { z } from "zod";
import { describeAll, openProject, targetEnvironment } from "../project.js";
import { CHECK, formatRows, guard, type Row, WARN, write } from "../ui.js";
import { loadSchema } from "./validate.js";

export type DoctorSeverity = "pass" | "warning" | "failure";

export type DoctorCheck =
  | "schema"
  | "missing"
  | "weak"
  | "unused"
  | "unscoped-fallback"
  | "plaintext-secret"
  | "provider";

export interface DoctorFinding {
  readonly check: DoctorCheck;
  readonly severity: DoctorSeverity;
  readonly label: string;
  readonly subject?: string;
  readonly detail?: string;
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

/*
 * Schema introspection.
 *
 * Every helper answers "I cannot tell" rather than guessing. A check that fires
 * on a field it does not understand is worse than a check that stays quiet: the
 * report is only worth reading if every line in it is true.
 */

function defOf(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const def = (node as { def?: unknown }).def;
  return typeof def === "object" && def !== null ? (def as Record<string, unknown>) : undefined;
}

function typeOf(node: unknown): string | undefined {
  const type = defOf(node)?.type;
  return typeof type === "string" ? type : undefined;
}

/** Peels `.optional()`, `.default()`, `.nullable()` — wrappers, not shapes. */
function unwrap(node: unknown): unknown {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = defOf(current)?.innerType;
    if (inner === undefined) {
      return current;
    }
    current = inner;
  }
  return current;
}

function shapeOf(node: unknown): Record<string, unknown> | undefined {
  if (typeOf(node) !== "object") {
    return undefined;
  }
  const shape = (node as { shape?: unknown }).shape;
  return typeof shape === "object" && shape !== null
    ? (shape as Record<string, unknown>)
    : undefined;
}

type Lookup =
  | { readonly kind: "found"; readonly node: unknown }
  | { readonly kind: "absent" }
  /** The schema is not introspectable this far down. Every check skips it. */
  | { readonly kind: "unknown" };

function lookup(root: z.ZodType, path: readonly string[]): Lookup {
  let node: unknown = unwrap(root);
  for (const key of path) {
    const shape = shapeOf(node);
    if (shape === undefined) {
      return { kind: "unknown" };
    }
    if (!Object.hasOwn(shape, key)) {
      return { kind: "absent" };
    }
    node = unwrap(shape[key]);
  }
  return { kind: "found", node };
}

/** The declared minimum length, when the field is a string that declares one. */
function minLengthOf(node: unknown): number | undefined {
  if (typeOf(node) !== "string") {
    return undefined;
  }
  const min = (node as { minLength?: unknown }).minLength;
  return typeof min === "number" ? min : undefined;
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

  const resolutions = await describeAll(environment, project.provider);
  const subjects: Subject[] = await Promise.all(
    resolutions.map(async (resolution) => ({
      resolution,
      meta: await project.provider.readMeta(resolution.ref),
    })),
  );

  findings.push(...missingFindings(subjects, environment));
  // A check that could not run says so. Printing nothing where a check belongs
  // reads as "nothing found", which is the one thing a report must never imply.
  if (schema === undefined) {
    findings.push(skipped("weak", "Secret strength"), skipped("unused", "Schema coverage"));
  } else {
    findings.push(...weakFindings(subjects, schema));
    findings.push(...unusedFindings(subjects, schema, project.config));
  }
  findings.push(...fallbackFindings(subjects, environment));
  findings.push(...plaintextSecretFindings(subjects, environment));

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

function weakFindings(subjects: readonly Subject[], schema: z.ZodType): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  let checked = 0;

  for (const { resolution } of subjects) {
    const value = resolution.value;
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

function unusedFindings(
  subjects: readonly Subject[],
  schema: z.ZodType,
  config: PenvConfig,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { resolution } of subjects) {
    if (lookup(schema, accessPath(resolution.ref)).kind !== "absent") {
      continue;
    }
    findings.push({
      check: "unused",
      severity: "warning",
      label: "Unused parameter",
      subject: variableName(resolution.ref, config),
      detail: "present, not in schema",
    });
  }

  if (findings.length > 0) {
    return findings;
  }
  return [
    {
      check: "unused",
      severity: "pass",
      label: "Schema coverage",
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

export function renderDoctor(report: DoctorReport): string[] {
  const rows: Row[] = report.findings.map((finding) => ({
    glyph: finding.severity === "pass" ? CHECK : WARN,
    label: finding.label,
    ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    ...(finding.detail === undefined ? {} : { detail: finding.detail }),
  }));
  return formatRows(rows);
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
