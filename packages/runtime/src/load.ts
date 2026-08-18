/**
 * The runtime loader — the application's typed bridge.
 *
 * `load` is generic and returns `z.infer<T>` — the type the caller's own schema
 * describes, never a widened one. The inferred type is only true because the
 * same schema validates the values before they are returned, so the type you
 * code against and the value you receive cannot diverge.
 *
 * **It validates the environment it was handed, and nothing else** (PRD §4). The
 * bridge does not open `penv.config.ts`, does not walk the records tree, does
 * not decrypt, and never calls a provider. `penv run` resolved the cascade,
 * checked it against the schema, opened what was sealed, and wrote an owned
 * child environment; this reads that environment back under the same names and
 * proves it against the schema a second time, in the process that will use it.
 *
 * That is what makes one bridge serve both deliveries. Running from the project
 * tree and running from a sealed artifact differ entirely in the parent and not
 * at all here — a container started from `penv run --source snapshot` has no
 * config, no tree and no key, and the bridge never wanted any of them. It also
 * moves one refusal: an application started outside `penv run` no longer half
 * resolves a tree, it simply finds nothing penv put there, and hears the sealed
 * direct-start line naming the command that starts it properly.
 *
 * The one thing the bridge cannot work out for itself is which variable each
 * schema parameter arrived in, because `override` in `penv.config.ts` can bend
 * any of them. `penv run` writes that map down beside the values (see
 * `DELIVERY_VARIABLE`), and it is read here as the `override` block it is.
 */

import { basename, isAbsolute, relative } from "node:path";
import type { ParameterRef, PenvConfig } from "@penvhq/core";
import {
  accessPath,
  DeliveryContractMissingError,
  DirectStartError,
  type OverrideKeysOf,
  own,
  parameterId,
  PenvError,
  schemaHarvestActive,
  ValidationError,
  variableName,
} from "@penvhq/core";
import type { z } from "zod";
import type { Delivery, Environment } from "./child-env.js";
import { consumeDelivery, ENVIRONMENT_VARIABLE } from "./child-env.js";
import { debug, debugEnabled } from "./diagnostics.js";
import { declaredRefs, inject } from "./inject.js";

export interface LoadOptions {
  /**
   * The injected environment to validate. Defaults to `process.env`, which is
   * where `penv run` wrote it.
   */
  readonly env?: Record<string, string | undefined>;
  /**
   * The environment name a refusal reports. Defaults to `PENV_ENV`, which
   * `penv run` pins, then `NODE_ENV`.
   */
  readonly environment?: string;
  /**
   * Also inject the validated values into `process.env`, so an SDK that reads
   * `process.env` directly finds them — the blessed ambient surface. Off by
   * default; a consumer who never asked for `process.env` writes gets none.
   *
   * - `true` injects the **whole schema**: every declared parameter, written when
   *   it has a value and deleted when it does not. Use it when the schema holds
   *   only what may safely be ambient.
   * - An **allowlist** of parameter ids injects only those, and leaves every other
   *   parameter untouched — never written, never deleted. Use it when the schema
   *   also holds secrets that must *not* reach `process.env` (database URLs, cloud
   *   credentials): `inject: ["workos/api-key", "workos/client-id"]`. The allowlist
   *   form lives on {@link LoadOptionsFor}, because typing its ids needs the schema.
   *
   * This base type keeps `inject` a plain `boolean` — assignable to
   * {@link LoadOptionsFor} — so a wrapper typed against `LoadOptions` still
   * forwards to `load`. To pass an allowlist, use `LoadOptionsFor<T>` (or the
   * `load(schema, { inject: [...] })` literal, which infers it).
   *
   * See {@link inject}.
   */
  readonly inject?: boolean;
}

