/**
 * Injecting an environment's resolved values into `process.env`, so a
 * third-party SDK that reads `process.env.ITS_EXACT_NAME` at module load finds a
 * validated value with no per-SDK bridge code.
 *
 * This is v0.7's *projection* concept delivered into the local process instead
 * of into GitHub Actions: resolved values, under their generated (`override`-bent)
 * variable names, placed where something downstream reads them. It runs only
 * from {@link load} with `{ inject: true }` — never on a bare import — because a
 * consumer who never asked for `process.env` writes must not get them.
 *
 * Two properties make it safe to hand an SDK, and both come from the schema:
 *
 * - **Validate-first.** {@link load} has already parsed the values against the
 *   schema and thrown a parameter-named error on any failure before this runs,
 *   so the SDK never sees a half-configured surface.
 * - **Exclusive over the schema.** Every parameter the schema *declares* is
 *   penv's to own ambiently: written when it has a value (a tree value, or a
 *   schema `.default()`), and **deleted** when it does not — so a stray ambient
 *   `WORKOS_API_HOSTNAME` cannot steer an SDK behind `@env`'s back. A variable
 *   the schema does not declare is left untouched. The declaration the developer
 *   already makes is the whole contract.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import {
  accessPath,
  checkNameCollisions,
  parameterId,
  refFromAccessPath,
  variableName,
} from "@penvhq/core";
import { toJSONSchema, type z } from "zod";

/** A JSON Schema node, the shape `z.toJSONSchema` emits — only the parts the walk reads. */
interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  /** Union (`z.union`), discriminated union, and nullable emit their branches here. */
  readonly anyOf?: readonly JsonSchemaNode[];
  /** Some emitters use `oneOf` for a discriminated union. */
  readonly oneOf?: readonly JsonSchemaNode[];
  /** Intersection (`z.intersection`, `.and`) emits its members here. */
  readonly allOf?: readonly JsonSchemaNode[];
}

/**
 * Every parameter the schema declares, present or optional-absent alike —
 * enumerated through `z.toJSONSchema` rather than by poking Zod internals, so it
 * is stable across Zod point releases. A nested object is a namespace and only
 * its leaves are parameters, exactly as penv's access-path model reads the tree:
 * `{ workos: { apiKey } }` is the one parameter `workos/api-key`.
 *
 * A union or intersection at a namespace position contributes **every** field
 * any branch could declare — penv must be able to delete a stray ambient value
 * for a branch that did not resolve, so exclusivity has to own the whole set.
 * Deduped by id, because a discriminated union repeats its discriminator and any
 * shared fields across branches.
 *
 * A key outside the image of the name transform is skipped rather than guessed —
 * `refFromAccessPath` answers `undefined`, the same honesty `penv fill` keeps for
 * a schema key no value file can reach.
 */
export function declaredRefs(schema: z.ZodType): ParameterRef[] {
  // `unrepresentable: "any"` keeps a schema with a date/bigint/transform from
  // throwing here — those become permissive leaf nodes, still enumerated.
  const root = toJSONSchema(schema as never, { unrepresentable: "any" }) as JsonSchemaNode;
  const byId = new Map<string, ParameterRef>();
  walk(root, [], byId);
  return [...byId.values()];
}

function walk(node: JsonSchemaNode, path: readonly string[], out: Map<string, ParameterRef>): void {
  // A namespace is an object *with* declared properties. An object with none —
  // an opaque record, a JSON blob — falls through to a leaf, whose value the tree
  // holds as a string like any other.
  if (node.properties !== undefined) {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, [...path, key], out);
    }
    return;
  }
  // A union / discriminated union / intersection / nullable contributes the
  // parameters of every branch at this same path — not a single phantom leaf.
  const branches = node.anyOf ?? node.oneOf ?? node.allOf;
  if (branches !== undefined) {
    for (const branch of branches) {
      walk(branch, path, out);
    }
    return;
  }
  // A null-only branch (from `.nullable()`) declares no parameter of its own.
  if (node.type === "null") {
    return;
  }
  if (path.length === 0) {
    return;
  }
  const ref = refFromAccessPath(path);
  if (ref !== undefined) {
    out.set(parameterId(ref), ref);
  }
}

/** What an inject run did, for the caller and for a report. */
export interface InjectResult {
  /** Variables written from a resolved value or a schema default. */
  readonly written: number;
  /** Declared-but-valueless variables deleted from `process.env`. */
  readonly deleted: number;
}

/** What {@link inject} needs — an options object, because there are several inputs and more may come. */
export interface InjectInput {
  readonly schema: z.ZodType;
  readonly config: PenvConfig;
  /** The raw tree values, exactly as the provider holds them — strings, never coerced. */
  readonly values: readonly { readonly ref: ParameterRef; readonly value: string }[];
  /**
   * The schema-validated object ({@link load}'s return). Consulted only for a
   * declared parameter the tree did not resolve, so a `.default()` reaches
   * `process.env` instead of being deleted. A tree-resolved parameter always
   * uses its raw string from `values`, never this coerced value.
   */
  readonly validated?: unknown;
  /** The target to write. Defaults to `process.env`. */
  readonly target?: Record<string, string | undefined>;
}

/**
 * Injects the schema's declared parameters into the target (`process.env` in
 * production), and deletes the declared ones that have no value at all. A
 * parameter's value is, in order: its **raw** string from the tree (never the
 * schema-coerced value — `process.env` is strings and the SDK re-parses, so a
 * `z.coerce.number()` parameter injects the bytes `"5432"`, not `5432`); else
 * its schema `.default()`, stringified; else it is deleted.
 *
 * Authoritative over what it declares: a declared variable already present is
 * overwritten, because the schema is the source of truth for the values it
 * names — the opposite of the bare `@penvhq/penv/config` compat path, which
 * never clobbers. That authority is exactly what makes exclusivity mean
 * something.
 */
export function inject(input: InjectInput): InjectResult {
  const { schema, config, values, validated } = input;
  const target = input.target ?? process.env;
  const declared = declaredRefs(schema);

  // Invariant 12, at the ambient boundary too: two parameters mapping to one
  // variable would write first-wins and drop the other silently. Refuse before
  // touching the target — a half-injected environment is worse than none.
  const collision = checkNameCollisions(declared, config)[0];
  if (collision !== undefined) {
    throw collision;
  }

  const rawById = new Map<string, string>();
  for (const { ref, value } of values) {
    rawById.set(parameterId(ref), value);
  }

  let written = 0;
  let deleted = 0;
  for (const ref of declared) {
    const variable = variableName(ref, config);

    const raw = rawById.get(parameterId(ref));
    if (raw !== undefined) {
      target[variable] = raw;
      written += 1;
      continue;
    }

    // No tree value — but the schema may default it, in which case it has a value
    // and must be injected, not deleted. The default lives in the validated object.
    const defaulted = validated === undefined ? undefined : valueAt(validated, accessPath(ref));
    if (defaulted !== undefined) {
      target[variable] = toEnvString(defaulted);
      written += 1;
      continue;
    }

    if (variable in target) {
      delete target[variable];
      deleted += 1;
    }
  }
  return { written, deleted };
}

/** Reads a nested value by its camelCase access path, or `undefined` if any segment is absent. */
function valueAt(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** A default's `process.env` form: a string stays itself, an object becomes JSON, else `String`. */
function toEnvString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
