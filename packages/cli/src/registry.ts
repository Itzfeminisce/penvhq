/**
 * The provider registry: the one place the CLI turns a `providers.*.type` into a
 * concrete provider.
 *
 * It lives in the CLI, not in `@penvhq/core` and not in `@penvhq/runtime`. Core owns
 * the `Provider` *contract* and must not know which implementations exist —
 * knowing would make the interface answerable to its callers. The runtime never
 * selects a provider at all: it reads the local `.penv` tree whatever an
 * environment declares (see `runtime/src/resolve.ts`), so a registry there would
 * be the ability to dial a network provider at boot, which the design forbids.
 *
 * So the registry is exactly the portability seam. A built-in provider is one
 * entry in {@link REGISTRY}. A provider that cannot live in this repo — a private
 * or third-party backend — is resolved by convention instead: a `type` with no
 * built-in entry is loaded from the package `@penvhq/provider-<type>` (or the
 * `module` the config names), exactly as ESLint resolves `eslint-plugin-<name>`.
 * Either way, nothing else in the CLI names an implementation.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PenvConfig, Provider, ProviderConfig } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { createKubernetesProvider } from "@penvhq/provider-kubernetes";
import { createMockProvider } from "@penvhq/provider-mock";
import { createSsmProvider } from "@penvhq/provider-ssm";
import { createVaultProvider } from "@penvhq/provider-vault";

/** What a factory needs to build a provider rooted at one project's `.penv`. */
export interface ProviderContext {
  /** The `.penv/` directory, absolute. */
  readonly root: string;
  /**
   * Required because a provider parses environment segments, and a segment is an
   * environment only if the config declares it — never inferred from the store.
   */
  readonly config: PenvConfig;
  /**
   * The one environment's own `providers.*` entry, when building its declared
   * source of truth. Carries provider-side settings — a Vault base `path`, say —
   * that the config authored, never inferred. The local-tree factory ignores it:
   * the filesystem tree is `.penv/` whatever an environment declares.
   */
  readonly providerConfig?: ProviderConfig;
  /**
   * The environment this provider is the source of truth *for*, when that is what
   * is being built. Unused by the filesystem tree, which is one store across
   * every environment.
   */
  readonly environment?: string;
}

/** Turns a project's `.penv` context into a provider of one `type`. */
export type ProviderFactory = (context: ProviderContext) => Provider;

/** The factory shape a convention-loaded provider package exports. May be async. */
type PluginProviderFactory = (context: ProviderContext) => Provider | Promise<Provider>;

/** The symbol a provider plugin package exports — the entry point this seam calls. */
const PLUGIN_FACTORY_EXPORT = "penvProviderFactory";

/**
 * The local `.penv` tree is always served by the filesystem provider: it is the
 * working copy `penv pull` materialises and every command edits, whatever backend
 * an environment's source of truth lives in. Naming it here keeps the one string
 * literal that means "the tree on disk" out of `openProject`.
 */
export const LOCAL_TREE_TYPE = "filesystem";

const REGISTRY = new Map<string, ProviderFactory>([
  [LOCAL_TREE_TYPE, ({ root, config }) => createFilesystemProvider({ root, config })],
  ["vault", ({ providerConfig }) => createVaultProvider({ path: providerConfig?.path ?? "penv" })],
  ["ssm", ({ providerConfig }) => createSsmProvider({ path: providerConfig?.path ?? "penv" })],
  [
    "kubernetes",
    ({ providerConfig }) => createKubernetesProvider(kubernetesOptions(providerConfig)),
  ],
  ["mock", ({ root }) => createMockProvider({ storePath: resolve(root, ".penv-mock.json") })],
]);

/** The contract methods a loaded plugin must carry before penv will trust it. */
const CONTRACT_METHODS = [
  "read",
  "write",
  "list",
  "remove",
  "readMeta",
  "writeMeta",
  "removeMeta",
] as const;

/**
 * Loaded plugin modules, memoized by resolved path, so a command touching several
 * environments backed by one package imports it once.
 */
const pluginModuleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Whether a `providers.*.type` names a provider penv builds in. */
export function isProviderRegistered(type: string): boolean {
  return REGISTRY.has(type);
}

/**
 * Builds a *built-in* provider of `type`, refusing an unregistered one loudly.
 * This is the synchronous path `openProject` uses for the local filesystem tree,
 * which is always a built-in — so it stays sync and never dials a plugin. A
 * declared source of truth that may be a plugin is built through
 * {@link createSourceProvider} instead.
 */
export function createProvider(type: string, context: ProviderContext): Provider {
  const factory = REGISTRY.get(type);
  if (factory === undefined) {
    throw unknownProvider(type);
  }
  return factory(context);
}

/**
 * Builds a provider of `type`, resolving a non-built-in `type` as a plugin. A
 * built-in comes from the static map (synchronously); anything else is imported
 * from `@penvhq/provider-<type>`, or the config's `module`, and validated against
 * the contract before it is trusted. The import is async, which is why this is —
 * a network or plugin provider cannot be constructed on a synchronous path.
 */
export async function createSourceProvider(
  type: string,
  context: ProviderContext,
): Promise<Provider> {
  if (REGISTRY.has(type)) {
    return createProvider(type, context);
  }
  return loadPluginProvider(type, context);
}

