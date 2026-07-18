/**
 * penv's rotation clock, as pure functions over per-environment meta.
 *
 * Rotation phase is meta, never a value-filename suffix (RFC: "Rotation state
 * lives in meta and the provider, never in filenames"). Every field below rides
 * the {@link MetaBlock} open passthrough — none is a declared key — so an older
 * penv round-trips them untouched, and effective phase for one environment is
 * read exactly the way every other policy field is: {@link effectiveMeta}, base
 * merged with that environment's block.
 *
 * The two clocks stay separate on purpose. `lastRotated` is when a rotation last
 * *completed*; `rotatingSince` is when the *current* one started. The overdue
 * check reads the first, the stuck check the second — collapsing them into one
 * timestamp breaks stuck detection, because a completed rotation and an
 * in-flight one would become indistinguishable. And stuck detection is gated to
 * `dual-valid`: an `atomic-cutover` password overlaps only at the infra layer,
 * so a long-lived `rotatingSince` on one is not a stuck penv-layer grace window
 * and must never be flagged as one.
 *
 * Every function that consults the wall clock takes `now` as a parameter — never
 * reads it internally — so the boundary conditions the roadmap names (overdue
 * exactly at the policy, stuck exactly at the threshold) are testable without
 * mocking time.
 */

import { PenvError } from "./errors.js";
import { effectiveMeta } from "./meta.js";
import type { Meta, MetaBlock } from "./types.js";

/** How a parameter rotates. The two are distinct mechanisms, never one code path. */
export type RotationMechanism = "dual-valid" | "atomic-cutover";

/** Where a parameter sits in the `active → rotating → active` cycle. Defaults `active`. */
export type RotationState = "active" | "rotating";

/** The meta keys rotation reads and writes. Named constants, not string literals sprinkled about. */
export const ROTATION_MECHANISM_KEY = "rotationMechanism";
export const ROTATION_POLICY_KEY = "rotationPolicy";
export const ROTATION_STATE_KEY = "rotationState";
export const ROTATING_SINCE_KEY = "rotatingSince";
export const LAST_ROTATED_KEY = "lastRotated";

/**
 * A parameter's rotation phase for one environment, every field resolved to a
 * usable value. `state` defaults `active`; the two clocks default `null`, the
 * same shape they take when a rotation has never run — a distinction meta does
 * not encode and callers do not need.
 */
