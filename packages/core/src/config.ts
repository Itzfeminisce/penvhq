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

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  ConfigError,
  IllegalEnvironmentNameError,
  PenvError,
  UnknownEnvironmentError,
} from "./errors.js";
import { isLegalEnvironmentName, validateEnvironmentNames } from "./grammar.js";
import { validateKeys } from "./keys.js";
import { validatePublicPrefixes, validateSchemaFile } from "./schema-file.js";
import { validateSinks } from "./sinks.js";
import type { PenvConfig, ValidatedProviders } from "./types.js";

const CONFIG_FILENAMES = ["penv.config.ts", "penv.config.js", "penv.config.mjs"] as const;

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
  const probe = createJiti(file, { moduleCache: false });
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
  return createJiti(file, {
    interopDefault: false,
    moduleCache: false,
    ...(alias === undefined ? {} : { alias }),
  });
}

const EXPORT_REMEDY =
  "penv reads its configuration from the default export: " +
  "`export default defineConfig({ environments: [...], providers: { ... } })`.";

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
 * generic holds every `providers.<env>` entry to the declaration its `type`
 * names — exact fields for a known provider, the open base shape for one core
 * has no declaration for. See {@link ValidatedProviders}.
 */
export function defineConfig<const C extends PenvConfig>(
  config: C & { readonly providers: ValidatedProviders<C["providers"]> },
): PenvConfig {
  return config;
}

/** The nearest config file at or above `cwd`, or `undefined` at the root. */
export function findConfigFile(cwd: string): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(directory, filename);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
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
 * The short names providers went by before `type` became the package name.
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
};

/**
 * The npm package-name grammar, scoped or bare. `type` is an import specifier,
 * so anything npm would refuse as a name, penv refuses as a `type` — before the
 * registry ever tries to resolve it.
 */
const PACKAGE_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

function validateProviderType(environment: string, type: string): PenvError | undefined {
  const legacy = LEGACY_PROVIDER_TYPES[type];
  if (legacy !== undefined) {
    return new PenvError(
      "PROVIDER_TYPE_LEGACY",
      `The provider type \`${type}\` for environment ${environment} is a short name, and provider types are package names`,
      `Write \`${environment}: { type: "${legacy}" }\` and make sure the package is installed. ` +
        "A provider's `type` is the package penv imports, so the config and the dependency tree name the same thing.",
    );
  }
  if (!PACKAGE_NAME.test(type)) {
    return new PenvError(
      "PROVIDER_TYPE_INVALID",
      `The provider type \`${type}\` for environment ${environment} is not a package name`,
      `Name the provider's package, e.g. \`${environment}: { type: "@penvhq/provider-filesystem" }\`. ` +
        "penv imports the package the `type` names from this project's node_modules.",
    );
  }
  return undefined;
}

/**
 * Every problem in one pass. Collected rather than thrown so `penv validate`
 * reports the whole config, not just its first bad line.
 */