async function loadPluginProvider(type: string, context: ProviderContext): Promise<Provider> {
  const fromDir = resolutionBase(context);
  const specifier = pluginSpecifier(context.providerConfig, type);

  const resolved = resolvePlugin(specifier, fromDir);
  if (resolved === undefined) {
    throw unknownProvider(type, context.environment, specifier);
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importPlugin(resolved);
  } catch {
    throw new PenvError(
      "PROVIDER_PLUGIN_LOAD",
      `The provider package \`${specifier}\` for type \`${type}\` failed to load`,
      "It resolved but threw while importing. Check it builds and its dependencies are installed.",
    );
  }

  const factory = mod[PLUGIN_FACTORY_EXPORT];
  if (typeof factory !== "function") {
    throw new PenvError(
      "PROVIDER_PLUGIN_INVALID",
      `\`${specifier}\` does not export \`${PLUGIN_FACTORY_EXPORT}\``,
      `A penv provider package must export \`${PLUGIN_FACTORY_EXPORT}(context) => Provider\`.`,
    );
  }

  const provider = await (factory as PluginProviderFactory)(context);
  assertSatisfiesContract(provider, specifier);
  return provider;
}

/**
 * Refuses at open time every environment whose `providers.*.type` names a backend
 * this project cannot construct — the whole config in one pass, so a user with two
 * unknown providers hears about both, and never as a crash from the later command
 * that would have been the first to reach one.
 *
 * A built-in type passes on the map; a plugin type passes only if its package
 * resolves from the project — a *synchronous* existence check that runs no plugin
 * code, so the open-time guarantee holds without `openProject` turning async. The
 * plugin's module is imported and its contract checked later, when the
 * environment's source is actually built.
 */
export function assertProvidersRegistered(config: PenvConfig, projectRoot: string): void {
  for (const [environment, provider] of Object.entries(config.providers)) {
    if (isProviderRegistered(provider.type)) {
      continue;
    }
    const specifier = pluginSpecifier(provider, provider.type);
    if (resolvePlugin(specifier, projectRoot) === undefined) {
      throw unknownProvider(provider.type, environment, specifier);
    }
  }
}

/** The package a non-built-in `type` loads from: the config's `module`, or the convention. */
function pluginSpecifier(providerConfig: ProviderConfig | undefined, type: string): string {
  return providerConfig?.module ?? `@penvhq/provider-${type}`;
}

/** The project the user installed the plugin into — where resolution must start. */
function resolutionBase(context: ProviderContext): string {
  // `context.root` is the `.penv/` directory; its parent is the project root,
  // where `penv.config.ts` and the project's `node_modules` live.
  return dirname(context.root);
}

/**
 * Resolves a plugin specifier from the project, synchronously and without running
 * it. Returns the absolute module path, or `undefined` when the package is not
 * installed. `createRequire` is anchored at the project (not the CLI's own
 * install), so a globally-installed penv still finds a plugin the project depends
 * on.
 */
function resolvePlugin(specifier: string, fromDir: string): string | undefined {
  try {
    const require = createRequire(resolve(fromDir, "noop.js"));
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

/** Imports the resolved module by path, memoized, working from both the ESM and CJS builds. */
function importPlugin(resolvedPath: string): Promise<Record<string, unknown>> {
  const cached = pluginModuleCache.get(resolvedPath);
  if (cached !== undefined) {
    return cached;
  }
  const loading = import(pathToFileURL(resolvedPath).href) as Promise<Record<string, unknown>>;
  pluginModuleCache.set(resolvedPath, loading);
  return loading;
}

/** Fails loudly if a loaded plugin is missing a contract method — at load, not mid-write. */
function assertSatisfiesContract(provider: Provider, specifier: string): void {
  for (const method of CONTRACT_METHODS) {
    if (typeof (provider as unknown as Record<string, unknown>)[method] !== "function") {
      throw new PenvError(
        "PROVIDER_PLUGIN_INVALID",
        `The provider from \`${specifier}\` is missing \`${method}()\``,
        "It must satisfy the @penvhq/core Provider contract that the filesystem provider defines.",
      );
    }
  }
}

/**
 * The Kubernetes provider's `providers.*.path` is `<namespace>/<secretName>`, or
 * just `<secretName>` to use the current `kubectl` context's namespace. Splitting
 * it here is what lets a Secret in a non-`default` namespace be reached from config
 * — `ProviderConfig` has no namespace field of its own.
 */
function kubernetesOptions(providerConfig: ProviderConfig | undefined): {
  namespace?: string;
  secretName: string;
} {
  const path = providerConfig?.path ?? "penv";
  const slash = path.indexOf("/");
  if (slash === -1) return { secretName: path };
  const namespace = path.slice(0, slash);
  const secretName = path.slice(slash + 1) || "penv";
  return namespace === "" ? { secretName } : { namespace, secretName };
}

function unknownProvider(type: string, environment?: string, specifier?: string): PenvError {
  const known = [...REGISTRY.keys()].map((name) => `\`${name}\``).join(", ");
  const where = environment === undefined ? "" : ` for environment ${environment}`;
  const remedy =
    specifier === undefined
      ? `This build registers ${known}. Name a registered provider, or install the build that carries \`${type}\`.`
      : `Install its package with \`npm i ${specifier}\`, or name a built-in provider: ${known}.`;
  return new PenvError(
    "UNKNOWN_PROVIDER",
    `The provider type \`${type}\`${where} in penv.config.ts is not one this penv build carries`,
    remedy,
  );
}