/**
 * `load`'s options with the `inject` allowlist narrowed to `T`'s own parameter
 * ids — so the ids autocomplete and a typo is a compile error, without making
 * {@link LoadOptions} generic (which would recurse on the unbound default).
 *
 * Known limitation: an *opaque-record* leaf (`z.record`, a JSON blob) is one
 * injectable parameter at runtime — `declaredRefs` treats an object with no named
 * properties as a leaf — but `OverrideKeysOf` recurses its index signature into
 * `` `id/${string}` ``, so such a leaf cannot be named in the typed allowlist.
 * Inject it with `inject: true`, or reshape it into named fields. This mirrors a
 * pre-existing gap in `override`'s key type and is left for a shared core fix.
 */
export type LoadOptionsFor<T extends z.ZodType> = Omit<LoadOptions, "inject"> & {
  readonly inject?: boolean | readonly OverrideKeysOf<z.infer<T>>[];
};

/**
 * The loader's own view of the options, after `load` has bound the schema: the
 * allowlist has collapsed to a plain `readonly string[]` (its element type no
 * longer matters once the ids are checked at the call site). Kept internal so
 * the exported surface stays `LoadOptions` / `LoadOptionsFor<T>` only.
 */
type ResolvedLoadOptions = Omit<LoadOptions, "inject"> & {
  readonly inject?: boolean | readonly string[];
};

/** A namespace node with no prototype — see `own` in core for why. */
function node(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Places a value at its access path, creating namespaces on the way.
 * Values are placed exactly as they were delivered: coercion is the schema's
 * job, so an environment variable's contents stay a string here.
 */
function place(root: Record<string, unknown>, path: readonly string[], value: string): void {
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    return;
  }

  let target = root;
  for (const key of path.slice(0, -1)) {
    const existing = target[key];
    if (typeof existing === "object" && existing !== null) {
      target = existing as Record<string, unknown>;
      continue;
    }
    const child = node();
    target[key] = child;
    target = child;
  }
  target[leaf] = value;
}

/**
 * The delivery contract as the only piece of configuration the bridge holds.
 *
 * `override` is parameter id → variable, which is exactly what `penv run` wrote
 * down, so the map is read back as one rather than converted into one. Nothing
 * else about a project is knowable here, and nothing else is needed: naming is
 * the only question the injected environment cannot answer about itself.
 */
function deliveryConfig(names: Readonly<Record<string, string>>): PenvConfig {
  return { environments: [], providers: {}, override: names };
}

/** The environment a refusal names: what the caller said, then what `penv run` pinned. */
function environmentOf(options: ResolvedLoadOptions | undefined, env: Environment): string {
  const named = options?.environment ?? env[ENVIRONMENT_VARIABLE] ?? env.NODE_ENV;
  // Nothing set it, which means nothing prepared this process either — the
  // refusal below is about that, and `development` is what an unset `NODE_ENV`
  // means everywhere else in the ecosystem. It names the environment in a
  // message; it never decides one.
  return named === undefined || named.trim().length === 0 ? "development" : named.trim();
}

/**
 * Loads, validates, and returns configuration for the current environment.
 * Eager and synchronous: an environment that does not satisfy the schema fails
 * at startup with a parameter-named error rather than later at first use.
 *
 * One deliberate exception to the eagerness: while the CLI is harvesting the
 * `schema` export of `.penv/env.ts` (see `SCHEMA_HARVEST_ENV` in core), the
 * scaffolded module's own `export const env = load(schema)` must not stop the
 * module from evaluating — the CLI's own environment is not the application's,
 * so this load would throw and take the `schema` export down with it, which is
 * exactly the state `penv fill` exists to fix. In that window `load` returns a
 * lazy stand-in that performs the real load — and raises the same
 * parameter-named error — on first property access. Application runtime never
 * sets the flag, so ordinary loads stay eager and fail-fast.
 */
export function load<T extends z.ZodType>(schema: T, options?: LoadOptionsFor<T>): z.infer<T> {
  try {
    return schemaHarvestActive() ? deferLoad(schema, options) : loadEagerly(schema, options);
  } catch (error) {
    // Nobody catches this one. An adopted app started the old way prints it
    // through Node's default handler, so the frames it shows should be the
    // application's — the line that called `load` — not penv's way down to here.
    throw error instanceof PenvError ? error.hideFramesAbove(load) : error;
  }
}

