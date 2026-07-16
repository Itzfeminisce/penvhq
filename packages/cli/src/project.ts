/**
 * Opening a penv project from a working directory, and the pieces every command
 * needs once it is open: the config, the environment to act on, the provider
 * rooted at `.penv/`, and the parameter a CLI key names.
 */

import { dirname, resolve } from "node:path";
import type {
  ParameterRef,
  PenvConfig,
  Provider,
  Resolution,
  ResolutionCandidate,
  ValueFile,
} from "@penv/core";
import {
  candidatesFor,
  formatValueFile,
  isReservedToken,
  loadConfig,
  PenvError,
  parameterId,
  ReservedTokenError,
  resolveEnvironment,
  resolveParameter,
} from "@penv/core";
import type { FilesystemProvider } from "@penv/provider-filesystem";
import { createFilesystemProvider } from "@penv/provider-filesystem";

export const PENV_DIR = ".penv";

export interface Project {
  /** The directory holding `penv.config.ts`. */
  readonly root: string;
  readonly configFile: string;
  readonly config: PenvConfig;
  readonly penvDir: string;
  readonly provider: FilesystemProvider;
}

export function openProject(cwd: string): Project {
  const { config, file } = loadConfig(cwd);
  const root = dirname(file);
  const penvDir = resolve(root, PENV_DIR);
  return {
    root,
    configFile: file,
    config,
    penvDir,
    provider: createFilesystemProvider({ root: penvDir, config }),
  };
}

/** The environment to act on: `--env`, then `PENV_ENV`, then `NODE_ENV`. */
export function targetEnvironment(project: Project, explicit?: string): string {
  return resolveEnvironment(project.config, explicit);
}

/** A namespace separator on the command line, either spelling. */
const KEY_SEPARATOR = /[./\\]/;

/**
 * The reserved set for a caller that has no config to hand: the static tokens
 * and nothing else. Environments are a config whitelist (invariant 10), so a
 * caller without a config cannot know which environment names are reserved.
 */
const NO_ENVIRONMENTS: PenvConfig = { environments: [], providers: {} };

/**
 * The parameter a CLI key names — `redis/password` and `redis.password` are one.
 *
 * `config` is optional because the reserved set is config-driven: given one,
 * a declared environment name is refused here too; without one, only the static
 * tokens are. Pass the open project's config whenever there is one — this is the
 * early, better-worded half of a check the filename grammar makes again when the
 * file is read, never the only half.
 */
export function refFromKey(key: string, config?: PenvConfig): ParameterRef {
  const segments = key.split(KEY_SEPARATOR).filter((segment) => segment.length > 0);
  const name = segments[segments.length - 1];
  if (name === undefined) {
    throw new PenvError(
      "PARAMETER_KEY",
      `\`${key}\` names no parameter`,
      "A key is `<namespace>/<name>` or `<namespace>.<name>`, e.g. `redis/password`.",
    );
  }
  if (isReservedToken(name, config ?? NO_ENVIRONMENTS)) {
    throw new ReservedTokenError("parameter", name, key);
  }
  return { namespace: segments.slice(0, -1), name };
}

/** The environment whose runs must be reproducible, so personal overrides never apply. */
const TEST_ENVIRONMENT = "test";

/** A `PenvError` raised by `resolveParameter` because the winning file is `.enc`. */
function isEncryptedWinner(error: unknown): boolean {
  return error instanceof PenvError && error.code === "ENCRYPTED_VALUE_UNSUPPORTED";
}

/**
 * Any environment that is not `test`, used only to ask `candidatesFor` what the
 * `.local` scope expands to. Which files `.local` names does not vary by
 * environment — whether they are *considered* does, and that is the one thing
 * being recovered here.
 */
const ANY_NON_TEST_ENVIRONMENT = "not-test";

/**
 * The `.local` rows the cascade removed before it ever read anything.
 *
 * Only reached for an encrypted winner: on every other path core reports these
 * itself. The files are recovered from `candidatesFor` rather than restated, so
 * what `.local` expands to stays a single definition — invariant 4's "`.local`
 * is skipped in `test`" is the one fact stated here, and it is stated as the
 * reason the rows exist.
 */
function skippedLocalCandidates(ref: ParameterRef, environment: string): ResolutionCandidate[] {
  if (environment !== TEST_ENVIRONMENT) {
    return [];
  }
  return candidatesFor(ref, ANY_NON_TEST_ENVIRONMENT)
    .filter((file) => file.scope.kind === "local")
    .map((file) => ({
      file,
      location: formatValueFile(file),
      present: false,
      skippedReason: "local-skipped-in-test",
    }));
}

