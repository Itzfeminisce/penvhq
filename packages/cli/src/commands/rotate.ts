/**
 * `penv rotate <key>` — turn one parameter over to a new value, by the mechanism
 * its meta declares, against the environment's source-of-truth provider.
 *
 * The two mechanisms are two different physics, never one code path with a flag
 * (rotation.ts says as much). `dual-valid` is a *window*: the new value goes live
 * while the provider still serves the old one, both credentials valid at once,
 * and the window closes only when every reader has moved over. `atomic-cutover`
 * is an *instant*: one flip, old value gone the moment the new one lands, no
 * overlap to hold open. So the command shape mirrors the physics —
 *
 *  - `--begin` / `--complete` bracket a `dual-valid` window (`active → rotating →
 *    active`), and demand a {@link RetainingProvider}, because a window whose old
 *    value the provider does not retain is not a window at all — the overlap the
 *    mechanism promises would silently not exist. penv refuses that up front
 *    rather than opening a grace window that is a fiction.
 *  - a bare `penv rotate` is the `atomic-cutover` flip: write the new value and
 *    stamp the completion in one step, never touching `rotatingSince`, never
 *    requiring retention — there is no penv-layer overlap to record or to lean on.
 *
 * Like `push`, the real work is an exported plain function returning a structured
 * result, and `now` is injectable so the meta clocks are testable without mocking
 * time. The rotation clock itself lives in core (`beginRotation` /
 * `completeRotation`); this command only decides *which* to apply, writes the
 * value at the right moment relative to it, and persists both to the provider.
 */

import type {
  Meta,
  ParameterRef,
  Provider,
  RetainingProvider,
  RotationMechanism,
  RotationState,
  ValueFile,
} from "@penvhq/core";
import {
  beginRotation,
  completeRotation,
  PenvError,
  retainsPrevious,
  rotationOf,
} from "@penvhq/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import { openProject, refFromKey, sourceProviderFor, targetEnvironment } from "../project.js";
import { LOCAL_TREE_TYPE } from "../registry.js";
import { CHECK, formatRows, guard, write } from "../ui.js";
import { readStdin, sealAwareWrite } from "./set.js";

export interface RotateOptions {
  readonly cwd: string;
  readonly key: string;
  readonly environment?: string;
  /** Open a `dual-valid` window: write the new value while the old is still retained. */
  readonly begin?: boolean;
  /** Close a `dual-valid` window: return to `active`, stamp the completion. */
  readonly complete?: boolean;
  /**
   * The new value. A `begin` and an `atomic-cutover` flip write it; a `complete`
   * does not touch the value at all, so it needs none. Injected in tests; on the
   * CLI it is the positional argument or stdin, the same source `set` reads.
   */
  readonly value?: string;
  /** Injected in tests: the wall-clock reading recorded in meta. Defaults to now. */
  readonly now?: string;
}

/** The single step a run performed — the three the two mechanisms decompose into. */
export type RotatePhase = "begin" | "complete" | "cutover";

export interface RotateResult {
  readonly parameter: string;
  readonly environment: string;
  readonly mechanism: RotationMechanism;
  readonly phase: RotatePhase;
  /** The source provider's type — where the value and its meta were written. */
  readonly source: string;
  /** True when this run wrote a new value. `begin` and `cutover` do; `complete` does not. */
  readonly wroteValue: boolean;
  /** The rotation state after this run — `rotating` after a begin, `active` otherwise. */
  readonly state: RotationState;
  /** When the current window opened, ISO. Set only after a `begin`, else `null`. */
  readonly rotatingSince: string | null;
  /** When a rotation last completed, ISO. Set after a `complete` or a `cutover`. */
  readonly lastRotated: string | null;
}

/**
 * The value file a rotation writes to a *backend* and reads back — the parameter
 * at its environment scope, verbatim.
 *
 * A rotating secret belongs to exactly one environment (the credential Vault
 * issues for production is not development's), so the environment scope is its
 * home, and pinning it here is what lets `readPrevious` find the prior version
 * during the window: the write and the retention read must address the same
 * value file byte-for-byte. `encrypted: false` because the value crosses to a
 * backend source of truth verbatim, the way `push` moves it — the backend holds
 * custody of its own store, and penv's envelope is the *local tree's* concern,
 * not the backend's. When the source of truth is instead the local tree,
 * {@link writeRotatedValue} routes to {@link sealAwareWrite}, which seals per
 * meta and removes the twin; this file shape is only ever the backend's.
 */
function rotatingFile(ref: ParameterRef, environment: string): ValueFile {
  return {
    namespace: ref.namespace,
    name: ref.name,
    scope: { kind: "environment", environment },
    encrypted: false,
  };
}

