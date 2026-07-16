/**
 * The synchronous half of the value cascade, shared by `load` and the
 * `penv/config` compatibility entry.
 *
 * `resolveParameter` in `@penv/core` is async because the provider contract is,
 * and `load` is synchronous — so this module walks the cascade against the
 * filesystem provider's synchronous reads instead. It does not restate the
 * precedence rule: `candidatesFor` owns the order and everything here only
 * walks the list it returns, so the two paths cannot drift apart.
 */

import { dirname, resolve as resolvePath } from "node:path";
import type { ParameterRef, PenvConfig, ValueFile } from "@penv/core";
import {
  candidatesFor,
  formatValueFile,
  loadConfig,
  PenvError,
  parameterId,
  resolveEnvironment,
} from "@penv/core";
import { createFilesystemProvider } from "@penv/provider-filesystem";

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

function encryptedWinner(ref: ParameterRef, environment: string, file: ValueFile): PenvError {
  const parameter = parameterId(ref);
  return new PenvError(
    "ENCRYPTED_VALUE_UNSUPPORTED",
    `Parameter ${parameter} for environment ${environment} resolves to the encrypted value file ` +
      `${formatValueFile(file)}, which penv cannot decrypt`,
    `Decrypting \`.enc\` value files is not part of this release. Provide a plaintext value file ` +
      `for ${parameter}, or read this value from a provider that holds it in plaintext.`,
  );
}

function unsupportedProvider(environment: string, type: string): PenvError {
  return new PenvError(
    "PROVIDER_UNSUPPORTED",
    `Environment ${environment} declares the \`${type}\` provider, which penv cannot read here`,
    `This release implements the filesystem provider only, and \`load\` is synchronous, so a ` +
      `network-backed provider cannot serve the \`@env\` runtime path. Reading the local ` +
      `.penv/ tree instead would silently serve ${environment} from your working copy. Set ` +
      `\`providers.${environment}.type\` to \`"filesystem"\`, or supply the values for ` +
      `${environment} another way.`,
  );
}

/**
 * Loads the config, settles the environment, and resolves every parameter the
 * provider holds — the work `load` and `penv/config` both start from.
 */
export function resolveSync(cwd: string, environment?: string): ResolvedConfig {
  const { config, file } = loadConfig(cwd);
  const target = resolveEnvironment(config, environment);

  // A declared provider penv cannot honour must be loud. Falling through to the
  // filesystem would answer a Vault-backed environment out of the working tree
  // with no error, warning, or doctor finding — invariant 13.
  const declared = config.providers[target];
  if (declared !== undefined && declared.type !== "filesystem") {
    throw unsupportedProvider(target, declared.type);
  }

  const provider = createFilesystemProvider({
    root: resolvePath(dirname(file), ".penv"),
    config,
  });

  const values: ResolvedValue[] = [];
  for (const ref of refsFrom(provider.listSync())) {
    for (const candidate of candidatesFor(ref, target)) {
      const read = provider.readSync(candidate);
      if (read === undefined) {
        continue;
      }
      if (candidate.encrypted) {
        throw encryptedWinner(ref, target, candidate);
      }
      values.push({ ref, value: read });
      break;
    }
  }

  return { config, environment: target, values };
}
