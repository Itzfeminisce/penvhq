/**
 * The provider registry: the one place the CLI turns a `providers.*.type` into a
 * concrete provider.
 *
 * It lives in the CLI, not in `@penv/core` and not in `@penv/runtime`. Core owns
 * the `Provider` *contract* and must not know which implementations exist —
 * knowing would make the interface answerable to its callers. The runtime never
 * selects a provider at all: it reads the local `.penv` tree whatever an
 * environment declares (see `runtime/src/resolve.ts`), so a registry there would
 * be the ability to dial a network provider at boot, which the design forbids.
 *
 * So the registry is exactly the portability seam. A new provider is one entry
 * here; nothing else in the CLI names an implementation.
 */

import type { PenvConfig, Provider } from "@penv/core";
import { PenvError } from "@penv/core";
import { createFilesystemProvider } from "@penv/provider-filesystem";

/** What a factory needs to build a provider rooted at one project's `.penv`. */
export interface ProviderContext {
  /** The `.penv/` directory, absolute. */
  readonly root: string;
  /**
   * Required because a provider parses environment segments, and a segment is an
   * environment only if the config declares it — never inferred from the store.
   */
  readonly config: PenvConfig;
}

/** Turns a project's `.penv` context into a provider of one `type`. */
export type ProviderFactory = (context: ProviderContext) => Provider;

/**
 * The local `.penv` tree is always served by the filesystem provider: it is the
 * working copy `penv pull` materialises and every command edits, whatever backend
 * an environment's source of truth lives in. Naming it here keeps the one string
 * literal that means "the tree on disk" out of `openProject`.
 */
export const LOCAL_TREE_TYPE = "filesystem";

const REGISTRY = new Map<string, ProviderFactory>([
  [LOCAL_TREE_TYPE, ({ root, config }) => createFilesystemProvider({ root, config })],
]);

/** Whether a `providers.*.type` names a provider this build can construct. */
export function isProviderRegistered(type: string): boolean {
  return REGISTRY.has(type);
}

/**
 * Builds a provider of `type`, refusing an unregistered one loudly. The refusal
 * is here rather than at the command that first touches the provider so a config
 * naming a backend this build does not carry fails at open time, not mid-write.
 */
export function createProvider(type: string, context: ProviderContext): Provider {
  const factory = REGISTRY.get(type);
  if (factory === undefined) {
    throw unknownProvider(type);
  }
  return factory(context);
}

/**
 * Refuses at open time every environment whose `providers.*.type` names a
 * backend this build cannot construct — the whole config in one pass, so a user
 * with two unknown providers hears about both, and never as a crash from the
 * later command that would have been the first to reach one.
 */
export function assertProvidersRegistered(config: PenvConfig): void {
  for (const [environment, provider] of Object.entries(config.providers)) {
    if (!isProviderRegistered(provider.type)) {
      throw unknownProvider(provider.type, environment);
    }
  }
}

function unknownProvider(type: string, environment?: string): PenvError {
  const known = [...REGISTRY.keys()].map((name) => `\`${name}\``).join(", ");
  const where = environment === undefined ? "" : ` for environment ${environment}`;
  return new PenvError(
    "UNKNOWN_PROVIDER",
    `The provider type \`${type}\`${where} in penv.config.ts is not one this penv build carries`,
    `This build registers ${known}. Name a registered provider, or install the build that carries \`${type}\`.`,
  );
}
