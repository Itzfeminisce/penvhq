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

import { dirname, resolve as resolvePath } from "node:path";
import type { ParameterRef, PenvConfig, ValueFile } from "@penvhq/core";
import {
  candidatesFor,
  formatValueFile,
  loadConfig,
  openValue,
  parameterId,
  resolveEnvironment,
  resolveKeySource,
  UndecryptableValueError,
} from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";

/** One parameter that resolved to a present value for the target environment. */
export interface ResolvedValue {
  readonly ref: ParameterRef;
  readonly value: string;
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

/**
 * Loads the config, settles the environment, and resolves every parameter the
 * local tree holds — the work `load` and `penv/config` both start from.
 */
export function resolveSync(cwd: string, environment?: string): ResolvedConfig {
  const { config, file } = loadConfig(cwd);
  const target = resolveEnvironment(config, environment);

  const provider = createFilesystemProvider({
    root: resolvePath(dirname(file), ".penv"),
    config,
  });

  const keys = resolveKeySource(config, target);

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
      const opened = openValue(candidate, read, keys);
      if (opened.kind === "failed") {
        throw new UndecryptableValueError(
          parameterId(ref),
          target,
          formatValueFile(candidate),
          opened.failure,
        );
      }
      values.push({ ref, value: opened.value });
      break;
    }
  }

  return { config, environment: target, values };
}
