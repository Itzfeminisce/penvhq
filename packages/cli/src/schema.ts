/**
 * Reading the user's schema, and the distance between it and the parameter tree.
 *
 * `.penv/env.ts` declares what must exist and the tree holds what does. The gap
 * between them is the signal `penv validate` exists to raise; this module makes
 * it legible without closing it. Nothing here writes or deletes a value file —
 * a declaration has no value, so materialising one could only invent it, and an
 * invented value is the silent-value-reaching-runtime failure penv exists to
 * delete. `penv set` stays the only writer.
 *
 * The introspection below lives here, not in `doctor`, because `doctor` and
 * `watch` both report drift and two readers of the same schema would be two
 * answers to one question.
 *
 * Every helper answers "I cannot tell" rather than guessing. A report is only
 * worth reading if every line in it is true, so a field this module cannot
 * understand produces no line at all.
 */

import type { ParameterRef, PenvConfig, Resolution } from "@penvhq/core";
import {
  accessPath,
  isReservedToken,
  parameterId,
  refFromAccessPath,
  variableName,
} from "@penvhq/core";
import type { z } from "zod";

function defOf(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const def = (node as { def?: unknown }).def;
  return typeof def === "object" && def !== null ? (def as Record<string, unknown>) : undefined;
}

export function typeOf(node: unknown): string | undefined {
  const type = defOf(node)?.type;
  return typeof type === "string" ? type : undefined;
}

/** Peels `.optional()`, `.default()`, `.nullable()` — wrappers, not shapes. */
export function unwrap(node: unknown): unknown {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = defOf(current)?.innerType;
    if (inner === undefined) {
      return current;
    }
    current = inner;
  }
  return current;
}

export function shapeOf(node: unknown): Record<string, unknown> | undefined {
  if (typeOf(node) !== "object") {
    return undefined;
  }
  const shape = (node as { shape?: unknown }).shape;
  return typeof shape === "object" && shape !== null
    ? (shape as Record<string, unknown>)
    : undefined;
}

export type Lookup =
  | { readonly kind: "found"; readonly node: unknown }
  | { readonly kind: "absent" }
  /** The schema is not introspectable this far down. Every check skips it. */
  | { readonly kind: "unknown" };

export function lookup(root: z.ZodType, path: readonly string[]): Lookup {
  let node: unknown = unwrap(root);
  for (const key of path) {
    const shape = shapeOf(node);
    if (shape === undefined) {
      return { kind: "unknown" };
    }
    if (!Object.hasOwn(shape, key)) {
      return { kind: "absent" };
    }
    node = unwrap(shape[key]);
  }
  return { kind: "found", node };
}

/** The declared minimum length, when the field is a string that declares one. */
export function minLengthOf(node: unknown): number | undefined {
  if (typeOf(node) !== "string") {
    return undefined;
  }
  const min = (node as { minLength?: unknown }).minLength;
  return typeof min === "number" ? min : undefined;
}

/**
 * Wrappers that make an absent key legal: the schema itself says this parameter
 * need not have a value, so its absence is a declaration, not drift.
 */
const ABSENCE_PERMITTED = new Set(["optional", "default", "catch", "prefault"]);

/**
 * Wrappers that still demand the key be present. `z.string().nullable()` accepts
 * `null`, which no value file can produce — a missing file is `undefined`, and
 * `undefined` is what the schema rejects. So a nullable field with no value is
 * drift exactly as a bare one is.
 */
const ABSENCE_REFUSED = new Set(["nullable", "nonoptional", "readonly"]);

/**
 * Whether the schema permits this field to have no value at all.
 * `undefined` when a wrapper is not recognised — see the module note.
 */
function permitsAbsence(node: unknown): boolean | undefined {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    const type = typeOf(current);
    if (type !== undefined && ABSENCE_PERMITTED.has(type)) {
      return true;
    }
    const inner = defOf(current)?.innerType;
    if (inner === undefined) {
      // A plain type, wrapped in nothing that excuses absence.
      return type === undefined ? undefined : false;
    }
    if (type === undefined || !ABSENCE_REFUSED.has(type)) {
      // A wrapper this module has never heard of. It may or may not excuse
      // absence, and guessing either way puts an untrue line in the report.
      return undefined;
    }
    current = inner;
  }
  return undefined;
}

