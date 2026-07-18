/**
 * Opening a penv project from a working directory, and the pieces every command
 * needs once it is open: the config, the environment to act on, the provider
 * rooted at `.penv/`, and the parameter a CLI key names.
 */

import { dirname, resolve } from "node:path";
import type {
  DecryptFailure,
  KeySource,
  ParameterRef,
  PenvConfig,
  Provider,
  ResolutionCandidate,
} from "@penvhq/core";
import {
  candidatesFor,
  formatValueFile,
  isReservedToken,
  loadConfig,
  openValue,
  PenvError,
  parameterId,
  ReservedTokenError,
  resolveEnvironment,
  resolveKeySource,
} from "@penvhq/core";
import { FilesystemProvider } from "@penvhq/provider-filesystem";
import { assertProvidersRegistered, createProvider, LOCAL_TREE_TYPE } from "./registry.js";

export const PENV_DIR = ".penv";

export interface Project {
  /** The directory holding `penv.config.ts`. */
  readonly root: string;
  readonly configFile: string;
  readonly config: PenvConfig;
  readonly penvDir: string;
  /**
   * The project's provider, as the contract — never the concrete
   * implementation. Shared commands speak the async interface and nothing more;
   * the sync twins a command genuinely needs are reached through `localTree`,
   * which is the one place the filesystem-only surface is named.
   */
  readonly provider: Provider;
}

export function openProject(cwd: string): Project {
  const { config, file } = loadConfig(cwd);
  const root = dirname(file);
  const penvDir = resolve(root, PENV_DIR);
  // Refuse a config naming a provider this build cannot construct here, at open
  // time, rather than as a crash from whichever command first reached it.
  assertProvidersRegistered(config);
  return {
    root,
    configFile: file,
    config,
    penvDir,
    provider: createProvider(LOCAL_TREE_TYPE, { root: penvDir, config }),
  };
}

/**
 * The project's provider as the concrete filesystem tree, for the sync reads and
 * writes a synchronous command cannot get from the async contract.
 *
 * `import`, `generate`, and `push` are synchronous — they are the adoption path
 * and the leaving guarantee — and they act on the local `.penv` tree, which is
 * always the filesystem provider (`penv pull` materialises it; the runtime reads
 * it). This narrows to that provider and names the reliance, so the type of
 * `Project.provider` stays the contract everywhere else. The refusal is a
 * belt-and-braces guard: `openProject` builds the tree as filesystem, so a
 * project in hand always narrows.
 */
export function localTree(project: Project): FilesystemProvider {
  if (!(project.provider instanceof FilesystemProvider)) {
    throw new PenvError(
      "PROVIDER_NOT_LOCAL",
      `This command reads the local .penv tree synchronously, which the \`${project.provider.type}\` provider is not`,
      "Run this against a filesystem-backed project, or use a command that speaks the async provider contract.",
    );
  }
  return project.provider;
}

/**
 * The environment's DECLARED source-of-truth provider — the backend that holds
 * the truth, as opposed to `Project.provider`, which is always the local
 * filesystem tree every command edits.
 *
 * `pull` and cross-provider `doctor` read here: they compare or copy against what
 * the config says the environment's values live in. An environment with no
 * `providers` entry has no separate source of truth, so this falls back to the
 * local tree — the two coincide, and there is nothing to pull from elsewhere.
 * `openProject` is untouched: the working copy stays filesystem regardless.
 */
export function sourceProviderFor(project: Project, environment: string): Provider {
  const providerConfig = project.config.providers[environment];
  if (providerConfig === undefined) {
    return createProvider(LOCAL_TREE_TYPE, { root: project.penvDir, config: project.config });
  }
  return createProvider(providerConfig.type, {
    root: project.penvDir,
    config: project.config,
    providerConfig,
    environment,
  });
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

/**
 * The key source for one environment, chosen by core.
 *
 * The CLI does not decide where keys live — it asks. Two choosers would be two
 * answers to one question, and the runtime is the other caller: a CLI that
 * sealed under a key the runtime could not find would make `penv set` and `load`
 * disagree about the same file.
 */
export function keySourceFor(project: Project, environment: string): KeySource {
  return resolveKeySource(project.config, environment);
}

/**
 * One parameter resolved against the filesystem, without reading it twice.
 *
 * The winner is a `ResolutionCandidate` rather than a bare `ValueFile` so this
 * satisfies core's `ResolvedValue`: the sync walk and the async one then hand the
 * same shape to the same `requireValue`, and there is one place that decides
 * what an unreadable value is.
 */
export interface SyncResolution {
  readonly ref: ParameterRef;
  readonly parameter: string;
  /** `undefined` when nothing is present, or when the winner did not open. */
  readonly value: string | undefined;
  readonly winner: ResolutionCandidate | undefined;
  /** Set only when the winner is `.enc` and did not decrypt. Mirrors `Resolution`. */
  readonly undecryptable?: DecryptFailure;
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
  keys: KeySource,
  skipPersonal?: boolean,
): SyncResolution {
  for (const file of candidatesFor(ref, environment, skipPersonal)) {
    const read = provider.readSync(file);
    if (read === undefined) {
      continue;
    }
    // Unconditional, including for a plaintext file, which comes back verbatim:
    // a branch on `file.encrypted` here would be a second place deciding what
    // encryption means, and this walker is already the second walker.
    const opened = openValue(file, read, keys);
    return {
      ref,
      parameter: parameterId(ref),
      value: opened.kind === "plaintext" ? opened.value : undefined,
      ...(opened.kind === "failed" ? { undecryptable: opened.failure } : {}),
      winner: { file, location: formatValueFile(file), present: true },
    };
  }
  return { ref, parameter: parameterId(ref), value: undefined, winner: undefined };
}

export function resolveAllSync(
  provider: FilesystemProvider,
  environment: string,
  keys: KeySource,
  skipPersonal?: boolean,
): SyncResolution[] {
  return refsFrom(provider.listSync()).map((ref) =>
    resolveSync(provider, ref, environment, keys, skipPersonal),
  );
}

/**
 * The parameters a provider holds, scopes collapsed and ordered identically
 * everywhere.
 */
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