function loadEagerly<T extends z.ZodType>(schema: T, options?: ResolvedLoadOptions): z.infer<T> {
  // Read once, here, and taken out of `process.env` as it is read: the marker and
  // the delivery contract are penv's message to itself, and the application's
  // first act is this load, so this is where they stop being visible downstream.
  const source = options?.env ?? process.env;
  const delivery = consumeDelivery(source);
  const config = deliveryConfig(delivery.names);
  const environment = environmentOf(options, source);

  const values: { readonly ref: ParameterRef; readonly value: string }[] = [];
  const object = node();
  // Which variable each parameter was read from, so a refusal can say so — the
  // one fact about the delivery an outside reader cannot see.
  const readFrom = new Map<string, string>();
  for (const ref of declaredRefs(schema)) {
    const variable = variableName(ref, config);
    readFrom.set(accessPath(ref).join("."), variable);
    // `own`, never a plain index: the contract is a variable penv reads back, so
    // a parameter delivered as `constructor` must find nothing rather than the
    // prototype's function.
    const value = own(source, variable);
    if (value !== undefined) {
      values.push({ ref, value });
      place(object, accessPath(ref), value);
    }
  }
  debug(describeDelivery(environment, values, config));

  const result = schema.safeParse(object);
  if (!result.success) {
    throw failure({
      environment,
      issues: result.error.issues.map((issue) => ({
        parameter: issue.path.join("."),
        message: issue.message,
      })),
      values,
      delivery,
      readFrom,
      pinned: own(source, ENVIRONMENT_VARIABLE) !== undefined,
    });
  }

  // Validate-first: the injection runs only after the schema has accepted every
  // value, so an SDK reading `process.env` never sees a half-configured surface.
  // Guarded against the harvest window — the CLI reading the `schema` export must
  // never trigger a `process.env` mutation, even if the scaffolded module reads a
  // concrete value at its top level. The delivered strings cross for parameters
  // that arrived (`process.env` is strings); `result.data` is passed only so a
  // schema default reaches the environment instead of being deleted.
  // Injection is opt-in through exactly two shapes: `true` (whole schema) or an
  // allowlist array (only those). Any other value — a truthy non-array a JS caller
  // might pass (`"false"` read from an env var, `1`) — must fail *closed*: never
  // fall through to a whole-schema inject, which would push every secret the
  // allowlist exists to withhold into `process.env`. So the guard tests for the
  // two blessed shapes, not mere truthiness.
  const injectMode = options?.inject;
  if ((injectMode === true || Array.isArray(injectMode)) && !schemaHarvestActive()) {
    inject({
      schema,
      config,
      values,
      validated: result.data,
      ...(Array.isArray(injectMode) ? { only: injectMode } : {}),
    });
  }
  return result.data;
}

interface Failure {
  readonly environment: string;
  readonly issues: readonly { readonly parameter: string; readonly message: string }[];
  readonly values: readonly { readonly ref: ParameterRef; readonly value: string }[];
  readonly delivery: Delivery;
  /** Parameter → the variable it was read from, for the refusal that names one. */
  readonly readFrom: ReadonlyMap<string, string>;
  /** Whether something pinned `PENV_ENV` for this process. */
  readonly pinned: boolean;
}

/**
 * Which refusal a failed validation is, which depends entirely on who is reading
 * it.
 *
 * Three readers, three answers. A required parameter did not arrive in a process
 * penv did not start: an adopted application launched the old way, whose remedy
 * is the command rather than the value. The same absence in a process that
 * carries `PENV_ENV` and no contract is an environment a platform delivered
 * under names penv was never told — the remedy is the map, not the command.
 * Anything else — a value the schema rejects, or a failure inside `penv run`,
 * where the environment was already prepared and checked once — is the plain
 * validation error it has always been.
 *
 * The fourth reader the tree-reading bridge used to serve, a teammate who has
 * cloned and not yet pulled, is `penv run`'s now: it is the half that knows
 * whether the environment has somewhere to pull *from*, and it refuses before
 * the application starts at all.
 */