/**
 * Writes the new value to the environment's source of truth, by the custody rule
 * the store's *type* sets — the fix for a rotation that used to persist the live
 * credential as cleartext.
 *
 * The local `.penv` tree is penv's own to seal, so a secret rotated into it must
 * be sealed and its plaintext twin removed, exactly as `set` does: otherwise the
 * value lands as cleartext `.penv/<name>.<env>`, which is committed to git and,
 * because plaintext outranks `.enc` at one scope, also shadows any sealed copy
 * already there. So the local tree goes through {@link sealAwareWrite}, honouring
 * meta's policy. A real backend (vault, mock) holds custody of its own store and
 * penv's envelope is not its concern — the value crosses verbatim via
 * {@link rotatingFile}, the way `push` sends plaintext for the sink to re-seal.
 *
 * `--begin` only ever reaches a backend (a dual-valid window demands a retaining
 * provider, which the local tree is not), but it is routed here too, so both
 * value-write sites share one custody decision.
 */
async function writeRotatedValue(
  project: Project,
  provider: Provider,
  ref: ParameterRef,
  environment: string,
  value: string,
): Promise<void> {
  if (provider.type === LOCAL_TREE_TYPE) {
    await sealAwareWrite({
      project,
      provider,
      ref,
      scope: { kind: "environment", environment },
      value,
      environment,
    });
    return;
  }
  await provider.write(rotatingFile(ref, environment), value);
}

/** The new value a write step requires, or a refusal that names the phase needing it. */
function requireNewValue(value: string | undefined, phase: RotatePhase, key: string): string {
  if (value === undefined) {
    throw new PenvError(
      "ROTATION_NO_VALUE",
      `A ${phase} rotation of ${key} writes a new value, and none was given`,
      "Pass the new value as the argument — `penv rotate <key> <value>` — or pipe it in on stdin.",
    );
  }
  return value;
}

/**
 * A `dual-valid` rotation against a provider that does not retain its previous
 * value — the one situation the mechanism cannot survive, refused before a single
 * write.
 *
 * The window's whole promise is that the old credential keeps working while the
 * new one takes over; a provider that overwrites in place breaks that the instant
 * `begin` writes, and no meta clock can put the old value back. So this is not a
 * best-effort with a warning — it is a hard refusal, thrown here so the caller
 * never opens a grace window that is already a lie. `atomic-cutover` reaches this
 * function's callers not at all: it has no overlap to retain.
 */
function requireRetaining(provider: Provider, environment: string): RetainingProvider {
  if (!retainsPrevious(provider)) {
    throw new PenvError(
      "ROTATION_NOT_RETAINING",
      `A dual-valid rotation needs the previous value to stay readable during the grace window, and the \`${provider.type}\` provider for environment ${environment} does not retain it`,
      "Point this environment at a provider that keeps prior versions (its `readPrevious` is what penv reads during the window), " +
        "or, if a momentary overlap is not required, declare the parameter `atomic-cutover` in its meta and flip it in one step.",
    );
  }
  return provider;
}

