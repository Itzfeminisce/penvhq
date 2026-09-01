/**
 * Loading and validating `penv.config.ts`.
 *
 * The config is the only source of truth for what counts as an environment, so
 * every check here is an error rather than a warning: a misdeclared environment
 * silently turns a value file into an unreadable one.
 *
 * Loading is synchronous throughout. The runtime `load(schema)` is synchronous
 * and calls into this module, so nothing here may become a promise.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  IllegalEnvironmentNameError,
  PenvError,
  UnknownEnvironmentError,
} from "./errors.js";
import { isLegalEnvironmentName, validateEnvironmentNames } from "./grammar.js";
import { validateKeys } from "./keys.js";
import { validatePublicPrefixes, validateSchemaFile } from "./schema-file.js";
import type { PenvConfig, ValidatedEnvironments } from "./types.js";
import { environmentNames, own } from "./types.js";

const CONFIG_FILENAMES = ["penv.config.ts", "penv.config.js", "penv.config.mjs"] as const;

/** The slice of jiti this module uses, and the whole of what a caller may supply. */
export type JitiApi = Pick<typeof import("jiti"), "createJiti">;

/**
 * jiti is a TypeScript loader, and only evaluating a `penv.config.ts` needs one.
 * A static import would put jiti in the import graph of every bundle that reaches
 * this module, so it is required at first use instead: the runtime chunk then
 * names `jiti` nowhere, and a serverless or edge bundle stops carrying a loader
 * it cannot invoke.
 *
 * `require` rather than `await import` because `load(schema)` is synchronous and
 * must stay so (invariant 3). It resolves from this module's own package, where
 * jiti is a declared dependency.
 */
let jitiModule: JitiApi | undefined;

/**
 * Hands core the loader to use instead of resolving one.
 *
 * The engine's executable is a single bundled file extracted from an npm tarball,
 * so there is no `node_modules` beside it to resolve `jiti` from — it bundles its
 * own copy and registers it here. Everywhere else jiti is a real dependency and
 * nothing calls this.
 */
export function setJitiApi(api: JitiApi): void {
  jitiModule = api;
}

function jitiApi(): JitiApi {
  jitiModule ??= createRequire(import.meta.url)("jiti") as JitiApi;
  return jitiModule;
}

/**
 * A schema that guards itself with `import "server-only"` — the standard Next.js
 * pattern for a module that must never reach a client bundle — imports a package
 * whose default export throws outside a React Server bundle. penv's CLI runs in
 * plain Node, so left alone it cannot even read the `schema` export of a schema
 * the app legitimately marks server-only.
 *
 * The package itself ships the answer: under the `react-server` resolution
 * condition, `server-only` resolves to an empty, no-throw module. jiti only
 * accepts custom conditions per `esmResolve` call, not per instance, so this
 * probes for that variant from the user's own dependencies and returns an alias
 * pinning `server-only` to it. When the project does not depend on `server-only`
 * the probe misses and resolution is left exactly as it was.
 */
function serverOnlyAlias(file: string): Record<string, string> | undefined {
  const probe = jitiApi().createJiti(file, { moduleCache: false });
  const resolved = probe.esmResolve("server-only", {
    try: true,
    conditions: ["node", "react-server", "import", "require", "default"],
  });
  if (resolved === undefined) {
    return undefined;
  }
  // The alias value is joined with path segments during resolution, so it must be
  // a plain absolute path, not a file:// URL.
  return { "server-only": resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved };
}

/**
 * jiti resolves a module's relative imports against the parent it is given, so
 * the parent must be the config file itself — a `penv.config.ts` importing
 * `./shared.ts` means a file next to the config, not one next to penv. Passing
 * the config file also keeps this module free of `import.meta`, which does not
 * exist in the CJS build.
 *
 * `interopDefault` is off so a missing default export stays observable rather
 * than being papered over with the module namespace. `moduleCache` is off so an
 * edited config on the next call is the config penv reads. Shared with the CLI's
 * schema loader so both evaluate user modules identically — including the
 * `server-only` neutralisation (see {@link serverOnlyAlias}).
 */
