/**
 * The runtime loader. `load` is generic and returns `z.infer<T>` — the type the
 * caller's own schema describes, never a widened one. The inferred type is only
 * true because the same schema validates the values before they are returned,
 * so the type you code against and the value you receive cannot diverge.
 */

import { accessPath, ValidationError } from "@penvhq/core";
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
 */
export function load<T extends z.ZodType>(schema: T, options?: LoadOptions): z.infer<T> {
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
