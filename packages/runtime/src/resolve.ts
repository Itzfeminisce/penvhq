/**
 * The synchronous half of the value cascade, for the `penv/config`
 * compatibility entry.
 *
 * It is the *schemaless* ambient path's reader and nothing else. The typed
 * bridge validates the environment `penv run` injected and never opens a tree
 * (see `load.ts`); this entry has no schema to be handed values under, so it
 * resolves the tree itself, exactly as `dotenv/config` would.
 *
 * `resolveParameter` in `@penvhq/core` is async because the provider contract is,
 * and the compat entry is synchronous — so this module walks the cascade against
 * the filesystem provider's synchronous reads instead. It does not restate the
 * precedence rule: `candidatesFor` owns the order and everything here only
 * walks the list it returns, so the two paths cannot drift apart.
 *
 * It reads the local tree for every environment, whatever provider that
 * environment declares, and this is the design rather than a limitation. A
 * provider is where an environment's source of truth *lives*, not where the
 * runtime reads from: `penv pull` materialises the tree from the provider, and
 * the runtime then reads what is on disk. So nothing here inspects
 * `providers.*.type` — a Vault-backed environment resolves through exactly the
 * code path a filesystem-backed one does, which is what makes changing provider
 * a configuration change rather than an application rewrite.
 *
 * Decryption happens here, synchronously, and that is the same knife applied a
 * second time. Key *acquisition* is async and happens before the process starts:
 * a deploy unwraps the KMS-derived data key and exports it, exactly as it already
 * runs `penv pull` to materialise the tree. Key *use* is a synchronous pure
 * function over bytes. penv never calls a KMS in-process — a key is where an
 * environment's secret material *lives*, not what the runtime dials at boot, just
 * as a provider is a sync target and not a runtime source.
 */

import { dirname, resolve as resolvePath } from "node:path";
import type { KeySource, ParameterRef, PenvConfig, ValueFile } from "@penvhq/core";
import {
  assertMigrated,
  ConfigError,
  candidatesFor,
  findConfigFile,
  formatValueFile,
  loadConfigFrom,
  openValue,
  own,
  parameterId,
  recordsDir,
  resolveEnvironment,
  resolveKeySource,
  UndecryptableValueError,
} from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";

/**
 * The package that always *is* the local tree. Named here rather than in core,
 * which owns the provider contract and must not know which implementations
 * exist; this module already builds the filesystem provider, so it is the layer
 * that may recognise it.
 */
const LOCAL_TREE_TYPE = "@penvhq/provider-filesystem";

/**
 * Whether this environment's values live somewhere penv would have to pull them
 * from.
 *
 * It is what separates "you have not pulled yet" from "nothing has been set
 * yet": an environment backed by the local tree has no elsewhere, so telling its
 * owner to run `penv pull` would send them to a command with nothing to do.
 */
export function hasRemoteSource(config: PenvConfig, environment: string): boolean {
  const declared = own(config.providers, environment);
  return declared !== undefined && declared.type !== LOCAL_TREE_TYPE;
}

/** One parameter that resolved to a present value for the target environment. */
export interface ResolvedValue {
  readonly ref: ParameterRef;
  readonly value: string;
  /** The winning value file's grammar address, for the `PENV_DEBUG` account. */
  readonly location: string;
}

export interface ResolvedConfig {
  readonly config: PenvConfig;
  readonly environment: string;
  /**
   * Only parameters with a present candidate. A parameter that resolved to
   * nothing is absent rather than `undefined`, so requiredness stays the
   * schema's call.
   */
  readonly values: readonly ResolvedValue[];
  /** The config file that answered, for the `PENV_DEBUG` account. */
  readonly origin: string;
}

/**
 * The parameters behind a set of value files, scopes collapsed —
 * `redis/password.production` and `redis/password` are one parameter. Ordered
 * so a `process.env` population is identical on every machine.
 */
function refsFrom(files: readonly ValueFile[]): ParameterRef[] {
  const refs = new Map<string, ParameterRef>();
  for (const file of files) {
    const ref: ParameterRef = { namespace: file.namespace, name: file.name };
    const id = parameterId(ref);
    if (!refs.has(id)) {
      refs.set(id, ref);
    }
  }
  return [...refs.values()].sort((a, b) => {
    const left = parameterId(a);
    const right = parameterId(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** The synchronous read surface the cascade walks. */
interface SyncReadProvider {
  listSync(): ValueFile[];
  readSync(file: ValueFile): string | undefined;
}

/** Resolves every parameter the tree holds for one environment. */
function resolveFrom(provider: SyncReadProvider, target: string, keys: KeySource): ResolvedValue[] {
  const values: ResolvedValue[] = [];
  for (const ref of refsFrom(provider.listSync())) {
    for (const candidate of candidatesFor(ref, target)) {
      const read = provider.readSync(candidate);
      if (read === undefined) {
        continue;
      }
      // The winner is the winner whether or not it opens. Continuing the walk on
      // a failed decrypt would serve a lower scope's plaintext twin instead —
      // the scope widening the cascade exists to prevent, arrived at by treating
      // "I cannot read this" as "this is not here".
      const location = formatValueFile(candidate);
      const opened = openValue(candidate, read, keys);
      if (opened.kind === "failed") {
        throw new UndecryptableValueError(parameterId(ref), target, location, opened.failure);
      }
      values.push({ ref, value: opened.value, location });
      break;
    }
  }
  return values;
}

export interface ResolveOptions {
  readonly cwd: string;
  readonly environment?: string;
}

/**
 * Loads the config, settles the environment, and resolves every parameter the
 * local tree holds — the work `load` and `penv/config` both start from.
 *
 * File discovery comes first and is the only source: with a `penv.config.ts` on
 * disk the filesystem tree is the source of truth and a live edit wins, which is
 * what makes local development work. A missing config is a named failure, never
 * a quieter answer from somewhere else.
 */
export function resolveSync(options: ResolveOptions): ResolvedConfig {
  const { cwd, environment } = options;
  const file = findConfigFile(cwd);

  if (file === undefined) {
    throw new ConfigError(
      `No penv.config.ts found in ${resolvePath(cwd)} or any parent directory`,
      "Run `penv init` at your project root to create one, or run this command from inside a " +
        "penv project.",
    );
  }

  const config = loadConfigFrom(file);
  const root = dirname(file);
  // The refusal the CLI makes at open time, made here too: an unmigrated project
  // must hear that its records moved, not boot with an empty environment.
  assertMigrated(root, config);
  const target = resolveEnvironment(config, environment);
  const provider = createFilesystemProvider({ root: recordsDir(root), config });
  const keys = resolveKeySource(config, target);
  return { config, environment: target, values: resolveFrom(provider, target, keys), origin: file };
}
