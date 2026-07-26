/**
 * The synchronous half of the value cascade, shared by `load` and the
 * `penv/config` compatibility entry.
 *
 * `resolveParameter` in `@penvhq/core` is async because the provider contract is,
 * and `load` is synchronous — so this module walks the cascade against the
 * filesystem provider's synchronous reads instead. It does not restate the
 * precedence rule: `candidatesFor` owns the order and everything here only
 * walks the list it returns, so the two paths cannot drift apart.
 *
 * The runtime reads the local tree for every environment, whatever provider
 * that environment declares, and this is the design rather than a limitation.
 * A provider is where an environment's source of truth *lives*, not where the
 * runtime reads from: `penv pull` materialises the tree from the provider, and
 * the runtime then reads what is on disk. So `load` never inspects
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
 * as a provider is a sync target and not a runtime source. So invariant 3 is not
 * traded against encryption: `load` stays generic and synchronous because the
 * network half of both problems was moved out of the process entirely, rather
 * than awaited inside it.
 */

import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { KeySource, ParameterRef, PenvConfig, PenvSnapshot, ValueFile } from "@penvhq/core";
import {
  ConfigError,
  candidatesFor,
  formatValueFile,
  loadConfigFrom,
  openValue,
  parameterId,
  resolveEnvironment,
  resolveKeySource,
  searchConfigFile,
  sealedSnapshotValues,
  snapshotDigest,
  UndecryptableValueError,
} from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { debugEnabled, warn } from "./diagnostics.js";
import { createSnapshotProvider, type SnapshotProvider } from "./snapshot.js";

/**
 * Which read source a load may use.
 *
 * `auto` is the default and the only one that considers both: the config file
 * first, the embedded snapshot when there is no config file or the config file
 * cannot serve. `disk` and `snapshot` pin the answer, so a deployment that has
 * decided which source it is running on gets a named failure instead of a
 * silent switch to the other one.
 */
export type LoadSource = "auto" | "disk" | "snapshot";

/** Which read source actually answered. */
export type ResolutionSource = "disk" | "snapshot";

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
  readonly source: ResolutionSource;
  /**
   * Where the values came from, in words a failure can name: the config file's
   * path, or the embedded snapshot. Folded into `ValidationError` because
   * "which source did penv read" is the first question a bundled runtime's
   * failure raises.
   */
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

/** The one synchronous read surface the cascade walks — filesystem or snapshot. */
interface SyncReadProvider {
  listSync(): ValueFile[];
  readSync(file: ValueFile): string | undefined;
}

/**
 * Resolves every parameter a read source holds for one environment. The one place
 * the sync cascade walks, so the filesystem path and the snapshot path resolve,
 * decrypt, and fail identically — only the read source differs.
 */
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
  readonly snapshot?: PenvSnapshot;
  readonly source?: LoadSource;
}

const SNAPSHOT_ORIGIN = "the embedded snapshot";

/** The tree directory, named in the one warning that reports it missing. */
const PENV_DIR = ".penv";

const NO_CONFIG_REMEDY =
  "Run `penv init` at your project root to create one, or run this command from inside a penv " +
  "project. In a bundled or serverless runtime where no config file is on disk — a Vercel " +
  "`/var/task` bundle, say — generate and wire an embedded snapshot with `penv snapshot`, so " +
  "`load()` resolves from it instead.";

/** Resolves against the embedded snapshot. */
function fromSnapshot(snapshot: PenvSnapshot, environment?: string): ResolvedConfig {
  const config = snapshot.config;
  const target = resolveEnvironment(config, environment);
  const keys = resolveKeySource(config, target);
  const provider: SnapshotProvider = createSnapshotProvider(snapshot);
  return {
    config,
    environment: target,
    values: resolveFrom(provider, target, keys),
    source: "snapshot",
    origin: SNAPSHOT_ORIGIN,
  };
}

/**
 * The committed snapshot no longer projects the tree `load` just read, so a
 * build made from it would serve different values than this process does.
 *
 * Checked here rather than left to `penv doctor` because this is the one moment
 * both sources are in hand. A snapshot generated before digests exist carries
 * none; that is unverifiable rather than stale, and reported as neither.
 */
function warnOnDrift(snapshot: PenvSnapshot, config: PenvConfig, provider: SyncReadProvider): void {
  if (snapshot.digest === undefined) {
    return;
  }
  const current = snapshotDigest(config, sealedSnapshotValues(provider));
  if (current === snapshot.digest) {
    return;
  }
  warn(
    "penv.snapshot.ts no longer matches this project's config and sealed values, so a build made " +
      "from it will serve different values than this process just read. Run `penv snapshot`.",
  );
}

