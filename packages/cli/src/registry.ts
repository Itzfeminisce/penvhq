/**
 * The provider registry: the one place the CLI turns an environment entry's
 * `provider` into a concrete provider.
 *
 * It lives in the CLI, not in `@penvhq/core` and not in `@penvhq/runtime`. Core owns
 * the `Provider` *contract* and must not know which implementations exist —
 * knowing would make the interface answerable to its callers. The runtime never
 * selects a provider at all: it reads the local records tree whatever an
 * environment declares (see `runtime/src/resolve.ts`), so a registry there would
 * be the ability to dial a network provider at boot, which the design forbids.
 *
 * A provider is the package's fully-qualified name, and the name is the
 * import specifier. The registry pre-installs just two providers — the
 * filesystem tree every command edits and the mock used to rehearse rotation —
 * so "built-in" means only "already installed", not a different kind of
 * provider. Nothing else in the CLI names an implementation.
 *
 * Everything else is an extension, and {@link resolveExtension} owns the one
 * order every command finds one in: the local-extension list, then the project's
 * own `node_modules`, then `$PENV_HOME` at the version the manifest pins.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AnyProvider,
  Manifest,
  PenvConfig,
  Provider,
  ProviderFactoryContext,
} from "@penvhq/core";
import {
  environmentEntry,
  environmentNames,
  holdsProjection,
  LOCAL_EXTENSIONS_PATH,
  localExtensionsFile,
  MANIFEST_PATH,
  PENV_DIR,
  PenvError,
  packageDir,
  packageEntry,
  parseLocalExtensions,
  parseManifest,
  penvHome,
  recordsDir,
} from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { createMockProvider } from "@penvhq/provider-mock";

/**
 * What a factory needs to build a provider for one project. The shape is core's:
 * it is the seam provider packages build against, so the CLI consumes the same
 * declaration they do rather than restating it.
 */
export type ProviderContext = ProviderFactoryContext;

/** Turns one project's context into a provider of one `type`. */
export type ProviderFactory = (context: ProviderContext) => Provider;

/** The factory shape a provider package exports. May be async. */
type PluginProviderFactory = (context: ProviderContext) => AnyProvider | Promise<AnyProvider>;

/** The symbol a provider package exports — the entry point this seam calls. */
const PLUGIN_FACTORY_EXPORT = "penvProviderFactory";

/**
 * The local records tree is always served by the filesystem provider: it is the
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
  [
    LOCAL_TREE_TYPE,
    ({ root, config }) => createFilesystemProvider({ root: recordsDir(root), config }),
  ],
  [
    "@penvhq/provider-mock",
    ({ root }) => createMockProvider({ storePath: resolve(root, PENV_DIR, ".penv-mock.json") }),
  ],
]);

/** The record contract's methods — what a records-holding provider must carry before penv trusts it. */
const RECORD_CONTRACT_METHODS = [
  "read",
  "write",
  "list",
  "remove",
  "readMeta",
  "writeMeta",
  "removeMeta",
] as const;

/** The projection contract's required methods — the smaller surface a projection-holding provider carries. */
const PROJECTION_CONTRACT_METHODS = ["verify", "push", "list"] as const;

/**
 * Loaded provider modules, memoized by resolved path, so a command touching
 * several environments backed by one package imports it once.
 */
const pluginModuleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Whether a package name is one the CLI ships pre-installed. */
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
): Promise<AnyProvider> {
  if (REGISTRY.has(type)) {
    return createProvider(type, context);
  }
  return loadPluginProvider(type, context);
}