function failure(failed: Failure): ValidationError {
  const { environment, issues, delivery } = failed;
  if (delivery.invocation !== undefined) {
    return new ValidationError(environment, issues);
  }
  const delivered = new Set(failed.values.map(({ ref }) => accessPath(ref).join(".")));
  const missing = issues.find((issue) => !delivered.has(issue.parameter));
  if (missing === undefined) {
    return new ValidationError(environment, issues);
  }
  if (failed.pinned && Object.keys(delivery.names).length === 0) {
    return new DeliveryContractMissingError(
      environment,
      issues,
      missing.parameter,
      failed.readFrom.get(missing.parameter) ?? missing.parameter,
    );
  }
  return new DirectStartError(environment, issues, missing.parameter, thisCommand());
}

/**
 * This process, restated as the command that would start it under `penv run`.
 *
 * Best effort by construction: a process cannot recover the shell line that
 * launched it (`npm run dev` reaches here as a node invocation of a script
 * path), and the remediation's job is to show the *shape* — `penv run -- ` in
 * front of what you type — not to be pasted blind.
 */
function thisCommand(): string {
  const [runtime, ...rest] = process.argv;
  const command = basename(runtime ?? "node").replace(/\.exe$/i, "");
  return [command, ...rest.map(shorten)]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

/** An argument inside the project, written the way the user would type it. */
function shorten(argument: string): string {
  if (!isAbsolute(argument)) {
    return argument;
  }
  const local = relative(process.cwd(), argument);
  return local === "" || local.startsWith("..") ? argument : local;
}

/** The `PENV_DEBUG=1` account of one load: what arrived, and under which name. */
function describeDelivery(
  environment: string,
  values: readonly { readonly ref: ParameterRef; readonly value: string }[],
  config: PenvConfig,
): string[] {
  if (!debugEnabled()) {
    return [];
  }
  return [
    `environment ${environment}, read from the injected environment`,
    `${values.length} parameter${values.length === 1 ? "" : "s"} delivered`,
    ...values.map(({ ref }) => `  ${parameterId(ref)} <- ${variableName(ref, config)}`),
  ];
}

/**
 * `load`'s harvest-time stand-in: nothing is read or validated until a property
 * is actually read. The schema module's top level only *binds*
 * `export const env`, so under harvest the binding succeeds, the CLI reads the
 * `schema` export, and the deferred error — if the environment still cannot
 * satisfy the schema — surfaces on first real use with the same
 * `ValidationError` the eager path throws.
 */
function deferLoad<T extends z.ZodType>(schema: T, options?: ResolvedLoadOptions): z.infer<T> {
  let materialized = false;
  let value: unknown;
  const materialize = (): object => {
    if (!materialized) {
      value = loadEagerly(schema, options);
      materialized = true;
    }
    // `Object(...)` keeps the traps total even for a schema whose root is not an
    // object — property reads then forward to the boxed primitive.
    return Object(value);
  };

  return new Proxy({} as Record<PropertyKey, unknown>, {
    get(_target, property) {
      // Module plumbing probes exported values while the harvest import is still
      // in flight — `then` (module namespaces are awaited by some loaders) and
      // well-known symbols (inspection). Those probes must not force the load;
      // real reads, which arrive after the harvest window closes, must.
      if (schemaHarvestActive() && (typeof property === "symbol" || property === "then")) {
        return undefined;
      }
      return Reflect.get(materialize(), property);
    },
    has(_target, property) {
      return Reflect.has(materialize(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(materialize());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(materialize(), property);
      // Configurable, so the descriptor stays compatible with the empty proxy
      // target — the invariant check would throw for a frozen original otherwise.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
  }) as z.infer<T>;
}