export function validateConfig(config: PenvConfig): PenvError[] {
  const errors: PenvError[] = [];

  const environments: readonly string[] = config.environments;
  if (!Array.isArray(environments)) {
    errors.push(
      new PenvError(
        "CONFIG_ENVIRONMENTS_INVALID",
        "`environments` in penv.config.ts is not an array",
        'Declare the whitelist as an array of names, e.g. `environments: ["development", "production"]`.',
      ),
    );
    return errors;
  }

  if (environments.length === 0) {
    errors.push(
      new PenvError(
        "CONFIG_ENVIRONMENTS_EMPTY",
        "`environments` in penv.config.ts is empty, so no environment can ever be loaded",
        'Declare at least one environment, e.g. `environments: ["development", "production"]`. ' +
          "Environments are a whitelist — penv never infers one from a folder or a filename.",
      ),
    );
  }

  const declared = new Set<string>();
  for (const environment of environments) {
    if (typeof environment !== "string" || environment.trim().length === 0) {
      errors.push(
        new PenvError(
          "CONFIG_ENVIRONMENT_INVALID",
          `The environment \`${String(environment)}\` in penv.config.ts is not a non-empty name`,
          'Every entry in `environments` is a non-empty string, e.g. `"production"`.',
        ),
      );
      continue;
    }
    if (declared.has(environment)) {
      errors.push(
        new PenvError(
          "CONFIG_ENVIRONMENT_DUPLICATE",
          `The environment \`${environment}\` is declared twice in penv.config.ts`,
          "Each environment is declared once. Remove the duplicate.",
        ),
      );
      continue;
    }
    declared.add(environment);
  }

  errors.push(...validateEnvironmentNames(config));

  const providers: unknown = config.providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    errors.push(
      new PenvError(
        "CONFIG_PROVIDERS_INVALID",
        "`providers` in penv.config.ts is not an object",
        'Declare one provider per environment, e.g. `providers: { production: { type: "@penvhq/provider-filesystem" } }`.',
      ),
    );
    return errors;
  }

  const providerEntries = providers as Readonly<Record<string, unknown>>;

  for (const environment of declared) {
    const provider = providerEntries[environment];
    if (provider === undefined) {
      errors.push(
        new PenvError(
          "PROVIDER_MISSING",
          `Environment ${environment} has no entry in \`providers\` in penv.config.ts`,
          `Add \`${environment}: { type: "@penvhq/provider-filesystem" }\` to the \`providers\` block, or remove ` +
            `\`${environment}\` from \`environments\`.`,
        ),
      );
      continue;
    }
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
      errors.push(
        new PenvError(
          "PROVIDER_INVALID",
          `The provider for environment ${environment} is ${describeValue(provider)}, not a provider object`,
          `Declare it as \`${environment}: { type: "@penvhq/provider-filesystem" }\`, adding a \`location\` when the ` +
            "backend needs one.",
        ),
      );
      continue;
    }
    const type: unknown = (provider as Readonly<Record<string, unknown>>).type;
    if (typeof type !== "string" || type.trim().length === 0) {
      errors.push(
        new PenvError(
          "PROVIDER_TYPE_MISSING",
          `The provider for environment ${environment} declares no \`type\``,
          `Name the package of the backend that holds this environment's values, e.g. ` +
            `\`${environment}: { type: "@penvhq/provider-filesystem" }\`.`,
        ),
      );
      continue;
    }
    const typeError = validateProviderType(environment, type);
    if (typeError !== undefined) {
      errors.push(typeError);
    }
  }

  for (const environment of Object.keys(providerEntries)) {
    if (!declared.has(environment)) {
      errors.push(new UnknownEnvironmentError(environment, environments));
    }
  }

  errors.push(...validateKeys(config, declared));
  errors.push(...validateSinks(config, declared));
  errors.push(...validateSchemaFile(config));
  errors.push(...validatePublicPrefixes(config));

  const names: unknown = config.names;
  if (names === undefined) {
    return errors;
  }
  if (names === null || typeof names !== "object" || Array.isArray(names)) {
    errors.push(
      new PenvError(
        "CONFIG_NAMES_INVALID",
        "`names` in penv.config.ts is not an object",
        'Map a parameter to the variable a deploy target expects, e.g. `names: { "database-url": "DATABASE_URL" }`, or remove the block.',
      ),
    );
    return errors;
  }

  const nameEntries = names as Readonly<Record<string, unknown>>;
  const byVariable = new Map<string, string[]>();
  for (const key of Object.keys(nameEntries)) {
    const variable = nameEntries[key];
    if (typeof variable !== "string" || variable.trim().length === 0) {
      errors.push(
        new PenvError(
          "NAME_OVERRIDE_EMPTY",
          `The \`names\` override for \`${key}\` in penv.config.ts is not a non-empty variable name`,
          `Map it to the variable the deploy target expects, e.g. \`"${key}": "DATABASE_URL"\`, or remove the override.`,
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
        "NAME_OVERRIDE_DUPLICATE",
        `The \`names\` overrides ${listed.join(" and ")} in penv.config.ts both map to \`${variable}\``,
        "Two parameters mapping to one generated variable would lose a value on `penv generate`. " +
          "Give one of them a distinct name in the `names` block.",
      ),
    );
  }

  return errors;
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
  if (!config.environments.includes(environment)) {
    throw new UnknownEnvironmentError(environment, config.environments);
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
 * The environment to act on if one is set: explicit, then `PENV_ENV`, then `NODE_ENV`.
 *
 * Absence is an answer here, not a failure. An unscoped `penv import .env` needs
 * no environment to know the scope it writes at — only the validation that
 * follows needs one — so a command that can proceed without one asks here and
 * says what it skipped. A command that genuinely cannot proceed calls
 * `resolveEnvironment`, which turns the same absence into an error.
 *
 * A declared name is still the only answer: an environment that is set but
 * undeclared throws from here exactly as it does from `resolveEnvironment`.
 */
export function lookupEnvironment(config: PenvConfig, explicit?: string): string | undefined {
  const requested =
    explicit !== undefined && explicit.trim().length > 0 ? explicit.trim() : undefined;
  const environment = requested ?? fromProcessEnv("PENV_ENV") ?? fromProcessEnv("NODE_ENV");

  if (environment === undefined) {
    return undefined;
  }

  assertEnvironment(environment, config);
  return environment;
}

/** The environment to act on: explicit, then `PENV_ENV`, then `NODE_ENV`. */
export function resolveEnvironment(config: PenvConfig, explicit?: string): string {
  const environment = lookupEnvironment(config, explicit);

  if (environment === undefined) {
    throw new ConfigError(
      "No environment is set, so penv cannot tell which environment to load",
      `Set \`PENV_ENV\` (or \`NODE_ENV\`) to one of ${quoteList(config.environments)}, or pass ` +
        "`--env <environment>`.",
    );
  }

  return environment;
}