async function loadPluginProvider(type: string, context: ProviderContext): Promise<AnyProvider> {
  const path = resolveExtension(type, context.root, context.environment);

  let mod: Record<string, unknown>;
  try {
    mod = await importPlugin(path);
  } catch (cause) {
    throw providerLoadFailed(type, path, cause);
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
 * Refuses at open time every environment whose `provider` names a backend
 * this project cannot construct — the whole config in one pass, so a user with two
 * unknown providers hears about both, and never as a crash from the later command
 * that would have been the first to reach one.
 *
 * A pre-installed type passes on the map; any other passes only if
 * {@link resolveExtension} finds it — a *synchronous* existence check that runs
 * no provider code, so the open-time guarantee holds without `openProject`
 * turning async. The package's module is imported and its contract checked
 * later, when the environment's source is actually built.
 */
export function assertProvidersRegistered(
  config: PenvConfig,
  projectRoot: string,
  options?: { readonly ci?: boolean },
): void {
  const local = localExtensions(projectRoot);
  const ci = options?.ci ?? isCi(process.env.CI);
  for (const environment of environmentNames(config)) {
    const provider = environmentEntry(config, environment)?.provider;
    if (provider === undefined || isProviderRegistered(provider)) {
      continue;
    }
    if (ci && local.includes(provider)) {
      throw localExtensionInCi(provider, environment);
    }
    resolveExtension(provider, projectRoot, environment, local);
  }
}

/**
 * The one place an extension is located, and the one order it is looked for in.
 * Every command resolves through here, so what `doctor` reports, what
 * `openProject` refuses, and what a provider operation imports are one answer.
 *
 * 1. **The local-extension list.** A package this checkout builds is read out of
 *    the project and never out of the store: nothing pins it, so there are no
 *    bytes in the store that could be it.
 * 2. **The project's own `node_modules`.** A package the project depends on wins
 *    over anything the manifest pins — a repository editing a provider runs the
 *    copy it is editing, not a release installed beside it.
 * 3. **`$PENV_HOME/extensions/<name>/<version>`, at the version the manifest
 *    pins.** What `penv add` installed, `penv install` restores, and the
 *    launcher verified before it passed `$PENV_HOME` to this process. This is
 *    the path an extension added from a registry takes: `penv add` leaves
 *    nothing in the project but a type declaration, so nothing about it resolves
 *    from `node_modules`.
 *
 * Locating is not loading. This runs no provider code; the module is imported
 * only when a command actually performs a provider operation.
 */
function resolveExtension(
  type: string,
  projectRoot: string,
  environment?: string,
  local: readonly string[] = localExtensions(projectRoot),
): string {
  const fromProject = resolvePlugin(type, projectRoot);
  if (local.includes(type)) {
    if (fromProject === undefined) {
      throw localExtensionUnresolved(type, projectRoot, environment);
    }
    return fromProject;
  }
  if (fromProject !== undefined) {
    return fromProject;
  }

  const version = pinnedVersion(type, projectRoot);
  if (version === undefined) {
    throw unknownProvider(type, environment);
  }
  const stored = storedExtension(type, version);
  if (stored === undefined) {
    throw extensionNotInstalled(type, version, environment);
  }
  return stored;
}

/**
 * The version the manifest pins for `type`, or `undefined` when it pins none.
 *
 * A manifest penv cannot read is not this function's refusal: the launcher reads
 * it first on every run and owns every message about it, so a broken one here
 * means the type is simply not pinned — and the caller's own refusal, which
 * names the package rather than the file, is the better one to arrive.
 */
function pinnedVersion(type: string, projectRoot: string): string | undefined {
  let manifest: Manifest;
  try {
    manifest = parseManifest(readFileSync(join(projectRoot, ...MANIFEST_PATH.split("/")), "utf8"));
  } catch {
    return undefined;
  }
  return manifest.extensions[type]?.version;
}

/** The module of one pinned extension in `$PENV_HOME`, or `undefined` if it is not there. */
function storedExtension(type: string, version: string): string | undefined {
  const entry = packageEntry(packageDir(penvHome(process.env), "extensions", type, version));
  return entry?.file;
}

/** The extensions this project develops, as `penv add --local` recorded them. */
export function localExtensions(projectRoot: string): string[] {
  let text: string;
  try {
    text = readFileSync(localExtensionsFile(projectRoot), "utf8");
  } catch {
    return [];
  }
  return parseLocalExtensions(text);
}

function isCi(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * A local extension is the copy in this checkout, and nothing pins its bytes —
 * which is exactly what a pipeline may not run on. The remedy is the registry
 * path, because that is the one that produces something CI can verify.
 */
function localExtensionInCi(type: string, environment: string): PenvError {
  return new PenvError(
    "LOCAL_EXTENSION_IN_CI",
    `The provider \`${type}\` for environment ${environment} is a local extension, and this is CI`,
    `${LOCAL_EXTENSIONS_PATH} records it as a package this project develops, so nothing pins ` +
      `the bytes CI would run. Publish it and run \`penv add ${type}\` to pin a release.`,
  );
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

/**
 * Fails loudly if a loaded provider is missing a contract method — at load, not
 * mid-write. Which contract is the provider's own declaration: a
 * `holds: "projection"` capability selects the projection surface, anything
 * else the seven-method record contract the filesystem defines.
 */
function assertSatisfiesContract(provider: AnyProvider, specifier: string): void {
  const projection = holdsProjection(provider);
  const methods: readonly string[] = projection
    ? PROJECTION_CONTRACT_METHODS
    : RECORD_CONTRACT_METHODS;
  const contract = projection
    ? "the @penvhq/core ProjectionProvider contract its declared capabilities select"
    : "the @penvhq/core Provider contract that the filesystem provider defines";
  for (const method of methods) {
    if (typeof (provider as unknown as Record<string, unknown>)[method] !== "function") {
      throw new PenvError(
        "PROVIDER_PLUGIN_INVALID",
        `The provider from \`${specifier}\` is missing \`${method}()\``,
        `It must satisfy ${contract}.`,
      );
    }
  }
}

function where(environment: string | undefined): string {
  return environment === undefined ? "" : ` for environment ${environment}`;
}

function unknownProvider(type: string, environment?: string): PenvError {
  const preinstalled = [...REGISTRY.keys()].map((name) => `\`${name}\``).join(", ");
  return new PenvError(
    "UNKNOWN_PROVIDER",
    `The provider \`${type}\`${where(environment)} in penv.config.ts is nowhere penv looks for it`,
    `Run \`penv add ${type}\` to pin a release, or \`penv add --local ${type}\` if this ` +
      `repository is the one that builds it. penv looks in ${LOCAL_EXTENSIONS_PATH}, this ` +
      `project's node_modules, and then $PENV_HOME at the version ${MANIFEST_PATH} pins. The ` +
      `CLI ships ${preinstalled} pre-installed.`,
  );
}

/**
 * The manifest pins this extension and `$PENV_HOME` does not hold it — the one
 * unresolvable provider with a command behind it, so it names that command
 * rather than reporting the package as unknown.
 */
function extensionNotInstalled(type: string, version: string, environment?: string): PenvError {
  return new PenvError(
    "EXTENSION_NOT_INSTALLED",
    `${MANIFEST_PATH} pins \`${type}\` ${version}${where(environment)}, and it is not installed ` +
      `in ${penvHome(process.env)}`,
    "Run `penv install` — it downloads and verifies every version the manifest pins, extensions " +
      "included.",
  );
}

/**
 * A local extension that stopped resolving. It is the copy this checkout builds,
 * so the store is not a second place to look — the project either has it or the
 * record is stale.
 */
function localExtensionUnresolved(
  type: string,
  projectRoot: string,
  environment?: string,
): PenvError {
  return new PenvError(
    "LOCAL_EXTENSION_UNRESOLVED",
    `${LOCAL_EXTENSIONS_PATH} records \`${type}\`${where(environment)} as a package this project ` +
      `develops, and it does not resolve from ${projectRoot}`,
    `Add it as a dependency of the root (a workspace link is one) and run \`pnpm install\`, or ` +
      `drop the name from ${LOCAL_EXTENSIONS_PATH} if this project no longer builds it.`,
  );
}

/**
 * A provider that resolved and would not import.
 *
 * The cause and the file are the message: `ERR_UNKNOWN_FILE_EXTENSION` on a
 * `src/index.ts` is the whole diagnosis, and a refusal that keeps neither sends
 * the reader to reproduce the import by hand outside penv.
 */
function providerLoadFailed(type: string, path: string, cause: unknown): PenvError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PenvError(
    "PROVIDER_PLUGIN_LOAD",
    `The provider package \`${type}\` failed to load from ${path}: ${detail}`,
    "penv imports that file exactly as it stands, with no transform, so it has to be built " +
      "JavaScript with its dependencies installed.",
  );
}
