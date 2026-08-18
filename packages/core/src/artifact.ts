/**
 * The sealed deployment artifact — format 1, canonical JSON.
 *
 * One environment, one release, built by CI and stored outside git and outside
 * the application source. It is what replaced the committed `penv.snapshot.ts`:
 * an *external* file the container mounts, read by `penv run --source snapshot`
 * with no source files, no provider adapter, and no network.
 *
 * What it carries is the whole of what a delivery needs and nothing else: the
 * format, the environment, the engine that wrote it, a non-secret digest of the
 * delivery contract, the identifier of the key source (never a key), and one
 * entry per schema-declared delivery mapping. What it never carries is stated by
 * the shape rather than by a promise — the object is closed, so provider
 * configuration and credentials have nowhere to go, and every entry is one of
 * three kinds, none of which is "a plaintext secret".
 *
 * Sealed values travel **verbatim**. The ciphertext in the artifact is the
 * ciphertext in the record, alongside the address it was sealed at, so building
 * an artifact never decrypts anything and CI never needs the key. That is also
 * what keeps invariant 17 exact: the AAD is still the value file's full name, so
 * a ciphertext lifted from one scope into another still fails to open.
 *
 * Serialization is deterministic — keys sorted, two-space indent, one trailing
 * newline — so the same tree builds the same bytes on every machine, and a
 * rebuild that differs is a change in the tree rather than in the writer.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { PenvError } from "./errors.js";

/** The only layout this engine understands. A new key means a new format. */
export const ARTIFACT_FORMAT = 1;

/** The command every artifact refusal points at. */
export const ARTIFACT_BUILD_COMMAND = "penv artifact build --env <environment> --out <path>";

/** An artifact problem: one thing wrong, one thing to do about it. */
export class ArtifactError extends PenvError {
  override readonly name = "ArtifactError";
}

/**
 * The artifact declares a format this engine does not implement.
 *
 * Separate from every other refusal and checked before them, because an artifact
 * from a newer penv is not a broken artifact: reporting it as a dozen unknown
 * keys would send the reader editing a file whose only problem is that the penv
 * reading it is old.
 */
export class UnsupportedArtifactFormatError extends PenvError {
  override readonly name = "UnsupportedArtifactFormatError";
  readonly found: number;
  readonly supported: number = ARTIFACT_FORMAT;

  constructor(source: string, found: number) {
    super(
      "ARTIFACT_FORMAT_UNSUPPORTED",
      `${source} is format ${found}, and this penv understands format ${ARTIFACT_FORMAT}`,
      `Rebuild it with the penv that reads it: \`${ARTIFACT_BUILD_COMMAND}\`.`,
    );
    this.found = found;
  }
}

/** A generated variable name — what the child environment is keyed by. */
const VARIABLE = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * One delivery mapping's winner.
 *
 * `absent` is a value in its own right and not an omission. Every schema-declared
 * mapping appears, so a run from an artifact can *delete* a variable the schema
 * declares and the environment does not supply — the same exclusivity a run from
 * the project tree applies. Leaving it out would let a stale variable in the
 * container stand in for a value penv resolved to nothing.
 */
const ENTRY = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), variable: VARIABLE, value: z.string() }),
  z.strictObject({
    kind: z.literal("sealed"),
    variable: VARIABLE,
    /** The value file's full name — the AAD the ciphertext is bound to. */
    address: z.string().min(1),
    sealed: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("absent"), variable: VARIABLE }),
]);

const ARTIFACT = z.strictObject({
  format: z.literal(ARTIFACT_FORMAT),
  environment: z.string().min(1),
  engineVersion: z.string().min(1),
  /** Non-secret: the delivery mappings, hashed. Never the schema's values. */
  schemaDigest: z.string().min(1),
  /** Where the key lives, never the key — `env:prod`, `keychain:prod`, or `none`. */
  keySource: z.string().min(1),
  /** Keyed by parameter id (`redis.password`), so the order is the tree's. */
  values: z.record(z.string().min(1), ENTRY),
});

export type Artifact = z.infer<typeof ARTIFACT>;
export type ArtifactEntry = z.infer<typeof ENTRY>;

/**
 * The delivery contract, hashed: every parameter id with the variable it
 * delivers to and, where it is sealed, the address its ciphertext is bound to —
 * sorted.
 *
 * Non-secret by construction — it is names, never values, so an artifact can
 * carry it and a log can print it. It is what `--source snapshot` checks before
 * it decrypts anything: an artifact whose mappings were edited after it was
 * built no longer hashes to the digest it declares, and penv refuses instead of
 * injecting an environment nobody built.
 *
 * The address is in the material because it travels with the ciphertext it
 * unlocks. Without it a sealed `(address, sealed)` pair moved from one parameter
 * to another still parses, still opens — the AAD moved too — and delivers the
 * database password under the analytics variable. It is a name, and stable
 * across re-seals at the same scope, so a rebuild after `penv set` hashes the
 * same: values never enter here.
 */