export function jitiFor(file: string) {
  const alias = serverOnlyAlias(file);
  return jitiApi().createJiti(file, {
    interopDefault: false,
    moduleCache: false,
    ...(alias === undefined ? {} : { alias }),
  });
}

const EXPORT_REMEDY =
  "penv reads its configuration from the default export: " +
  '`export default defineConfig({ environments: { development: "@penvhq/provider-filesystem" } })`.';

function describeValue(value: unknown): string {
  if (value === null) {
    return "`null`";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return `a ${typeof value}`;
}

function quoteList(values: readonly string[]): string {
  if (values.length === 0) {
    return "no declared environments";
  }
  return values.map((value) => `\`${value}\``).join(", ");
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Identity at runtime; the type is where it earns its keep. Each installed
 * provider package merges its config shape into `ProviderConfigMap`, and the
 * generic holds every `environments.<env>` entry to the declaration its
 * `provider` names — exact fields for a known provider, the open base shape for
 * one core has no declaration for, and the bare-string shorthand only where that
 * provider needs no fields. See {@link ValidatedEnvironments}.
 */
export function defineConfig<const C extends PenvConfig>(
  config: C & { readonly environments: ValidatedEnvironments<C["environments"]> },
): PenvConfig {
  return config;
}

/**
 * Files that mark the outermost directory one project can span.
 *
 * Deliberately not `turbo.json`: Turborepo's Package Configurations put one
 * inside a workspace package, so treating it as a root would hide the monorepo's
 * own config from every app under it. Every turborepo root carries one of these.
 */
const WORKSPACE_MARKERS = [
  ".git",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "lerna.json",
] as const;

function declaresWorkspaces(manifest: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    return typeof parsed === "object" && parsed !== null && "workspaces" in parsed;
  } catch {
    return false;
  }
}

/** True for a directory nothing above can still be part of the same project. */
function isWorkspaceRoot(directory: string): boolean {
  for (const marker of WORKSPACE_MARKERS) {
    if (existsSync(resolve(directory, marker))) {
      return true;
    }
  }
  const manifest = resolve(directory, "package.json");
  return existsSync(manifest) && declaresWorkspaces(manifest);
}

/**
 * The directories a config search may look in, nearest first.
 *
 * The walk is bounded, and that is the whole point of this function existing.
 * It stops at the workspace root — the outermost directory a single project can
 * span — and, failing any workspace marker, at the outermost directory still
 * carrying a `package.json`. A walk that climbs to the filesystem root eventually
 * finds a `penv.config.ts` belonging to something else: in a container image, an
 * unrelated config a layer above `/var/task` is a config penv would evaluate and
 * then resolve the whole application from.
 *
 * A package boundary is deliberately *not* a stop: an app in `apps/web` with its
 * own `package.json` reads the monorepo's config at the root, so the walk climbs
 * through package boundaries and halts only at the workspace that contains them.
 * With neither marker anywhere above, the walk is unbounded exactly as before —
 * a bare directory tree with no project shape has no boundary to honor.
 */
function configSearchPath(cwd: string): string[] {
  const chain: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    chain.push(directory);
    if (isWorkspaceRoot(directory)) {
      return chain;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  let outermostPackage = -1;
  for (const [index, candidate] of chain.entries()) {
    if (existsSync(resolve(candidate, "package.json"))) {
      outermostPackage = index;
    }
  }
  return outermostPackage === -1 ? chain : chain.slice(0, outermostPackage + 1);
}

function configFileIn(directory: string): string | undefined {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = resolve(directory, filename);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/** The nearest config file at or above `cwd`, within the project boundary. */
export function findConfigFile(cwd: string): string | undefined {
  for (const directory of configSearchPath(cwd)) {
    const file = configFileIn(directory);
    if (file !== undefined) {
      return file;
    }
  }
  return undefined;
}

export function loadConfigFrom(file: string): PenvConfig {
  const path = isAbsolute(file) ? file : resolve(file);

  let loaded: unknown;
  try {
    loaded = jitiFor(path)(path);
  } catch (cause) {
    throw new ConfigError(
      `${path} could not be loaded: ${causeMessage(cause)}`,
      "Fix the error above, then run the command again. penv evaluates the config file as " +
        "TypeScript, so anything it imports must resolve from the project root.",
    );
  }

  if (loaded === null || typeof loaded !== "object" || !("default" in loaded)) {
    throw new ConfigError(`${path} has no default export`, EXPORT_REMEDY);
  }

  const config: unknown = loaded.default;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigError(
      `The default export of ${path} is ${describeValue(config)}, not a configuration object`,
      EXPORT_REMEDY,
    );
  }

  // The old spine is refused where the config enters the system, not only in
  // `penv validate`: nothing downstream can read it, so every command past this
  // point would report some consequence of the same one fact — `environments`
  // read as `["0", "1"]`, an environment name resolved as a provider package.
  const merged = mergedEnvironmentsBlock(config as PenvConfig);
  const first = merged[0];
  if (first !== undefined) {
    throw first;
  }

  return config as PenvConfig;
}

export function loadConfig(cwd: string = process.cwd()): { config: PenvConfig; file: string } {
  const file = findConfigFile(cwd);
  if (file === undefined) {
    throw new ConfigError(
      `No penv.config.ts found in ${resolve(cwd)} or any parent directory`,
      "Run `penv init` at your project root to create one, or run this command from inside a " +
        "penv project.",
    );
  }
  return { config: loadConfigFrom(file), file };
}

/**
 * The short names providers went by before `provider` became the package name.
 * Recognised only to name the exact rewrite: a config carrying one is a config
 * written against the old surface, and "install `@penvhq/provider-vault` and
 * name it" is a better answer than "not a package specifier".
 */
const LEGACY_PROVIDER_TYPES: Readonly<Record<string, string>> = {
  filesystem: "@penvhq/provider-filesystem",
  vault: "@penvhq/provider-vault",
  ssm: "@penvhq/provider-ssm",
  kubernetes: "@penvhq/provider-kubernetes",
  mock: "@penvhq/provider-mock",
  github: "@penvhq/provider-github",
};

/**
 * The npm package-name grammar, scoped or bare. `provider` is an import
 * specifier, so anything npm would refuse as a name, penv refuses here — before
 * the registry ever tries to resolve it.
 */
const PACKAGE_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

function validateProviderName(environment: string, provider: string): PenvError | undefined {
  const legacy = own(LEGACY_PROVIDER_TYPES, provider);
  if (legacy !== undefined) {
    return new PenvError(
      "PROVIDER_LEGACY",
      `The provider \`${provider}\` for environment ${environment} is a short name, and a provider is a package name`,
      `Write \`${environment}: { provider: "${legacy}" }\` and make sure the package is installed. ` +
        "A provider is the package penv imports, so the config and the dependency tree name the same thing.",
    );
  }
  if (!PACKAGE_NAME.test(provider)) {
    return new PenvError(
      "PROVIDER_INVALID",
      `The provider \`${provider}\` for environment ${environment} is not a package name`,
      `Name the provider's package, e.g. \`${environment}: "@penvhq/provider-filesystem"\`. ` +
        "penv imports the package the `provider` names from this project's node_modules.",
    );
  }
  return undefined;
}

/**
 * `defaultEnvironment` is judged against the whitelist, never trusted for it.
 * The key is what lets `--env` be omitted, so a default naming an environment
 * nothing declares would be the one place an undeclared name reached a command
 * (invariant 10) — and it would reach it on the runs where nobody typed a name
 * to check.
 */
function validateDefaultEnvironment(
  config: PenvConfig,
  declared: ReadonlySet<string>,
): PenvError[] {
  const value: unknown = config.defaultEnvironment;
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return [
      new ConfigError(
        `\`defaultEnvironment\` in penv.config.ts is ${describeValue(value)}, not an environment name`,
        `Name one of ${quoteList([...declared])}, or remove the key and pass \`--env\`.`,
      ),
    ];
  }
  if (!declared.has(value)) {
    return [new UnknownEnvironmentError(value, [...declared])];
  }
  return [];
}

/**
 * The old spine: three parallel structures — `environments` the list, `providers`
 * the record, `keys` the record — describing one thing. A config still carrying
 * any of them is refused with the whole move named, because a silent ignore would
 * drop the providers and the keys and leave the tree unreadable.
 *
 * The `names` → `override` precedent (see {@link legacyNamesBlock}), applied to
 * the config's spine.
 */
function mergedEnvironmentsBlock(config: PenvConfig): PenvError[] {
  const raw = config as unknown as Readonly<Record<string, unknown>>;
  const carried: string[] = [];
  if (Array.isArray(config.environments)) {
    carried.push("`environments` as a list");
  }
  if (raw.providers !== undefined) {
    carried.push("a `providers` block");
  }
  if (raw.keys !== undefined) {
    carried.push("a `keys` block");
  }
  if (carried.length === 0) {
    return [];
  }
  return [
    new PenvError(
      "CONFIG_ENVIRONMENTS_MERGED",
      `penv.config.ts declares ${carried.join(" and ")}, and one \`environments\` record now holds all three`,
      "Give each environment one entry, in its provider's own words: `type` becomes `provider`, " +
        "`location` becomes the field that provider declares (`project` for vercel, `path` for " +
        "ssm and vault), `targets` becomes a single `target` defaulting to the environment's " +
        "name, and `keys.<env>` becomes that entry's `keySource`. So " +
        '`environments: ["production"], providers: { production: { type: "@penvhq/provider-vercel", ' +
        'location: "penv-cloud", targets: { production: "production" } } }, keys: { production: ' +
        '{ source: "env", id: "production" } }` becomes `environments: { production: { provider: ' +
        '"@penvhq/provider-vercel", project: "penv-cloud", keySource: "env" } }`. A key id that is ' +
        "not the environment's own name has to stay in the object form — `keySource: { source: " +
        '"env", id: "prod" }` — because the shorthand names the key after the environment, and a ' +
        "renamed key is a key the sealed values do not carry. An environment whose provider needs " +
        'no fields is just the package name: `development: "@penvhq/provider-filesystem"`.',
    ),
  ];
}

/**
 * An entry that names no backend. Written here and thrown at open time too: an
 * entry penv cannot name a provider for is one whose credentials the run path
 * cannot strip, so the refusal has to happen before any command reaches it.
 */
export function providerMissing(environment: string): PenvError {
  return new PenvError(
    "PROVIDER_MISSING",
    `The entry for environment ${environment} declares no \`provider\``,
    `Name the package of the backend that holds this environment's values, e.g. ` +
      `\`${environment}: { provider: "@penvhq/provider-filesystem" }\`. If it still says ` +
      "`type`, that is the field `provider` replaced.",
  );
}

/**
 * Every problem in one pass. Collected rather than thrown so `penv validate`
 * reports the whole config, not just its first bad line.
 */
export function validateConfig(config: PenvConfig): PenvError[] {
  const errors: PenvError[] = [];

  // Nothing after this point can read the old spine, so the migration is the
  // whole answer rather than the first of a page of consequences.
  const merged = mergedEnvironmentsBlock(config);
  if (merged.length > 0) {
    return merged;
  }

  const environments: unknown = config.environments;
  if (environments === null || typeof environments !== "object") {
    errors.push(
      new PenvError(
        "CONFIG_ENVIRONMENTS_INVALID",
        "`environments` in penv.config.ts is not an object",
        'Declare one entry per environment, e.g. `environments: { development: "@penvhq/provider-filesystem" }`.',
      ),
    );
    return errors;
  }

  const entries = environments as Readonly<Record<string, unknown>>;
  const names = Object.keys(entries);

  if (names.length === 0) {
    errors.push(
      new PenvError(
        "CONFIG_ENVIRONMENTS_EMPTY",
        "`environments` in penv.config.ts is empty, so no environment can ever be loaded",
        'Declare at least one, e.g. `environments: { development: "@penvhq/provider-filesystem" }`. ' +
          "Environments are a whitelist — penv never infers one from a folder or a filename.",
      ),
    );
  }

  const declared = new Set<string>();
  for (const environment of names) {
    if (environment.trim().length === 0) {
      errors.push(
        new PenvError(
          "CONFIG_ENVIRONMENT_INVALID",
          `The environment \`${environment}\` in penv.config.ts is not a non-empty name`,
          'Every key in `environments` is a non-empty name, e.g. `"production"`.',
        ),
      );
      continue;
    }
    declared.add(environment);
  }

  errors.push(...validateEnvironmentNames(config));
  errors.push(...validateDefaultEnvironment(config, declared));

  for (const environment of declared) {
    const entry = own(entries, environment);
    if (typeof entry === "string") {
      const nameError = validateProviderName(environment, entry);
      if (nameError !== undefined) {
        errors.push(nameError);
      }
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        new PenvError(
          "ENVIRONMENT_ENTRY_INVALID",
          `The entry for environment ${environment} is ${describeValue(entry)}, not a provider package name or an entry object`,
          `Declare it as \`${environment}: "@penvhq/provider-filesystem"\`, or as ` +
            `\`${environment}: { provider: "@penvhq/provider-vercel", project: "acme-web" }\` when the provider needs fields.`,
        ),
      );
      continue;
    }
    const provider: unknown = (entry as Readonly<Record<string, unknown>>).provider;
    if (typeof provider !== "string" || provider.trim().length === 0) {
      errors.push(providerMissing(environment));
      continue;
    }
    const nameError = validateProviderName(environment, provider);
    if (nameError !== undefined) {
      errors.push(nameError);
    }
  }

  errors.push(...validateKeys(config, declared));
  errors.push(...validateSchemaFile(config));
  errors.push(...validatePublicPrefixes(config));

  errors.push(...legacyNamesBlock(config));

  const override: unknown = config.override;
  if (override === undefined) {
    return errors;
  }
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    errors.push(
      new PenvError(
        "CONFIG_OVERRIDE_INVALID",
        "`override` in penv.config.ts is not an object",
        'Map a parameter to the variable a consumer expects, e.g. `override: { "database-url": "DATABASE_URL" }`, or remove the block.',
      ),
    );
    return errors;
  }

  const overrideEntries = override as Readonly<Record<string, unknown>>;
  const byVariable = new Map<string, string[]>();
  for (const key of Object.keys(overrideEntries)) {
    const variable = overrideEntries[key];
    if (typeof variable !== "string" || variable.trim().length === 0) {
      errors.push(
        new PenvError(
          "OVERRIDE_EMPTY",
          `The \`override\` for \`${key}\` in penv.config.ts is not a non-empty variable name`,
          `Map it to the variable the consumer expects, e.g. \`"${key}": "DATABASE_URL"\`, or remove the override.`,
        ),
      );
      continue;
    }
    const keys = byVariable.get(variable);
    if (keys === undefined) {
      byVariable.set(variable, [key]);
    } else {
      keys.push(key);
    }
  }

  for (const variable of [...byVariable.keys()].sort()) {
    const keys = byVariable.get(variable);
    if (keys === undefined || keys.length < 2) {
      continue;
    }
    const listed = [...keys].sort().map((key) => `\`${key}\``);
    errors.push(
      new PenvError(
        "OVERRIDE_DUPLICATE",
        `The \`override\` entries ${listed.join(" and ")} in penv.config.ts both map to \`${variable}\``,
        "Two parameters mapping to one generated variable would lose a value on `penv generate`. " +
          "Give one of them a distinct name in the `override` block.",
      ),
    );
  }

  return errors;
}

