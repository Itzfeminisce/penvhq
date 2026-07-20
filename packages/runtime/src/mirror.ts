/**
 * The ambient mirror: writing an environment's resolved values onto
 * `process.env`, so a third-party SDK that reads `process.env.ITS_EXACT_NAME`
 * at module load finds a validated value with no per-SDK bridge code.
 *
 * This is v0.7's *projection* concept delivered into the local process instead
 * of into GitHub Actions: resolved values, under their generated (`override`-bent)
 * variable names, placed where something downstream reads them. It runs only
 * from {@link load} with `{ mirror: true }` — never on a bare import — because a
 * consumer who never asked for `process.env` writes must not get them.
 *
 * Two properties make it safe to hand an SDK, and both come from the schema:
 *
 * - **Validate-first.** {@link load} has already parsed the values against the
 *   schema and thrown a parameter-named error on any failure before this runs,
 *   so the SDK never sees a half-configured surface.
 * - **Exclusive over the schema.** Every parameter the schema *declares* is
 *   penv's to own ambiently: written when it resolves to a value, and **deleted**
 *   when it does not — so a stray ambient `WORKOS_API_HOSTNAME` cannot steer an
 *   SDK behind `@env`'s back. A variable the schema does not declare is left
 *   untouched. The declaration the developer already makes is the whole contract.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { checkNameCollisions, refFromAccessPath, variableName } from "@penvhq/core";
import { toJSONSchema, type z } from "zod";

/** A JSON Schema node, the shape `z.toJSONSchema` emits — only the parts the walk reads. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
}

/**
 * Every parameter the schema declares, present or optional-absent alike —
 * enumerated through `z.toJSONSchema` rather than by poking Zod internals, so it
 * is stable across Zod point releases. A nested object is a namespace and only
 * its leaves are parameters, exactly as penv's access-path model reads the tree:
 * `{ workos: { apiKey } }` is the one parameter `workos/api-key`.
 *
 * A key outside the image of the name transform is skipped rather than guessed —
 * `refFromAccessPath` answers `undefined`, the same honesty `penv fill` keeps for
 * a schema key no value file can reach.
 */
export function declaredRefs(schema: z.ZodType): ParameterRef[] {
  // `unrepresentable: "any"` keeps a schema with a date/bigint/transform from
  // throwing here — those become permissive nodes, still enumerated as leaves.
  const root = toJSONSchema(schema as never, { unrepresentable: "any" }) as JsonSchemaNode;
  const refs: ParameterRef[] = [];
  walk(root, [], refs);
  return refs;
}

function walk(node: JsonSchemaNode, path: readonly string[], out: ParameterRef[]): void {
  // A namespace is an object *with* declared properties. An object with none —
  // an opaque record, a JSON blob — is a leaf, whose value the tree holds as a
  // string like any other.
  if (node.type === "object" && node.properties !== undefined) {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, [...path, key], out);
    }
    return;
  }
  if (path.length === 0) {
    return;
  }
  const ref = refFromAccessPath(path);
  if (ref !== undefined) {
    out.push(ref);
  }
}

/** What a mirror run did, for the caller and for a report. */
export interface MirrorResult {
  /** Variables written from a resolved value. */
  readonly written: number;
  /** Declared-but-unresolved variables deleted from `process.env`. */
  readonly deleted: number;
}

/**
 * Writes the schema's declared parameters onto `target` (`process.env` in
 * production), and deletes the declared ones that did not resolve. The value
 * written is the **raw** string the tree holds — never the schema-coerced value,
 * because `process.env` is strings and the SDK re-parses; a `z.coerce.number()`
 * parameter mirrors the bytes `"5432"`, not the number `5432`.
 *
 * Authoritative over what it declares: a declared variable already present is
 * overwritten, because the schema is the source of truth for the values it
 * names — the opposite of the bare `@penvhq/penv/config` compat path, which
 * never clobbers. That authority is exactly what makes exclusivity mean
 * something.
 */
export function mirror(
  schema: z.ZodType,
  config: PenvConfig,
  values: readonly { readonly ref: ParameterRef; readonly value: string }[],
  target: Record<string, string | undefined> = process.env,
): MirrorResult {
  const declared = declaredRefs(schema);

  // Invariant 12, at the ambient boundary too: two parameters mapping to one
  // variable would write first-wins and drop the other silently. Refuse before
  // touching `target` — a half-mirrored environment is worse than none.
  const collision = checkNameCollisions(declared, config)[0];
  if (collision !== undefined) {
    throw collision;
  }

  const resolved = new Map<string, string>();
  for (const { ref, value } of values) {
    resolved.set(idOf(ref), value);
  }

  let written = 0;
  let deleted = 0;
  for (const ref of declared) {
    const variable = variableName(ref, config);
    const value = resolved.get(idOf(ref));
    if (value !== undefined) {
      target[variable] = value;
      written += 1;
    } else if (variable in target) {
      delete target[variable];
      deleted += 1;
    }
  }
  return { written, deleted };
}

/** A parameter's identity for the resolved-value lookup — the slash path. */
function idOf(ref: ParameterRef): string {
  return [...ref.namespace, ref.name].join("/");
}