/**
 * Loads the config, settles the environment, and resolves every parameter the
 * local tree holds — the work `load` and `penv/config` both start from.
 *
 * File discovery comes first, always, and that is not negotiable: with a
 * `penv.config.ts` on disk the filesystem tree is the source of truth and a live
 * edit wins, which is what makes local development work. Precedence is never
 * flipped in favour of the snapshot.
 *
 * What *is* new is that a config file with **no `.penv/` tree beside it** falls
 * back to the snapshot instead of throwing. That is one condition, and it is the
 * whole fix: a bundler traces `penv.config.ts` into `/var/task` because a config
 * key referenced it, but nothing imports the tree, so the tree is left behind.
 * A config with no tree is a bundling artifact, not a project.
 *
 * The condition is checked *before* the config is evaluated, which is what keeps
 * the fallback from swallowing a broken config a developer needs to see. With a
 * tree present, `penv.config.ts` must load or the load fails — a syntax error, a
 * missing default export, an import that does not resolve, all still throw, on
 * the reasoning that a real project's config is the developer's own file and a
 * warning they can scroll past is not an answer. Everything downstream is the
 * user's data and is never fallen back from either: an undecryptable value, an
 * undeclared environment, and a tree that is present but incomplete all still
 * throw. The fallback is never silent (invariant 13) — it warns, naming the
 * directory that is missing.
 */
export function resolveSync(options: ResolveOptions): ResolvedConfig {
  const { cwd, environment, snapshot } = options;
  const source = options.source ?? "auto";

  if (source === "snapshot") {
    if (snapshot === undefined) {
      throw new ConfigError(
        'load was called with `source: "snapshot"` but no snapshot was passed',
        "Generate one with `penv snapshot` and pass it: `load(schema, { snapshot, source: " +
          '"snapshot" })`. `source: "snapshot"` never falls back to the filesystem — that is what ' +
          "asking for it means.",
      );
    }
    return fromSnapshot(snapshot, environment);
  }

  const usable = snapshot !== undefined && source === "auto";
  const { file, beyondBoundary } = searchConfigFile(cwd);

  if (file !== undefined) {
    const root = resolvePath(dirname(file), PENV_DIR);
    const tree = existsSync(root);
    if (usable && !tree) {
      warn(`${file} has no ${PENV_DIR} tree beside it; resolving from ${SNAPSHOT_ORIGIN}`);
      return fromSnapshot(snapshot, environment);
    }

    const config = loadConfigFrom(file);
    const target = resolveEnvironment(config, environment);
    const provider = createFilesystemProvider({ root, config });
    const keys = resolveKeySource(config, target);
    const values = resolveFrom(provider, target, keys);
    // Drift is a comparison against the tree, so an absent tree has nothing to
    // say — reporting a stale snapshot there would name the wrong problem.
    if (snapshot !== undefined && tree) {
      warnOnDrift(snapshot, config, provider);
    }
    return { config, environment: target, values, source: "disk", origin: file };
  }

  if (usable) {
    // The bundle's designed path, so no warning — except when the boundary is
    // what turned a reachable config into an unreachable one, which is a
    // surprise and says so.
    if (beyondBoundary !== undefined) {
      warn(
        `${beyondBoundary} is outside this project's workspace, so penv did not read it; ` +
          `resolving from ${SNAPSHOT_ORIGIN}`,
      );
    }
    return fromSnapshot(snapshot, environment);
  }

  if (source === "disk") {
    throw new ConfigError(
      `No penv.config.ts found in ${resolvePath(cwd)} or any parent directory, and \`source: "disk"\` forbids the snapshot`,
      'Run `penv init` at your project root to create one. Drop `source: "disk"` to let an ' +
        "embedded snapshot answer in a bundled or serverless runtime.",
    );
  }

  throw new ConfigError(
    `No penv.config.ts found in ${resolvePath(cwd)} or any parent directory`,
    NO_CONFIG_REMEDY,
  );
}

/** The `PENV_DEBUG=1` account of one resolution. Never printed otherwise. */
export function describeResolution(resolved: ResolvedConfig): string[] {
  if (!debugEnabled()) {
    return [];
  }
  return [
    `environment ${resolved.environment}, resolved from ${resolved.source} (${resolved.origin})`,
    `${resolved.values.length} parameter${resolved.values.length === 1 ? "" : "s"} resolved`,
    ...resolved.values.map(({ ref, location }) => `  ${parameterId(ref)} <- ${location}`),
  ];
}