/**
 * The block was `names` before it was `override` — same shape, honest name. A
 * config still carrying the old key deserves the exact rewrite, not a silent
 * ignore that would quietly ungenerate every bent variable.
 */
function legacyNamesBlock(config: PenvConfig): PenvError[] {
  const names = (config as unknown as Readonly<Record<string, unknown>>).names;
  if (names === undefined) {
    return [];
  }
  return [
    new PenvError(
      "CONFIG_NAMES_RENAMED",
      "`names` in penv.config.ts is now called `override` — it overrides generated variables, and the key says so",
      'Rename the block: `names: { "database-url": "DATABASE_URL" }` becomes ' +
        '`override: { "database-url": "DATABASE_URL" }`. The entries are unchanged.',
    ),
  ];
}

/**
 * Environments are a whitelist: an undeclared name is an error, never inferred.
 *
 * Declared is necessary and not sufficient. The whitelist says which names a
 * project *chose*, not which names penv can *write* — and a name reaches a
 * filename verbatim from here. A declared `.env.development.local` wrote
 * `api-key..env.development.local`, which the grammar then refused to read, so
 * every later command on that tree threw. The list is checked against the
 * grammar rather than trusted, because nothing else stands between a config
 * typo and an unreadable tree.
 */
export function assertEnvironment(environment: string, config: PenvConfig): void {
  const declared = environmentNames(config);
  if (!declared.includes(environment)) {
    throw new UnknownEnvironmentError(environment, declared);
  }
  if (!isLegalEnvironmentName(environment)) {
    throw new IllegalEnvironmentNameError(environment);
  }
}

