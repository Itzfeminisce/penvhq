/**
 * The name transform. One deterministic mapping connects the three
 * representations of a name, so the common case needs no configuration:
 *
 *   redis/password   (file path)
 *     → redis.password   (schema key / runtime access)
 *     → REDIS_PASSWORD   (generated .env)
 *
 * The transform is one-way by construction: `.env` is flat, so `REDIS_PASSWORD`
 * cannot say whether it came from `redis/password` or `redis-password`.
 * `refFromVariable` therefore never infers a namespace — import creates flat
 * parameters, and namespacing is a deliberate refactor afterwards.
 */

import { NameCollisionError } from "./errors.js";
import { parameterId } from "./grammar.js";
import type { ParameterRef, PenvConfig } from "./types.js";

function slashPath(ref: ParameterRef): string {
  return [...ref.namespace, ref.name].join("/");
}

function camelSegment(segment: string): string {
  const words = segment.split("-").filter((w) => w.length > 0);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) {
        return lower;
      }
      const head = lower.slice(0, 1);
      return `${head.toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

/**
 * The generated `.env` variable for a parameter, before any `override`.
 * Both the namespace separator and the hyphen become an underscore.
 */
export function defaultVariableName(ref: ParameterRef): string {
  return [...ref.namespace, ref.name]
    .map((segment) => segment.replace(/-/g, "_").toUpperCase())
    .join("_");
}

/**
 * The generated `.env` variable for a parameter, honouring `config.override`.
 * An override may be keyed by the dotted parameter id (`redis.password`) or by
 * the slash path (`redis/password`); for a root parameter these coincide.
 */
export function variableName(ref: ParameterRef, config: PenvConfig): string {
  const overrides = config.override as Readonly<Record<string, string>> | undefined;
  if (overrides !== undefined) {
    const byId = overrides[parameterId(ref)];
    if (byId !== undefined) {
      return byId;
    }
    const byPath = overrides[slashPath(ref)];
    if (byPath !== undefined) {
      return byPath;
    }
  }
  return defaultVariableName(ref);
}

/** The runtime access path — `redis/password` → `["redis", "password"]`. */
export function accessPath(ref: ParameterRef): string[] {
  return [...ref.namespace, ref.name].map(camelSegment);
}

function kebabSegment(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Whether a segment is canonical — whether the transform reads it as-is. A
 * segment is canonical exactly when {@link kebabSegment} leaves it unchanged, so
 * `redis`, `database-url` and `database_url` all qualify (the transform touches
 * none of them), while `databaseUrl`, `apiURL` and `API_KEY` do not, because
 * kebabSegment would fold their capitals into a different name. Answered by the
 * real transform rather than a parallel regex, so it cannot drift from what
 * resolution does.
 */
export function isCanonicalSegment(segment: string): boolean {
  return kebabSegment(segment) === segment;
}

/**
 * The parameter a schema key names — `["redis", "password"]` → `redis/password`.
 *
 * Unlike {@link refFromVariable} this may read a namespace, because a schema key
 * arrives as a path: the nesting in `.penv/env.ts` is the structure a flat `.env`
 * does not have.
 *
 * `undefined` when the path is outside the image of {@link accessPath} — `apiURL`
 * kebabs to `api-url`, which camels back to `apiUrl`, so no value file can be
 * named that reaches that key. Answering "I cannot tell" is what keeps the
 * caller from inventing a `penv set` line that writes a file the schema would
 * still not see. Composed from the real transform rather than re-derived, like
 * {@link roundTripsCleanly}, so it cannot drift from what resolution does.
 */
export function refFromAccessPath(path: readonly string[]): ParameterRef | undefined {
  const name = path[path.length - 1];
  if (name === undefined) {
    return undefined;
  }
  const ref: ParameterRef = {
    namespace: path.slice(0, -1).map(kebabSegment),
    name: kebabSegment(name),
  };
  if ([...ref.namespace, ref.name].some((segment) => segment.length === 0)) {
    return undefined;
  }
  const round = accessPath(ref);
  return round.length === path.length && round.every((segment, i) => segment === path[i])
    ? ref
    : undefined;
}

/**
 * The flat parameter a generated variable came from. No namespace is inferred:
 * a flat `.env` carries no structure to read, and structure is never guessed.
 */
export function refFromVariable(variable: string): ParameterRef {
  return { namespace: [], name: variable.replace(/_/g, "-").toLowerCase() };
}

/**
 * Whether a `.env` variable survives import and regeneration unchanged — that
 * is, whether `refFromVariable` is genuinely invertible for this key.
 *
 * The `.env` grammar admits keys the transform cannot reproduce: `MY-VAR` and
 * `lowerKey` both import to a parameter that regenerates as `MY_VAR` and
 * `LOWERKEY`, so the application's `process.env["MY-VAR"]` would read
 * `undefined` after a round trip. A flat `.env` cannot distinguish `MY-VAR`
 * from `MY_VAR` once both collapse to the same parameter, so no escape scheme
 * can rescue them — the honest answer is to detect them and let the caller
 * refuse or demand an explicit `override` entry.
 *
 * Composed from the real transform rather than re-derived as a regex, so it
 * cannot drift from what import and generate actually do.
 */
export function roundTripsCleanly(variable: string): boolean {
  return defaultVariableName(refFromVariable(variable)) === variable;
}

/**
 * Every parameter pair that maps to the same generated variable. Collected
 * rather than thrown so `penv validate` reports all of them in one pass, and
 * ordered so the report is identical on every machine.
 */
export function checkNameCollisions(
  refs: readonly ParameterRef[],
  config: PenvConfig,
): NameCollisionError[] {
  const byVariable = new Map<string, string[]>();
  for (const ref of refs) {
    const variable = variableName(ref, config);
    const parameters = byVariable.get(variable);
    if (parameters === undefined) {
      byVariable.set(variable, [parameterId(ref)]);
    } else {
      parameters.push(parameterId(ref));
    }
  }

  const errors: NameCollisionError[] = [];
  for (const variable of [...byVariable.keys()].sort()) {
    const parameters = byVariable.get(variable);
    if (parameters === undefined || parameters.length < 2) {
      continue;
    }
    errors.push(new NameCollisionError(variable, [...parameters].sort()));
  }
  return errors;
}