export interface Rotation {
  readonly mechanism: RotationMechanism | undefined;
  /** The rotation interval, verbatim as written (`"90d"`); parse it with {@link parseDuration}. */
  readonly policy: string | undefined;
  readonly state: RotationState;
  /** When the current rotation started, ISO 8601. Only set while `state === "rotating"`. */
  readonly rotatingSince: string | null;
  /** When a rotation last completed, ISO 8601. */
  readonly lastRotated: string | null;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a duration spec — `"90d"`, `"24h"`, `"30m"`, `"45s"` — to milliseconds.
 *
 * One integer and one unit, nothing else: no compound `"1h30m"`, no fractions,
 * no bare number. A spec penv cannot parse is a policy that would silently never
 * fire, so it is a loud `PenvError` rather than a `NaN` that makes every overdue
 * check quietly false.
 */
export function parseDuration(spec: string): number {
  const match = /^(\d+)([smhd])$/.exec(spec.trim());
  const unit = match?.[2];
  const count = match?.[1];
  if (match === null || unit === undefined || count === undefined) {
    throw new PenvError(
      "ROTATION_POLICY",
      `Rotation policy \`${spec}\` is not a duration penv can parse`,
      "Write one integer and one unit — `s`, `m`, `h`, or `d` — with nothing between them: " +
        "`90d`, `24h`, `30m`, `45s`. Compound durations like `1h30m` and fractions are not supported.",
    );
  }
  const ms = UNIT_MS[unit];
  // Every branch of the regex's unit class has an entry, so this is total; the
  // guard is what `noUncheckedIndexedAccess` requires, not a real reachable path.
  if (ms === undefined) {
    throw new PenvError(
      "ROTATION_POLICY",
      `Rotation policy \`${spec}\` uses an unknown unit`,
      "Use one of `s`, `m`, `h`, or `d`.",
    );
  }
  return Number(count) * ms;
}

/**
 * The non-throwing twin of {@link parseDuration}: the interval in milliseconds,
 * or `undefined` for a spec penv cannot parse.
 *
 * `parseDuration` keeps its loud contract for the writers — `set` and `rotate`
 * would rather refuse than record a policy that silently never fires. But a
 * *reader* that sweeps every parameter's policy in one loop, `doctor` chief among
 * them, cannot let one unparseable field throw: a single bad `rotationPolicy`
 * (`1h30m`, `3 months`) would abort the whole run and blind every other check.
 * This lets that reader turn a bad policy into one finding and carry on, without
 * duplicating the parse rules or weakening the writers' guarantee.
 */
export function tryParseDuration(spec: string): number | undefined {
  try {
    return parseDuration(spec);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A clock field: a string timestamp, else `null`. `null` and absent are one state here. */
function asClock(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asMechanism(value: unknown): RotationMechanism | undefined {
  return value === "dual-valid" || value === "atomic-cutover" ? value : undefined;
}

function asState(value: unknown): RotationState {
  return value === "rotating" ? "rotating" : "active";
}

/**
 * The rotation phase in force for one parameter in one environment, read through
 * the same base-plus-environment merge every policy field uses. An environment
 * with no block inherits the base; an absent field takes its default.
 */
export function rotationOf(meta: Meta | undefined, environment: string): Rotation {
  const block = effectiveMeta(meta, environment);
  return {
    mechanism: asMechanism(block[ROTATION_MECHANISM_KEY]),
    policy: asString(block[ROTATION_POLICY_KEY]),
    state: asState(block[ROTATION_STATE_KEY]),
    rotatingSince: asClock(block[ROTATING_SINCE_KEY]),
    lastRotated: asClock(block[LAST_ROTATED_KEY]),
  };
}

/**
 * Whether a parameter is past due for rotation: a policy and a completed
 * rotation both exist, and more than the policy's interval has elapsed since.
 *
 * No policy or no `lastRotated` means not overdue — a parameter that declares no
 * interval, or has never rotated, is not late, it simply is not on a clock.
 * Exactly at the interval is not yet overdue; strictly past it is.
 */
export function isOverdue(meta: Meta | undefined, environment: string, now: Date): boolean {
  const { policy, lastRotated } = rotationOf(meta, environment);
  if (policy === undefined || lastRotated === null) return false;

  const last = Date.parse(lastRotated);
  if (Number.isNaN(last)) return false;

  return now.getTime() - last > parseDuration(policy);
}

/**
 * Whether a `dual-valid` rotation has been in flight too long — the grace window
 * that opened and never closed.
 *
 * Gated to `dual-valid` and nothing else. An `atomic-cutover` parameter overlaps
 * only at the infra layer, holds no penv-layer grace window, and a long-lived
 * `rotatingSince` on one is not stuck — flagging it would be the false positive
 * the RFC and roadmap both single out. Requires `state === "rotating"` and a
 * `rotatingSince` clock; exactly at the threshold is not yet stuck.
 */
export function isStuck(
  meta: Meta | undefined,
  environment: string,
  now: Date,
  stuckThresholdMs: number,
): boolean {
  const { mechanism, state, rotatingSince } = rotationOf(meta, environment);
  if (mechanism !== "dual-valid") return false;
  if (state !== "rotating") return false;
  if (rotatingSince === null) return false;

  const since = Date.parse(rotatingSince);
  if (Number.isNaN(since)) return false;

  return now.getTime() - since > stuckThresholdMs;
}

/**
 * Sets one environment's block into the `rotating` phase, stamping `rotatingSince`
 * — the start of the current rotation's grace window.
 *
 * Returns a new immutable {@link Meta}: every other environment, the base block,
 * and every unknown key pass through untouched. Mirrors `push`'s
 * `withLastPushed` — the same shallow-clone-per-level pattern, because a
 * rotation that mutated the meta it was handed would corrupt the record it is
 * mid-way through updating.
 */
export function beginRotation(meta: Meta | undefined, environment: string, nowIso: string): Meta {
  const base: Meta = meta ?? {};
  const environments: Record<string, MetaBlock> = { ...(base.environments ?? {}) };
  environments[environment] = {
    ...(environments[environment] ?? {}),
    [ROTATION_STATE_KEY]: "rotating",
    [ROTATING_SINCE_KEY]: nowIso,
  };
  return { ...base, environments };
}

/**
 * Returns one environment's block to `active`, closes the grace window
 * (`rotatingSince: null`), and records the completion time in `lastRotated`.
 *
 * The clock swap is the point: `rotatingSince` is cleared because no rotation is
 * in flight, `lastRotated` is set because one just finished — the two clocks
 * measuring the two different things the stuck and overdue checks read. Same
 * immutability contract as {@link beginRotation}.
 */
export function completeRotation(
  meta: Meta | undefined,
  environment: string,
  nowIso: string,
): Meta {
  const base: Meta = meta ?? {};
  const environments: Record<string, MetaBlock> = { ...(base.environments ?? {}) };
  environments[environment] = {
    ...(environments[environment] ?? {}),
    [ROTATION_STATE_KEY]: "active",
    [ROTATING_SINCE_KEY]: null,
    [LAST_ROTATED_KEY]: nowIso,
  };
  return { ...base, environments };
}