/**
 * The channel the CLI uses to tell `load()` that it is only harvesting the
 * `schema` export of `.penv/env.ts`, not running the application.
 *
 * The scaffolded schema module ends in an eager `export const env = load(schema)`.
 * Evaluated by the app that is correct fail-fast behavior; evaluated by the CLI
 * against a tree with no values yet it is a catch-22 — the throw makes the whole
 * module namespace unreachable, so the `schema` export the CLI came for is lost,
 * and `penv fill` cannot see the very gap it exists to close. While this variable
 * is pinned (only by the CLI, only for the one schema import, under the same
 * exclusivity lock as `PENV_ENV`), `load()` defers: it returns a lazy stand-in and
 * performs the real load — including the same eager error — on first property
 * access instead of at module evaluation.
 */
export const SCHEMA_HARVEST_ENV = "PENV_SCHEMA_HARVEST";

/** True while the CLI is importing the schema module to read its `schema` export. */
export function schemaHarvestActive(): boolean {
  return process.env[SCHEMA_HARVEST_ENV] === "1";
}

function fromProcessEnv(name: "PENV_ENV" | "NODE_ENV"): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The environment to act on if one is set: explicit, then `PENV_ENV`, then
 * `NODE_ENV`, then the config's `defaultEnvironment`.
 *
 * The declared default comes last because it is the standing answer and the
 * others are this invocation's: a shell that exports `PENV_ENV`, or a CI job
 * that sets `NODE_ENV`, is saying something about the run in hand, and a key
 * committed to the repository must not overrule it. It fills the case that used
 * to be a refusal, and nothing else.
 *
 * Absence is an answer here, not a failure. An unscoped `penv import .env` needs
 * no environment to know the scope it writes at — only the validation that
 * follows needs one — so a command that can proceed without one asks here and
 * says what it skipped. A command that genuinely cannot proceed calls
 * `resolveEnvironment`, which turns the same absence into an error.
 *
 * A declared name is still the only answer: an environment that is set but
 * undeclared throws from here exactly as it does from `resolveEnvironment` —
 * `defaultEnvironment` included, so a default naming an environment the
 * whitelist does not carry is refused rather than quietly acted on.
 */
