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

import { openValue, UndecryptableValueError } from "./crypto.js";
import { formatValueFile, parameterId } from "./grammar.js";
import type { KeySource } from "./keys.js";
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
 * Whether both `.local` scopes should be dropped for this environment.
 *
 * The default is `test`, which skips personal overrides so its runs reproduce.
 * A push overrides it to `true` for a *real* environment: CI receives what CI
 * would read, and a developer's personal override is not CI's business — the
 * same scope-widening refusal `import` already makes. The skip is a decision the
 * caller states, not a fact derived from the environment name, so a real
 * environment can ask for it without pretending to be `test`.
 */
function defaultSkipPersonal(environment: string): boolean {
  return environment === TEST_ENVIRONMENT;
}

/** Why a `.local` scope was skipped, for the `--explain` breadcrumb. */
function skipReason(environment: string): "local-skipped-in-test" | "local-skipped-in-push" {
  return environment === TEST_ENVIRONMENT ? "local-skipped-in-test" : "local-skipped-in-push";
}

/**
 * Every value file that could supply this parameter, highest precedence first.
 * Both `.local` scopes are omitted entirely when `skipPersonal` — in `test` by
 * default, or when a push asks for it on a real environment.
 */
export function candidatesFor(
  ref: ParameterRef,
  environment: string,
  skipPersonal: boolean = defaultSkipPersonal(environment),
): ValueFile[] {
  return cascadeScopes(environment)
    .filter((scope) => !(skipPersonal && isPersonalOverride(scope)))
    .flatMap((scope) => scopedPair(ref, scope));
}

/**
 * The `.local` scopes a skip drops, reported as present:false rather than
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
      skippedReason: skipReason(environment),
    }));
}

/**
 * Resolves one parameter, opening the winner if it is sealed.
 *
 * `keys` is required rather than optional, and that is load-bearing. An optional
 * key source would let a caller who merely forgot to pass one be told "no key" —
 * turning a bug in penv into a report about the user's tree. Every caller states
 * where keys come from, even if the answer is `nullKeySource`, which says so.
 *
 * Only the winner is opened. A losing `.enc` candidate at a lower scope is read
 * but never decrypted, so a value sealed under a key that is long gone cannot
 * fail a resolution it did not win — precedence is decided by the cascade, and
 * encryption sits below it (invariants 4 and 6).
 */
export async function resolveParameter(
  ref: ParameterRef,
  environment: string,
  provider: Provider,
  keys: KeySource,
  skipPersonal: boolean = defaultSkipPersonal(environment),
): Promise<Resolution> {
  const files = candidatesFor(ref, environment, skipPersonal);
  const values = await Promise.all(files.map((file) => provider.read(file)));

  const candidates: ResolutionCandidate[] = skipPersonal
    ? skippedPersonalCandidates(ref, environment)
    : [];

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

  // `openValue` is called unconditionally, including for a plaintext winner,
  // which it returns verbatim. A branch on `file.encrypted` here would be a
  // second place that decides what encryption means.
  const opened =
    winner === undefined || value === undefined ? undefined : openValue(winner.file, value, keys);

  return {
    ref,
    parameter,
    value: opened?.kind === "plaintext" ? opened.value : undefined,
    ...(opened?.kind === "failed" ? { undecryptable: opened.failure } : {}),
    winner,
    candidates,
    // Only the unscoped default is a fallback. A winner at either `.local`
    // scope is a deliberate override, not a value leaking out of its scope.
    viaUnscopedFallback: winner !== undefined && winner.file.scope.kind === "unscoped",
  };
}

/**
 * The part of a resolution a failure has to be able to name. penv walks the
 * cascade twice — here, and synchronously in the CLI where `generate` and
 * `import` cannot await — and this is the part both walks agree on, so one
 * helper serves both rather than each growing its own.
 */
export type ResolvedValue = Pick<Resolution, "parameter" | "value" | "undecryptable" | "winner">;

/**
 * The value, or the named error for why there isn't one.
 *
 * The one place `UndecryptableValueError` is constructed, and the helper every
 * caller that wants a *value* — rather than a report about one — must use. It
 * exists because the two absences on a `Resolution` are not the same absence:
 * a caller that treated `value === undefined` as "missing" would report a secret
 * it cannot decrypt as one that was never set, and send the user to overwrite it.
 */
export function requireValue(resolution: ResolvedValue, environment: string): string | undefined {
  if (resolution.undecryptable !== undefined) {
    throw new UndecryptableValueError(
      resolution.parameter,
      environment,
      resolution.winner?.location ?? "an encrypted value file",
      resolution.undecryptable,
    );
  }
  return resolution.value;
}

/**
 * Resolves every parameter the provider holds. Scopes are collapsed first:
 * `redis/password.production` and `redis/password` are one parameter.
 */
export async function resolveAll(
  environment: string,
  provider: Provider,
  keys: KeySource,
  skipPersonal: boolean = defaultSkipPersonal(environment),
): Promise<Resolution[]> {
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
    [...refs.values()].map((ref) =>
      resolveParameter(ref, environment, provider, keys, skipPersonal),
    ),
  );
  // Code-unit order, not locale order: generated output must be identical on every machine.
  return resolutions.sort((a, b) =>
    a.parameter < b.parameter ? -1 : a.parameter > b.parameter ? 1 : 0,
  );
}