/** The encrypted-winner walk: identical to core's, minus the refusal at the end. */
async function describeEncryptedWinner(
  ref: ParameterRef,
  environment: string,
  provider: Provider,
): Promise<Resolution> {
  const files = candidatesFor(ref, environment);
  const reads = await Promise.all(files.map((file) => provider.read(file)));

  const candidates: ResolutionCandidate[] = skippedLocalCandidates(ref, environment);
  let winner: ResolutionCandidate | undefined;
  let value: string | undefined;

  for (const [index, file] of files.entries()) {
    const read = reads[index];
    const location = formatValueFile(file);
    if (read === undefined) {
      candidates.push({ file, location, present: false });
      continue;
    }
    if (winner === undefined) {
      const candidate: ResolutionCandidate = { file, location, present: true };
      winner = candidate;
      // An encrypted winner is present but unreadable: it wins, and it has no value here.
      value = file.encrypted ? undefined : read;
      candidates.push(candidate);
      continue;
    }
    candidates.push({ file, location, present: true, skippedReason: "lower-precedence" });
  }

  return {
    ref,
    parameter: parameterId(ref),
    value,
    winner,
    candidates,
    viaUnscopedFallback: winner !== undefined && winner.file.scope.kind === "unscoped",
  };
}

/**
 * Resolution that describes an `.enc` winner instead of refusing it.
 *
 * `resolveParameter` in `@penv/core` throws when the winning file is encrypted,
 * because a caller asking for a *value* cannot be handed one penv cannot
 * decrypt. `penv get --explain` and `doctor`'s plaintext-secret check ask a
 * different question — *which file wins* — and both must be able to see an
 * encrypted winner.
 *
 * That is the *only* difference, so core answers first and this refuses to
 * restate it. A second candidate list here is what silently dropped the `.local`
 * rows `test` skips: `--explain` is the command whose whole job is saying why a
 * file did not win, and it could not say the one thing core already knew. The
 * walk below runs only once core has refused, where the question genuinely
 * differs.
 */
export async function describeResolution(
  ref: ParameterRef,
  environment: string,
  provider: Provider,
): Promise<Resolution> {
  try {
    return await resolveParameter(ref, environment, provider);
  } catch (error) {
    if (!isEncryptedWinner(error)) {
      throw error;
    }
  }
  return describeEncryptedWinner(ref, environment, provider);
}

/** One parameter resolved against the filesystem, without reading it twice. */
export interface SyncResolution {
  readonly ref: ParameterRef;
  readonly parameter: string;
  /** `undefined` when nothing is present, or when the winner is encrypted. */
  readonly value: string | undefined;
  readonly winner: ValueFile | undefined;
}

/**
 * The synchronous half of the cascade.
 *
 * `import` and `generate` are synchronous — they are the adoption path, and the
 * v0.1 gate exercises them as plain calls — while the provider contract is
 * async because a network-backed provider cannot be anything else. This walks
 * the filesystem provider's *additional* sync reads, exactly as the runtime
 * loader does for the same reason. It does not restate the precedence rule:
 * `candidatesFor` owns the order, and this only walks the list it returns.
 */
export function resolveSync(
  provider: FilesystemProvider,
  ref: ParameterRef,
  environment: string,
): SyncResolution {
  for (const file of candidatesFor(ref, environment)) {
    const read = provider.readSync(file);
    if (read === undefined) {
      continue;
    }
    return {
      ref,
      parameter: parameterId(ref),
      value: file.encrypted ? undefined : read,
      winner: file,
    };
  }
  return { ref, parameter: parameterId(ref), value: undefined, winner: undefined };
}

export function resolveAllSync(
  provider: FilesystemProvider,
  environment: string,
): SyncResolution[] {
  return refsFrom(provider.listSync()).map((ref) => resolveSync(provider, ref, environment));
}

/** The parameters a provider holds, scopes collapsed and ordered identically everywhere. */
export function refsFrom(files: readonly ParameterRef[]): ParameterRef[] {
  const refs = new Map<string, ParameterRef>();
  for (const file of files) {
    const ref: ParameterRef = { namespace: file.namespace, name: file.name };
    const id = parameterId(ref);
    if (!refs.has(id)) {
      refs.set(id, ref);
    }
  }
  // Code-unit order, not locale order: a report must be identical on every machine.
  return [...refs.values()].sort((a, b) => {
    const left = parameterId(a);
    const right = parameterId(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** `describeResolution` for every parameter the provider holds. */
export async function describeAll(environment: string, provider: Provider): Promise<Resolution[]> {
  const refs = refsFrom(await provider.list());
  return Promise.all(refs.map((ref) => describeResolution(ref, environment, provider)));
}