export function lookupEnvironment(config: PenvConfig, explicit?: string): string | undefined {
  const requested =
    explicit !== undefined && explicit.trim().length > 0 ? explicit.trim() : undefined;
  const declared =
    typeof config.defaultEnvironment === "string" && config.defaultEnvironment.trim().length > 0
      ? config.defaultEnvironment.trim()
      : undefined;
  const environment =
    requested ?? fromProcessEnv("PENV_ENV") ?? fromProcessEnv("NODE_ENV") ?? declared;

  if (environment === undefined) {
    return undefined;
  }

  assertEnvironment(environment, config);
  return environment;
}

/**
 * The environment to act on: explicit, then `PENV_ENV`, then `NODE_ENV`, then
 * `defaultEnvironment`. Absence is the refusal, and it names both remedies —
 * the flag that answers for this invocation, and the key that answers for every
 * one after it.
 */
export function resolveEnvironment(config: PenvConfig, explicit?: string): string {
  const environment = lookupEnvironment(config, explicit);

  if (environment === undefined) {
    throw new ConfigError(
      "No environment is set, so penv cannot tell which environment to load",
      `Pass \`--env <environment>\` — one of ${quoteList(environmentNames(config))} — or declare ` +
        "`defaultEnvironment` in penv.config.ts so every command has one.",
    );
  }

  return environment;
}
