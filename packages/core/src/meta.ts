/**
 * The meta merge: base object plus per-environment blocks.
 *
 * An environment block overrides the base per top-level key and inherits every
 * key it does not declare. Nested objects are replaced wholesale, never
 * deep-merged, so the effective meta for any environment is computable by
 * reading exactly two objects: the base and that environment. `.local` does not
 * participate — policy is a property of the shared parameter.
 */

import { PenvError, UnknownEnvironmentError } from "./errors.js";
import type { Meta, MetaBlock, PenvConfig } from "./types.js";

/** The container key. It is not a policy field and never reaches effective meta. */
const ENVIRONMENTS_KEY = "environments";

/** Emitted ahead of the alphabetical keys: the two a reader looks for first. */
const PRIORITY_KEYS: readonly string[] = ["description", "owner"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyPolicyKeys(source: MetaBlock, target: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === ENVIRONMENTS_KEY) continue;
    target[key] = value;
  }
}

/**
 * The policy in force for one parameter in one environment.
 *
 * An undeclared environment inherits the base unchanged — absence means
 * "optional by default", not an error.
 */
export function effectiveMeta(meta: Meta | undefined, environment: string): MetaBlock {
  const merged: Record<string, unknown> = {};
  if (!meta) return merged;

  copyPolicyKeys(meta, merged);

  const block = meta.environments?.[environment];
  if (block) copyPolicyKeys(block, merged);

  return merged;
}

export function isRequired(meta: Meta | undefined, environment: string): boolean {
  return effectiveMeta(meta, environment).required === true;
}

export function isSecret(meta: Meta | undefined, environment: string): boolean {
  return effectiveMeta(meta, environment).secret === true;
}

export function parseMeta(source: string, filename: string): Meta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PenvError(
      "META_PARSE",
      `Meta file ${filename} is not valid JSON: ${detail}`,
      `Fix the JSON syntax in ${filename}. Meta is always plaintext JSON, never encrypted.`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new PenvError(
      "META_PARSE",
      `Meta file ${filename} must hold a JSON object at its root, not ${describe(parsed)}`,
      `Wrap the contents in \`{ ... }\`: a meta file is a base policy block plus an optional \`${ENVIRONMENTS_KEY}\` block.`,
    );
  }

  const environments = parsed[ENVIRONMENTS_KEY];
  if (environments !== undefined) {
    if (!isPlainObject(environments)) {
      throw new PenvError(
        "META_PARSE",
        `The \`${ENVIRONMENTS_KEY}\` key in meta file ${filename} must be an object keyed by environment name, not ${describe(environments)}`,
        `Write \`"${ENVIRONMENTS_KEY}": { "production": { "required": true } }\` — one policy block per environment.`,
      );
    }
    for (const [name, block] of Object.entries(environments)) {
      if (!isPlainObject(block)) {
        throw new PenvError(
          "META_PARSE",
          `The \`${name}\` block in meta file ${filename} must be an object of policy fields, not ${describe(block)}`,
          `Write \`"${name}": { "required": true }\`, or drop the key — an environment with no block inherits the base.`,
        );
      }
    }
  }

  return parsed as Meta;
}

/**
 * Checks every environment key in a meta file against the config whitelist.
 *
 * Environments are a whitelist, never inferred (invariant 10), and a meta file is
 * the one place an environment name was read without being checked — so a typo'd
 * key (`prodution`) was silently inert policy: `effectiveMeta` found no matching
 * block, returned the base, and a parameter its author marked required for
 * production deployed absent. Reserving a name the author clearly meant as policy
 * must be loud (invariant 13).
 *
 * Collects rather than throws: severity is the caller's decision, and an author
 * with three typos deserves all three at once, not one per run. `parseMeta` stays
 * config-free above — this is the policy check, that is a pure parse.
 *
 * `_filename` is accepted but unused: `UnknownEnvironmentError` has no seam for a
 * location, so the message cannot yet say *which* meta file holds the bad key —
 * the one thing an author with forty meta files needs. `ReservedTokenError` solves
 * this with a `where: string`; giving `UnknownEnvironmentError` the same optional
 * param is the fix, and this parameter is here so that lands without touching
 * every caller. Surfaced rather than done here: errors.ts is another agent's file.
 */
export function validateMetaEnvironments(
  meta: Meta | undefined,
  _filename: string,
  config: PenvConfig,
): PenvError[] {
  const environments = meta?.environments;
  if (!environments) return [];

  const errors: PenvError[] = [];
  for (const name of Object.keys(environments)) {
    if (!config.environments.includes(name)) {
      errors.push(new UnknownEnvironmentError(name, config.environments));
    }
  }

  return errors;
}

/** Deterministic order: `description`, `owner`, remaining keys sorted, `environments` last. */
function orderBlock(block: MetaBlock): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  const keys = Object.keys(block);

  for (const key of PRIORITY_KEYS) {
    if (keys.includes(key)) ordered[key] = block[key];
  }
  for (const key of keys
    .filter((k) => !PRIORITY_KEYS.includes(k) && k !== ENVIRONMENTS_KEY)
    .sort()) {
    ordered[key] = block[key];
  }

  return ordered;
}

export function serializeMeta(meta: Meta): string {
  const ordered = orderBlock(meta);

  const environments = meta.environments;
  if (environments) {
    const orderedEnvironments: Record<string, unknown> = {};
    for (const name of Object.keys(environments).sort()) {
      const block = environments[name];
      if (block) orderedEnvironments[name] = orderBlock(block);
    }
    ordered[ENVIRONMENTS_KEY] = orderedEnvironments;
  }

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
