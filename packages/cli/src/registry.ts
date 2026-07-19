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
 * A `type` is the provider package's fully-qualified name, and the name is the
 * import specifier: `@penvhq/provider-vault` is resolved from the *project's*
 * `node_modules` and imported, exactly as the project's own code would import it.
 * The registry pre-installs just two providers — the filesystem tree every
 * command edits and the mock used to rehearse rotation — so "built-in" means
 * only "already installed", not a different kind of provider. Nothing else in
 * the CLI names an implementation.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PenvConfig, Provider, ProviderFactoryContext } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { createMockProvider } from "@penvhq/provider-mock";

/**
 * What a factory needs to build a provider rooted at one project's `.penv`.
 * The shape is core's: it is the seam provider packages build against, so the
 * CLI consumes the same declaration they do rather than restating it.
 */
export type ProviderContext = ProviderFactoryContext;

/** Turns a project's `.penv` context into a provider of one `type`. */
export type ProviderFactory = (context: ProviderContext) => Provider;

/** The factory shape a provider package exports. May be async. */
type PluginProviderFactory = (context: ProviderContext) => Provider | Promise<Provider>;

/** The symbol a provider package exports — the entry point this seam calls. */
const PLUGIN_FACTORY_EXPORT = "penvProviderFactory";

/**
 * The local `.penv` tree is always served by the filesystem provider: it is the
 * working copy `penv pull` materialises and every command edits, whatever backend
 * an environment's source of truth lives in. Naming it here keeps the one string
 * literal that means "the tree on disk" out of `openProject`.
 */
export const LOCAL_TREE_TYPE = "@penvhq/provider-filesystem";

/**
 * The providers that ship inside the CLI, so they resolve without the project
 * installing anything: the local tree itself, and the mock that rehearses
 * rotation. Every other provider is a package the project depends on.
 */
const REGISTRY = new Map<string, ProviderFactory>([
  [LOCAL_TREE_TYPE, ({ root, config }) => createFilesystemProvider({ root, config })],
  [
    "@penvhq/provider-mock",
    ({ root }) => createMockProvider({ storePath: resolve(root, ".penv-mock.json") }),
  ],
]);

/** The contract methods a loaded provider must carry before penv will trust it. */
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
 * Loaded provider modules, memoized by resolved path, so a command touching
 * several environments backed by one package imports it once.
 */
const pluginModuleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Whether a `providers.*.type` names a provider the CLI ships pre-installed. */
export function isProviderRegistered(type: string): boolean {
  return REGISTRY.has(type);
}

/**
 * Builds a *pre-installed* provider of `type`, refusing any other loudly. This is
 * the synchronous path `openProject` uses for the local filesystem tree, which
 * always ships with the CLI — so it stays sync and never dials a package. A
 * declared source of truth, which may be any installed provider package, is
 * built through {@link createSourceProvider} instead.
 */
export function createProvider(type: string, context: ProviderContext): Provider {
  const factory = REGISTRY.get(type);
  if (factory === undefined) {
    throw unknownProvider(type);
  }
  return factory(context);
}

/**
 * Builds a provider of `type`. A pre-installed provider comes from the static map
 * (synchronously); anything else is imported from the package `type` names and
 * validated against the contract before it is trusted. The import is async,
 * which is why this is — a network provider cannot be constructed on a
 * synchronous path.
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

  const resolved = resolvePlugin(type, fromDir);
  if (resolved === undefined) {
    throw unknownProvider(type, context.environment);
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importPlugin(resolved);
  } catch {
    throw new PenvError(
      "PROVIDER_PLUGIN_LOAD",
      `The provider package \`${type}\` failed to load`,
      "It resolved but threw while importing. Check it builds and its dependencies are installed.",
    );
  }

  const factory = mod[PLUGIN_FACTORY_EXPORT];
  if (typeof factory !== "function") {
    throw new PenvError(
      "PROVIDER_PLUGIN_INVALID",
      `\`${type}\` does not export \`${PLUGIN_FACTORY_EXPORT}\``,
      `A penv provider package must export \`${PLUGIN_FACTORY_EXPORT}(context) => Provider\`.`,
    );
  }

  const provider = await (factory as PluginProviderFactory)(context);
  assertSatisfiesContract(provider, type);
  return provider;
}

/**
 * Refuses at open time every environment whose `providers.*.type` names a backend
 * this project cannot construct — the whole config in one pass, so a user with two
 * unknown providers hears about both, and never as a crash from the later command
 * that would have been the first to reach one.
 *
 * A pre-installed type passes on the map; any other passes only if its package
 * resolves from the project — a *synchronous* existence check that runs no
 * provider code, so the open-time guarantee holds without `openProject` turning
 * async. The package's module is imported and its contract checked later, when
 * the environment's source is actually built.
 */
export function assertProvidersRegistered(config: PenvConfig, projectRoot: string): void {
  for (const [environment, provider] of Object.entries(config.providers)) {
    if (isProviderRegistered(provider.type)) {
      continue;
    }
    if (resolvePlugin(provider.type, projectRoot) === undefined) {
      throw unknownProvider(provider.type, environment);
    }
  }
}

/** The project the user installed the provider into — where resolution must start. */
function resolutionBase(context: ProviderContext): string {
  // `context.root` is the `.penv/` directory; its parent is the project root,
  // where `penv.config.ts` and the project's `node_modules` live.
  return dirname(context.root);
}

/**
 * Resolves a provider package from the project, synchronously and without running
 * it. Returns the absolute module path, or `undefined` when the package is not
 * installed. `createRequire` is anchored at the project (not the CLI's own
 * install), so a globally-installed penv still finds a provider the project
 * depends on.
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

/** Fails loudly if a loaded provider is missing a contract method — at load, not mid-write. */
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

function unknownProvider(type: string, environment?: string): PenvError {
  const preinstalled = [...REGISTRY.keys()].map((name) => `\`${name}\``).join(", ");
  const where = environment === undefined ? "" : ` for environment ${environment}`;
  return new PenvError(
    "UNKNOWN_PROVIDER",
    `The provider \`${type}\`${where} in penv.config.ts is not installed in this project`,
    `Install it with \`npm i ${type}\` — a provider's \`type\` is the package penv imports. ` +
      `The CLI ships ${preinstalled} pre-installed.`,
  );
}