/** One schema key that takes a value: the leaf of a path through the object shapes. */
interface Leaf {
  readonly path: readonly string[];
  /** False only when this key, and every namespace above it, must be present. */
  readonly absencePermitted: boolean | undefined;
  /** The schema node as declared, wrappers intact, so a `.default()` stays readable. */
  readonly node: unknown;
}

/**
 * Every leaf the schema declares. An object is a namespace and is descended
 * into; anything else is a value. A branch whose shape cannot be read is left
 * alone rather than reported as a leaf — an unreadable object is not a string.
 *
 * Absence permission is inherited, because it is inherited in fact: under
 * `z.object({ ... }).optional()` the whole namespace may be absent, so every
 * value beneath it may be too, and a leaf judged on its own wrapper would be
 * reported as drift while the schema is perfectly happy without it.
 */
function leaves(
  node: unknown,
  path: readonly string[],
  inherited: boolean | undefined,
  out: Leaf[],
): void {
  // `undefined` — a wrapper this module does not understand — is inherited as
  // "cannot tell" rather than collapsing to false, so an unreadable namespace
  // never makes its children look required.
  const own = permitsAbsence(node);
  const absencePermitted = inherited === true || own === true ? true : combine(inherited, own);

  const shape = shapeOf(unwrap(node));
  if (shape === undefined) {
    if (path.length > 0) {
      out.push({ path, absencePermitted, node });
    }
    return;
  }
  for (const key of Object.keys(shape)) {
    leaves(shape[key], [...path, key], absencePermitted, out);
  }
}

/** False only when both answers are a definite false; unknown is contagious. */
function combine(left: boolean | undefined, right: boolean | undefined): boolean | undefined {
  return left === undefined || right === undefined ? undefined : false;
}

export function declaredLeaves(schema: z.ZodType): Leaf[] {
  const out: Leaf[] = [];
  leaves(schema, [], false, out);
  return out;
}

/**
 * The declared default of a leaf, rendered for a prompt, when the leaf's wrapper
 * chain carries one this module can read and display. Only a value a reader can
 * take in at a glance is rendered — a string, a number, a boolean — because the
 * display's one job is telling the user what Enter keeps, and `[object Object]`
 * tells them nothing. A factory default is invoked to be shown; one that throws
 * is a default this module cannot know, so no value is claimed (see the module
 * note: no line is better than an untrue line).
 */
export function defaultValueOf(node: unknown): string | undefined {
  let current = node;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = defOf(current);
    if (def === undefined) {
      return undefined;
    }
    if (typeOf(current) === "default" || typeOf(current) === "prefault") {
      let value = def.defaultValue;
      if (typeof value === "function") {
        try {
          value = (value as () => unknown)();
        } catch {
          return undefined;
        }
      }
      if (typeof value === "string") {
        return JSON.stringify(value);
      }
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
      }
      return undefined;
    }
    const inner = def.innerType;
    if (inner === undefined) {
      return undefined;
    }
    current = inner;
  }
  return undefined;
}

/** A parameter `.penv/env.ts` declares that the tree has no value for. */
export interface DeclaredDrift {
  /** The parameter id, or the dotted schema path when no filename could reach it. */
  readonly subject: string;
  /** Absent when no filename reaches this key, which is drift `penv set` cannot close. */
  readonly ref?: ParameterRef;
  /** The line to paste: the `penv set` that closes this, or the rename that must precede it. */
  readonly remedy: string;
  readonly detail: string;
}

/** A parameter the tree holds a value for that `.penv/env.ts` does not declare. */
export interface UndeclaredDrift {
  readonly ref: ParameterRef;
  /** The generated variable, which is the name the application would have read. */
  readonly variable: string;
}

/**
 * A parameter the schema declares but does not require — `.optional()`,
 * `.default()`, and their kin — that the tree has no value for. Not drift in the
 * verdict sense: absence here is a state the schema itself blessed, so `doctor`
 * and `watch` say nothing about it. It is measured for `fill`, whose reader is
 * deciding what to write, and for whom "the schema would take an override here"
 * is exactly the kind of fact a silent skip would hide.
 */
