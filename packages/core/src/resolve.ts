/**
 * The value-resolution cascade:
 * `<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`.
 *
 * These are the four levels Next.js and Vite already use (`.env.[mode].local` >
 * `.env.local` > `.env.[mode]` > `.env`), one parameter at a time. Dropping a
 * level does not simplify the cascade, it widens scope: with no
 * `<name>.<env>.local`, a personal override for one environment has nowhere to
 * go but the unscoped default, which then serves every environment.
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
  Scope,
  ValueFile,
} from "./types.js";
import { assertNever } from "./types.js";

/** The environment whose runs must be reproducible, so personal overrides never apply. */
const TEST_ENVIRONMENT = "test";

/** The cascade for one environment, highest precedence first. The only order. */
function cascadeScopes(environment: string): Scope[] {
  return [
    { kind: "environment-local", environment },
    { kind: "local" },
    { kind: "environment", environment },
    { kind: "unscoped" },
  ];
}

/**
 * True for the scopes that are one developer's machine rather than the team's —
 * both `.local` scopes. Every scope this admits is skipped in `test`.
 */
function isPersonalOverride(scope: Scope): boolean {
  switch (scope.kind) {
    case "environment-local":
    case "local":
      return true;
    case "environment":
    case "unscoped":
      return false;
    default:
      return assertNever(scope, "scope");
  }
}

/** Plaintext before encrypted, so a scope's pair has a deterministic order. */
function scopedPair(ref: ParameterRef, scope: Scope): ValueFile[] {
  return [
    { namespace: ref.namespace, name: ref.name, scope, encrypted: false },
    { namespace: ref.namespace, name: ref.name, scope, encrypted: true },
  ];
}

/**
 * Every value file that could supply this parameter, highest precedence first.
 * Both `.local` scopes are omitted entirely in `test`.
 */
export function candidatesFor(ref: ParameterRef, environment: string): ValueFile[] {
  const skipPersonal = environment === TEST_ENVIRONMENT;
  return cascadeScopes(environment)
    .filter((scope) => !(skipPersonal && isPersonalOverride(scope)))
    .flatMap((scope) => scopedPair(ref, scope));
}

/**
 * The `.local` scopes `test` skips, reported as present:false rather than
 * omitted: fallback and skipping are never silent, so `--explain` must say a
 * personal override was passed over instead of leaving no trace of it.
 */
function skippedPersonalCandidates(ref: ParameterRef, environment: string): ResolutionCandidate[] {
  return cascadeScopes(environment)
    .filter(isPersonalOverride)
    .flatMap((scope) => scopedPair(ref, scope))
    .map((file) => ({
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
    environment === TEST_ENVIRONMENT ? skippedPersonalCandidates(ref, environment) : [];

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
    // Only the unscoped default is a fallback. A winner at either `.local`
    // scope is a deliberate override, not a value leaking out of its scope.
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