export async function runRotate(options: RotateOptions): Promise<RotateResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const ref = refFromKey(options.key, project.config);
  const provider = await sourceProviderFor(project, environment);

  const nowIso = options.now ?? new Date().toISOString();
  const before: Meta | undefined = await provider.readMeta(ref);
  const { mechanism } = rotationOf(before, environment);

  if (mechanism === undefined) {
    throw new PenvError(
      "ROTATION_NO_MECHANISM",
      `Parameter ${options.key} declares no rotation mechanism for environment ${environment}, so penv does not know how to rotate it`,
      'Set `rotationMechanism` in the parameter\'s meta to `"dual-valid"` (a grace-window overlap) or ' +
        '`"atomic-cutover"` (a single flip), then run `penv rotate` again.',
    );
  }

  const begin = options.begin === true;
  const complete = options.complete === true;

  // atomic-cutover: one flip, and `--begin`/`--complete` have no meaning for it —
  // there is no window to bracket. Refuse the flags rather than silently ignore
  // them, so a user who reached for a two-phase rotation learns their parameter
  // is not one before anything is written.
  if (mechanism === "atomic-cutover") {
    if (begin || complete) {
      throw new PenvError(
        "ROTATION_MECHANISM_MISMATCH",
        `Parameter ${options.key} is atomic-cutover, which flips in one step, so \`--begin\`/\`--complete\` do not apply`,
        "Run `penv rotate <key> <value>` with no phase flag to flip it. `--begin`/`--complete` bracket a " +
          "dual-valid grace window, which atomic-cutover has none of.",
      );
    }
    const value = requireNewValue(options.value, "cutover", options.key);
    // Value first, then the completion stamp — the flip and its record, in the
    // order that leaves the value present before anything claims it rotated. The
    // write honours the store's custody rule: sealed into the local tree per
    // meta, verbatim to a backend.
    await writeRotatedValue(project, provider, ref, environment, value);
    const after = completeRotation(before, environment, nowIso);
    await provider.writeMeta(ref, after);
    return result(ref, environment, mechanism, "cutover", provider.type, true, after);
  }

  // dual-valid from here: every path needs a retaining provider, and the two
  // phases are mutually exclusive — exactly one bracket per run.
  const retaining = requireRetaining(provider, environment);

  if (begin === complete) {
    throw new PenvError(
      "ROTATION_PHASE_REQUIRED",
      `A dual-valid rotation of ${options.key} needs exactly one of \`--begin\` or \`--complete\``,
      "`--begin` writes the new value and opens the grace window; `--complete` closes it once every reader " +
        "has moved to the new value. Run them in that order, one at a time.",
    );
  }

  if (begin) {
    const value = requireNewValue(options.value, "begin", options.key);
    // The new value is written while the provider still holds the previous one —
    // that co-existence IS the window, and `readPrevious` serves the old value
    // until `--complete` closes it. Value first, then `rotatingSince`, so the
    // clock never claims a window an unwritten value has not yet opened. A
    // retaining provider is always a backend, so this crosses verbatim; routed
    // through the shared helper so both write sites share one custody decision.
    await writeRotatedValue(project, retaining, ref, environment, value);
    const after = beginRotation(before, environment, nowIso);
    await retaining.writeMeta(ref, after);
    return result(ref, environment, mechanism, "begin", retaining.type, true, after);
  }

  // --complete: the window closes. No value is written — the new value has been
  // live since `--begin`; this only returns the clock to `active` and stamps the
  // completion. The provider's previous version may be pruned any time after.
  const after = completeRotation(before, environment, nowIso);
  await retaining.writeMeta(ref, after);
  return result(ref, environment, mechanism, "complete", retaining.type, false, after);
}

/** Reads the settled clocks back out of the meta just written, so the result is the record. */
function result(
  ref: ParameterRef,
  environment: string,
  mechanism: RotationMechanism,
  phase: RotatePhase,
  source: string,
  wroteValue: boolean,
  after: Meta,
): RotateResult {
  const { state, rotatingSince, lastRotated } = rotationOf(after, environment);
  return {
    parameter: [...ref.namespace, ref.name].join("/"),
    environment,
    mechanism,
    phase,
    source,
    wroteValue,
    state,
    rotatingSince,
    lastRotated,
  };
}

export function renderRotate(result: RotateResult): string[] {
  if (result.phase === "begin") {
    return formatRows([
      {
        glyph: CHECK,
        label: "Rotating",
        subject: result.parameter,
        detail: `dual-valid window open for environment ${result.environment} (since ${result.rotatingSince})`,
      },
      {
        glyph: CHECK,
        label: "Previous",
        subject: "still readable",
        detail: `on the ${result.source} provider until \`penv rotate ${result.parameter} --complete\``,
      },
    ]);
  }
  if (result.phase === "complete") {
    return formatRows([
      {
        glyph: CHECK,
        label: "Rotated",
        subject: result.parameter,
        detail: `dual-valid window closed for environment ${result.environment} (completed ${result.lastRotated})`,
      },
    ]);
  }
  return formatRows([
    {
      glyph: CHECK,
      label: "Rotated",
      subject: result.parameter,
      detail: `atomic-cutover flip for environment ${result.environment} (completed ${result.lastRotated})`,
    },
  ]);
}

export const rotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description: "Rotate a parameter's value by the mechanism its meta declares",
  },
  args: {
    key: { type: "positional", required: true, description: "The parameter, e.g. redis/password" },
    value: {
      type: "positional",
      required: false,
      description: "The new value; read from stdin if omitted. Not needed with --complete",
    },
    env: { type: "string", description: "The environment to rotate in" },
    begin: { type: "boolean", description: "Open a dual-valid grace window with the new value" },
    complete: { type: "boolean", description: "Close a dual-valid grace window" },
  },
  run({ args }) {
    return guard(async () => {
      // `--complete` writes no value, so it never blocks on stdin waiting for one
      // that will not come. Every other path reads the value the way `set` does.
      const value = args.complete === true ? undefined : (args.value ?? (await readStdin()));
      write(
        renderRotate(
          await runRotate({
            cwd: process.cwd(),
            key: args.key,
            ...(value === undefined ? {} : { value }),
            ...(args.env === undefined ? {} : { environment: args.env }),
            ...(args.begin === undefined ? {} : { begin: args.begin }),
            ...(args.complete === undefined ? {} : { complete: args.complete }),
          }),
        ),
      );
    });
  },
});