export interface OptionalDrift {
  /** The parameter id, or the dotted schema path when no filename could reach it. */
  readonly subject: string;
  /** Absent when no filename reaches this key — an override `penv set` cannot write. */
  readonly ref?: ParameterRef;
  /** What the schema falls back to, rendered for display, when it declares one this module can read. */
  readonly defaultValue?: string;
  /** The rename that must precede any override, for the key no filename reaches. */
  readonly remedy: string;
}

/**
 * The distance between `.penv/env.ts` and the tree, in both directions. Named
 * `declared`/`undeclared` for the side that has it, not for a verdict: neither
 * direction is by itself an error, and only `validate` decides that. `optional`
 * is the deliberately verdict-free third list — see {@link OptionalDrift}.
 */
export interface DriftReport {
  readonly declared: readonly DeclaredDrift[];
  readonly undeclared: readonly UndeclaredDrift[];
  readonly optional: readonly OptionalDrift[];
}

export const EMPTY_DRIFT: DriftReport = { declared: [], undeclared: [], optional: [] };

export interface DriftInput {
  readonly schema: z.ZodType;
  /** Every parameter the tree holds, resolved for `environment`. */
  readonly resolutions: readonly Resolution[];
  readonly config: PenvConfig;
  readonly environment: string;
}

/**
 * A parameter has a value for this environment when *some* file wins, not when
 * penv can read it: an `.enc` winner is a value that exists, and reporting it as
 * missing would send the user to `penv set` to overwrite a secret they have.
 */
function hasValue(resolution: Resolution): boolean {
  return resolution.winner !== undefined;
}

export function computeDrift(input: DriftInput): DriftReport {
  const { schema, resolutions, config, environment } = input;

  const valued = new Set(resolutions.filter(hasValue).map((resolution) => resolution.parameter));

  const declared: DeclaredDrift[] = [];
  const optional: OptionalDrift[] = [];
  for (const leaf of declaredLeaves(schema)) {
    // "Cannot tell" produces no line at all — see the module note. Only a leaf
    // the schema definitely requires is drift, and only one it definitely
    // excuses is an optional override; a wrapper this module has never heard of
    // is neither.
    if (leaf.absencePermitted === undefined) {
      continue;
    }
    const path = leaf.path.join(".");
    const ref = refFromAccessPath(leaf.path);
    const renameRemedy =
      `Rename the \`${path}\` key in .penv/env.ts — a parameter name is lower-case, ` +
      `hyphenated, and never a reserved token, so no value file reaches this key.`;
    // Declared, and permanently unreachable — two ways, one consequence. Either
    // the key is outside the name transform's image (`apiURL`), or it spells a
    // reserved token, which the filename grammar refuses as a parameter name
    // (invariant 11). No value file resolves to this key either way, so the
    // remedy is a rename: a `penv set` line here would be a command that errors.
    // An optional key is not excused from this: the schema's default will serve,
    // but the override the wrapper promises is one no file can ever deliver.
    if (ref === undefined || isReservedToken(ref.name, config)) {
      if (leaf.absencePermitted) {
        optional.push({ subject: path, remedy: renameRemedy });
      } else {
        declared.push({
          subject: path,
          remedy: renameRemedy,
          detail: "declared, no filename reaches it",
        });
      }
      continue;
    }
    if (valued.has(parameterId(ref))) {
      continue;
    }
    if (leaf.absencePermitted) {
      const defaultValue = defaultValueOf(leaf.node);
      optional.push({
        subject: parameterId(ref),
        ref,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        remedy: `penv set ${[...ref.namespace, ref.name].join("/")} --env ${environment}`,
      });
      continue;
    }
    declared.push({
      subject: parameterId(ref),
      ref,
      remedy: `penv set ${[...ref.namespace, ref.name].join("/")} --env ${environment}`,
      detail: `declared in .penv/env.ts, no value for ${environment}`,
    });
  }

  const undeclared: UndeclaredDrift[] = [];
  for (const resolution of resolutions) {
    if (lookup(schema, accessPath(resolution.ref)).kind !== "absent") {
      continue;
    }
    undeclared.push({
      ref: resolution.ref,
      variable: variableName(resolution.ref, config),
    });
  }

  return { declared, undeclared, optional };
}
