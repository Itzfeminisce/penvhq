/**
 * The draft schema penv writes when it adopts a dotenv file.
 *
 * It is a draft and says so in the file it lands in: single-sample inference
 * cannot know that a boolean seen as `true` must also accept `1`, or that a
 * string is really a URL. penv scaffolds `penv.schema.ts` once and never
 * regenerates it (invariant 2), so every correction the reader makes is safe.
 *
 * Requiredness across several files is the one judgement here, and it is
 * deliberately coarse: a field observed in every adopted environment starts
 * required, and a field missing from any of them starts optional. That is not
 * per-environment requiredness — there is one schema, never one per environment
 * (invariant 1) — it is the weakest shape that every adopted environment
 * satisfies, which is what makes the first `penv run` after a cutover pass with
 * no edits.
 */

import type { DotenvEntry } from "@penvhq/core";
import { accessPath, refFromVariable } from "@penvhq/core";

/** One schema field, rendered into `penv.schema.ts` as `<key>: <type>,`. */
export interface SchemaField {
  readonly key: string;
  /** The Zod expression, e.g. `z.url()` — `.optional()` already applied when it belongs. */
  readonly type: string;
}

/** A drafted field, plus the verdict a report prints. */
export interface DraftField extends SchemaField {
  readonly required: boolean;
}

/** A URL of any scheme — `postgres://` is as much a URL as `https://`. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The Zod expression for one sampled value. Values arrive as strings, so a
 * schema that must accept them declares the coercion: `z.boolean()` would reject
 * the string `"true"` this very file just imported.
 */
export function inferType(value: string): string {
  if (URL_LIKE.test(value)) {
    return "z.url()";
  }
  if (/^(true|false)$/i.test(value)) {
    return "z.stringbool()";
  }
  if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return "z.coerce.number()";
  }
  return "z.string()";
}

/** The schema key one variable becomes, quoted only when it has to be. */
function keyFor(variable: string): string {
  const key = accessPath(refFromVariable(variable)).join(".");
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** Sorted, so the draft is identical on every machine. */
function byKey<T extends SchemaField>(fields: T[]): T[] {
  return fields.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One file's variables as schema fields, all required — `penv import`'s single source. */
export function draftFields(entries: readonly DotenvEntry[]): SchemaField[] {
  return byKey(entries.map((entry) => ({ key: keyFor(entry.key), type: inferType(entry.value) })));
}

/**
 * One adopted file, and which environment its values reach. `environment` is
 * absent for the two unscoped scopes (`.env`, `.env.local`), whose values serve
 * every environment.
 */
export interface DraftSource {
  readonly environment?: string;
  readonly entries: readonly DotenvEntry[];
}

interface Observed {
  readonly types: Set<string>;
  readonly environments: Set<string>;
  /** True when an unscoped file carries this variable, so every environment has it. */
  everywhere: boolean;
}

/**
 * The draft for a whole cutover: every variable any adopted file declares, typed
 * from what was seen and required only where every adopted environment has it.
 *
 * Two files disagreeing about a variable's type (`true` here, `8080` there)
 * collapse to `z.string()` rather than to whichever file was read first — a
 * drafted type that rejects a value the project already had would fail the first
 * run, which is the one thing this draft exists to avoid.
 */
export function draftFieldsAcross(
  sources: readonly DraftSource[],
  environments: readonly string[],
): DraftField[] {
  const observed = new Map<string, Observed>();
  for (const source of sources) {
    for (const entry of source.entries) {
      const seen = observed.get(entry.key) ?? {
        types: new Set<string>(),
        environments: new Set<string>(),
        everywhere: false,
      };
      seen.types.add(inferType(entry.value));
      if (source.environment === undefined) {
        seen.everywhere = true;
      } else {
        seen.environments.add(source.environment);
      }
      observed.set(entry.key, seen);
    }
  }

  const fields: DraftField[] = [];
  for (const [variable, seen] of observed) {
    const required = seen.everywhere || environments.every((name) => seen.environments.has(name));
    const type = (seen.types.size === 1 ? [...seen.types][0] : undefined) ?? "z.string()";
    fields.push({ key: keyFor(variable), type: required ? type : `${type}.optional()`, required });
  }
  return byKey(fields);
}
