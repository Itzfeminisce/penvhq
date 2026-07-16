/**
 * The value-resolution cascade: `<name>.local` > `<name>.<env>` > `<name>`.
 *
 * Flat override — a value file holds one opaque value, so a more specific scope
 * replaces a less specific one wholesale. Values are never merged.
 *
 * `.enc` is orthogonal to precedence: an encrypted candidate competes exactly
 * where its plaintext equivalent would. Within one scope the plaintext file is
 * considered before the encrypted one, so the pair has a deterministic order.
 */

import { PenvError } from "./errors.js";
import { formatValueFile, parameterId } from "./grammar.js";
import type {
  ParameterRef,
  Provider,
  Resolution,
  ResolutionCandidate,
  ValueFile,
} from "./types.js";

/** The environment whose runs must be reproducible, so personal overrides never apply. */
const TEST_ENVIRONMENT = "test";

function scopedPair(ref: ParameterRef, scope: ValueFile["scope"]): ValueFile[] {
  return [
    { namespace: ref.namespace, name: ref.name, scope, encrypted: false },
    { namespace: ref.namespace, name: ref.name, scope, encrypted: true },
  ];
}

function localCandidates(ref: ParameterRef): ValueFile[] {
  return scopedPair(ref, { kind: "local" });
}

/**
 * Every value file that could supply this parameter, highest precedence first.
 * The `.local` scope is omitted entirely in `test`.
 */
export function candidatesFor(ref: ParameterRef, environment: string): ValueFile[] {
  const files: ValueFile[] = [];
  if (environment !== TEST_ENVIRONMENT) {
    files.push(...localCandidates(ref));
  }
  files.push(...scopedPair(ref, { kind: "environment", environment }));
  files.push(...scopedPair(ref, { kind: "unscoped" }));
  return files;
}

function skippedLocalCandidates(ref: ParameterRef): ResolutionCandidate[] {
  return localCandidates(ref).map((file) => ({
    file,
    location: formatValueFile(file),
    present: false,
    skippedReason: "local-skipped-in-test",
  }));
}

export async function resolveParameter(
  ref: ParameterRef,
  environment: string,
  provider: Provider,
): Promise<Resolution> {
  const files = candidatesFor(ref, environment);
  const values = await Promise.all(files.map((file) => provider.read(file)));

  const candidates: ResolutionCandidate[] =
    environment === TEST_ENVIRONMENT ? skippedLocalCandidates(ref) : [];

  let winner: ResolutionCandidate | undefined;
  let value: string | undefined;

  for (const [index, file] of files.entries()) {
    const read = values[index];
    const present = read !== undefined;
    const location = formatValueFile(file);
    if (present && winner === undefined) {
      const candidate: ResolutionCandidate = { file, location, present: true };
      winner = candidate;
      value = read;
      candidates.push(candidate);
      continue;
    }
    candidates.push(
      present
        ? { file, location, present: true, skippedReason: "lower-precedence" }
        : { file, location, present: false },
    );
  }

  const parameter = parameterId(ref);

  if (winner?.file.encrypted) {
    throw new PenvError(
      "ENCRYPTED_VALUE_UNSUPPORTED",
      `Parameter ${parameter} for environment ${environment} resolves to the encrypted value file ${winner.location}, which penv cannot decrypt`,
      `Decrypting \`.enc\` value files is not part of this release. Provide a plaintext value file for ${parameter}, or read this value from a provider that holds it in plaintext.`,
    );
  }

  return {
    ref,
    parameter,
    value,
    winner,
    candidates,
    viaUnscopedFallback: winner !== undefined && winner.file.scope.kind === "unscoped",
  };
}

/**
 * Resolves every parameter the provider holds. Scopes are collapsed first:
 * `redis/password.production` and `redis/password` are one parameter.
 */
export async function resolveAll(environment: string, provider: Provider): Promise<Resolution[]> {
  const files = await provider.list();

  const refs = new Map<string, ParameterRef>();
  for (const file of files) {
    const ref: ParameterRef = { namespace: file.namespace, name: file.name };
    const id = parameterId(ref);
    if (!refs.has(id)) {
      refs.set(id, ref);
    }
  }

  const resolutions = await Promise.all(
    [...refs.values()].map((ref) => resolveParameter(ref, environment, provider)),
  );
  // Code-unit order, not locale order: generated output must be identical on every machine.
  return resolutions.sort((a, b) =>
    a.parameter < b.parameter ? -1 : a.parameter > b.parameter ? 1 : 0,
  );
}