export function deliveryDigest(values: Readonly<Record<string, ArtifactEntry>>): string {
  const contract = Object.keys(values)
    .sort()
    .map((id) => {
      const entry = values[id];
      if (entry === undefined) {
        return [id, ""];
      }
      return entry.kind === "sealed" ? [id, entry.variable, entry.address] : [id, entry.variable];
    });
  return `sha256-${createHash("sha256").update(JSON.stringify(contract)).digest("base64url")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortDeep(value[key]);
  }
  return sorted;
}

/**
 * The artifact's bytes: validated, keys sorted, two-space indent, one trailing
 * newline. Validated on the way out as well as in, because the alternative is an
 * artifact no penv can read, written by the one command that exists to write it.
 */
export function serializeArtifact(artifact: Artifact): string {
  const parsed = ARTIFACT.safeParse(artifact);
  if (!parsed.success) {
    throw new ArtifactError(
      "ARTIFACT_INVALID",
      `penv built something that is not a format ${ARTIFACT_FORMAT} artifact: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      `Report this — \`${ARTIFACT_BUILD_COMMAND}\` writes this file, so penv wrote it wrong.`,
    );
  }
  return `${JSON.stringify(sortDeep(parsed.data), null, 2)}\n`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Reads an artifact, or says the one thing wrong with it.
 *
 * The order is the design: the format gate first, then the shape, then the
 * delivery digest — and none of them consults a key. An artifact is checked
 * whole before a single ciphertext is opened, so a damaged one is a named
 * refusal rather than a decryption failure that reads like a missing key.
 */
export function parseArtifact(text: string, source: string): Artifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ArtifactError(
      "ARTIFACT_PARSE",
      `${source} is not valid JSON: ${detail}`,
      `Rebuild it with \`${ARTIFACT_BUILD_COMMAND}\` — penv writes this file, so a syntax error in it is an edit that went wrong.`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ArtifactError(
      "ARTIFACT_ROOT",
      `${source} holds ${describeType(parsed)} at its root, not a deployment artifact`,
      `Rebuild it with \`${ARTIFACT_BUILD_COMMAND}\`.`,
    );
  }

  const format = parsed.format;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    throw new ArtifactError(
      "ARTIFACT_FORMAT_INVALID",
      `${source} declares ${format === undefined ? "no format" : `\`${String(format)}\` as its format`}, so penv cannot tell how to read it`,
      `Rebuild it with \`${ARTIFACT_BUILD_COMMAND}\` — every artifact says its format first.`,
    );
  }
  if (format !== ARTIFACT_FORMAT) {
    throw new UnsupportedArtifactFormatError(source, format);
  }

  const result = ARTIFACT.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue === undefined || issue.path.length === 0 ? "root" : issue.path.join(".");
    throw new ArtifactError(
      "ARTIFACT_SHAPE",
      `\`${field}\` in ${source} is not what format ${ARTIFACT_FORMAT} declares: ${issue?.message ?? "unknown"}`,
      `Rebuild it with \`${ARTIFACT_BUILD_COMMAND}\` — format ${ARTIFACT_FORMAT} is a closed shape, so a key penv does not know is either an edit or a file a newer penv wrote.`,
    );
  }

  const digest = deliveryDigest(result.data.values);
  if (digest !== result.data.schemaDigest) {
    throw new ArtifactError(
      "ARTIFACT_DIGEST_MISMATCH",
      `${source} declares delivery digest ${result.data.schemaDigest}, and its own delivery mappings hash to ${digest}`,
      `Rebuild it with \`${ARTIFACT_BUILD_COMMAND}\` — an artifact is written once and read unchanged.`,
    );
  }

  return result.data;
}

/** What a reader knows that the artifact cannot: which penv is running, and which environment was asked for. */
export interface ArtifactExpectation {
  readonly engineVersion: string;
  /** Absent when the caller named no environment — the artifact then says which it is. */
  readonly environment?: string;
}

/**
 * The two compatibility checks a reader makes, exactly.
 *
 * Both are exact matches, and neither negotiates. An artifact is one
 * environment's and one engine's: an approximate match here would be penv
 * deciding that a release built for staging is close enough to production.
 */
export function assertArtifactFor(
  artifact: Artifact,
  expected: ArtifactExpectation,
  source: string,
): void {
  if (artifact.engineVersion !== expected.engineVersion) {
    throw new ArtifactError(
      "ARTIFACT_ENGINE_MISMATCH",
      `${source} was built by penv ${artifact.engineVersion}, and this penv is ${expected.engineVersion}`,
      `Rebuild it with the penv that reads it: \`penv artifact build --env ${artifact.environment} --out ${source}\`.`,
    );
  }
  if (expected.environment !== undefined && expected.environment !== artifact.environment) {
    throw new ArtifactError(
      "ARTIFACT_ENVIRONMENT_MISMATCH",
      `${source} carries environment ${artifact.environment}, and this run asked for ${expected.environment}`,
      `Build ${expected.environment}'s own artifact with \`penv artifact build --env ${expected.environment} --out <path>\` — an artifact carries one environment.`,
    );
  }
}
