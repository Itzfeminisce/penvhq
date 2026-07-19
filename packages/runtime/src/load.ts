/**
 * The runtime loader. `load` is generic and returns `z.infer<T>` — the type the
 * caller's own schema describes, never a widened one. The inferred type is only
 * true because the same schema validates the values before they are returned,
 * so the type you code against and the value you receive cannot diverge.
 */

import { accessPath, schemaHarvestActive, ValidationError } from "@penvhq/core";
import type { z } from "zod";
import { resolveSync } from "./resolve.js";

export interface LoadOptions {
  /** Where to start looking for `penv.config.ts`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Overrides `PENV_ENV` / `NODE_ENV`. Must be a declared environment. */
  readonly environment?: string;
}

/**
 * Places a value at its access path, creating namespaces on the way.
 * Values are placed exactly as the provider holds them: coercion is the
 * schema's job, so a value file's contents stay a string here.
 */
function place(root: Record<string, unknown>, path: readonly string[], value: string): void {
  const leaf = path[path.length - 1];
  if (leaf === undefined) {
    return;
  }

  let node = root;
  for (const key of path.slice(0, -1)) {
    const existing = node[key];
    if (typeof existing === "object" && existing !== null) {
      node = existing as Record<string, unknown>;
      continue;
    }
    const child: Record<string, unknown> = {};
    node[key] = child;
    node = child;
  }
  node[leaf] = value;
}

/**
 * Loads, validates, and returns configuration for the current environment.
 * Eager and synchronous: invalid configuration fails at startup with a
 * parameter-named error rather than later at first use.
 *
 * One deliberate exception to the eagerness: while the CLI is harvesting the
 * `schema` export of `.penv/env.ts` (see `SCHEMA_HARVEST_ENV` in core), the
 * scaffolded module's own `export const env = load(schema)` must not stop the
 * module from evaluating — an empty tree would throw here and take the `schema`
 * export down with it, which is exactly the state `penv fill` exists to fix. In
 * that window `load` returns a lazy stand-in that performs the real load — and
 * raises the same parameter-named error — on first property access. Application
 * runtime never sets the flag, so ordinary loads stay eager and fail-fast.
 */
export function load<T extends z.ZodType>(schema: T, options?: LoadOptions): z.infer<T> {
  if (schemaHarvestActive()) {
    return deferLoad(schema, options);
  }
  return loadEagerly(schema, options);
}

function loadEagerly<T extends z.ZodType>(schema: T, options?: LoadOptions): z.infer<T> {
  const { environment, values } = resolveSync(options?.cwd ?? process.cwd(), options?.environment);

  const object: Record<string, unknown> = {};
  for (const { ref, value } of values) {
    place(object, accessPath(ref), value);
  }

  const result = schema.safeParse(object);
  if (!result.success) {
    throw new ValidationError(
      environment,
      result.error.issues.map((issue) => ({
        parameter: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * `load`'s harvest-time stand-in: nothing is resolved or validated until a
 * property is actually read. The schema module's top level only *binds*
 * `export const env`, so under harvest the binding succeeds, the CLI reads the
 * `schema` export, and the deferred error — if the tree still cannot satisfy the
 * schema — surfaces on first real use with the same `ValidationError` the eager
 * path throws.
 */
function deferLoad<T extends z.ZodType>(schema: T, options?: LoadOptions): z.infer<T> {
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
