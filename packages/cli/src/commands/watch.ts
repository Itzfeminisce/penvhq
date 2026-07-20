/**
 * `penv watch` — re-run validation whenever the configuration changes.
 *
 * Watch mode reports `penv validate`'s verdict on a loop, and never a second
 * opinion about it: the diagnostics come from `runValidate` itself, so there is
 * no watch-mode verdict that could drift from the command CI runs.
 *
 * It prints one thing `validate` does not — the schema↔tree drift report, which
 * `runValidate` measures and hands back without letting it touch `ok`. The two
 * commands differ because their readers do. CI wants a verdict, and a warning
 * about a parameter the schema tolerates would be noise in a log nobody reads on
 * a passing run. The person with `watch` open is mid-edit, and the distance
 * between what they have just declared and what the tree holds is the thing they
 * are watching *for*. Same facts, same measurement, one of them worth printing
 * only where someone is looking.
 *
 * Three things decide the answer, so three things are watched: the `.penv/` tree
 * (the values and their meta), `penv.config.ts` (the environment whitelist, and
 * the `override` block), and the schema. The schema is watched on its own only when
 * `schemaFile` puts it outside `.penv/` — at the default it is inside the tree,
 * and a second watcher on it would report every edit twice.
 *
 * `node:fs` does the watching. A dependency-free watcher is worth the handful of
 * lines here: the events this needs are the ones the platform already reports,
 * and debouncing them is the whole of what a library would add.
 */

import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { schemaFileOf, schemaInsideTree } from "@penvhq/core";
import { defineCommand } from "citty";
import { openProject } from "../project.js";
import type { DriftReport } from "../schema.js";
import { out } from "../style.js";
import { formatRows, guard, type Row, reportError, tip, WARN, write } from "../ui.js";
import type { ValidateResult } from "./validate.js";
import { renderValidate, runValidate } from "./validate.js";

/**
 * Long enough to coalesce an editor's save into one run, short enough to feel
 * immediate. An atomic save is a write, a rename, and sometimes a delete, and a
 * run per event would validate a tree mid-rewrite and report a file that exists
 * again by the time the user reads the line.
 */
const DEBOUNCE_MS = 100;

export interface WatchOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Defaults to {@link DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Called with every completed validation, starting with the initial one. */
  readonly onResult?: (result: ValidateResult) => void;
  /**
   * Called when a cycle could not produce a result at all — an unreadable
   * config, a watcher the platform dropped. Never called for a *failing*
   * validation: that is a result, and it goes to `onResult`.
   */
  readonly onError?: (error: unknown) => void;
}

export interface WatchHandle {
  /** Stops watching. Idempotent, and safe to call from inside a callback. */
  close(): void;
}

/**
 * Watches, and re-validates on change.
 *
 * Returns a handle rather than blocking, so the loop is a plain object a test
 * can drive and close instead of a live process it would have to spawn. The
 * command below is the only thing that turns it into a process that waits.
 */
export function runWatch(options: WatchOptions): WatchHandle {
  // Fails fast, and before any watcher exists: a watch on a directory that is
  // not a penv project would report the same error on every keystroke instead.
  const project = openProject(options.cwd);
  const configFile = basename(project.configFile);
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  const watchers = new Set<FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let closed = false;

  async function validate(): Promise<void> {
    if (closed) {
      return;
    }
    // One run at a time: a save that lands mid-run would otherwise read the tree
    // twice at once and report whichever finished last.
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await runValidate({
        cwd: options.cwd,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (!closed) {
        options.onResult?.(result);
      }
    } catch (error) {
      // A file can vanish between the event and the read — that is what an
      // atomic save looks like from here. Report it and keep watching: the
      // rename that follows will schedule the run that gets the real answer.
      if (!closed) {
        options.onError?.(error);
      }
    } finally {
      running = false;
      if (pending && !closed) {
        pending = false;
        void validate();
      }
    }
  }

  function schedule(): void {
    if (closed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void validate();
    }, debounceMs);
  }

  function stop(watcher: FSWatcher): void {
    watchers.delete(watcher);
    watcher.close();
  }

  /**
   * Waits for a vanished target to come back, by watching its parent for the
   * name to reappear.
   *
   * A branch switch is a delete and then a create, so a watch that merely
   * stopped at the delete would be silent for the rest of the session — the
   * user would be reading a report of a tree that has since returned. The
   * re-armed watcher validates on arrival rather than trusting the report the
   * deletion produced.
   */
  function armRecovery(target: string, recursive: boolean, only?: string): void {
    const parent = dirname(target);
    const name = basename(target);
    let recovery: FSWatcher | undefined;

    try {
      recovery = watch(parent, { recursive: false }, (_event, filename) => {
        if (closed || recovery === undefined) {
          return;
        }
        // The parent went too. Watching it would spin exactly the way the
        // vanished target did, and there is nothing left to recover from.
        if (!existsSync(parent)) {
          stop(recovery);
          return;
        }
        if (filename !== null && basename(filename) !== name) {
          return;
        }
        if (!existsSync(target)) {
          return;
        }
        stop(recovery);
        addWatcher(target, recursive, only);
        schedule();
      });
    } catch (error) {
      options.onError?.(error);
      return;
    }

    recovery.on("error", (error) => {
      if (!closed) {
        options.onError?.(error);
      }
    });
    watchers.add(recovery);
  }

  /**
   * `recursive` is not available on every platform, so a watcher that cannot
   * have it watches the directory itself. Namespace folders below it go
   * unwatched there, which is a weaker watch — never a wrong validation, since
   * the answer always comes from a fresh `runValidate`.
   */
  function addWatcher(target: string, recursive: boolean, only?: string): void {
    let watcher: FSWatcher | undefined;

    const listen = (useRecursive: boolean): FSWatcher =>
      watch(target, { recursive: useRecursive }, (_event, filename) => {
        if (closed) {
          return;
        }
        // A deleted target does not stop its watcher, and on Windows does not
        // error either: it re-fires `rename` for the absent path tens of
        // thousands of times a second, forever. Left alone that pins a core,
        // and every event resets the debounce below, so the watch would burn
        // CPU while reporting nothing at all. The check costs a `stat` per
        // event, which is what a `.penv/` that is still there is worth.
        //
        // Deleting the tree is a change like any other, so it is scheduled
        // rather than reported as a failure: `runValidate` has a real verdict
        // for a missing `.penv/`, and watch's job is to say what validate says.
        if (!existsSync(target)) {
          if (watcher !== undefined) {
            stop(watcher);
          }
          armRecovery(target, recursive, only);
          schedule();
          return;
        }
        // Directories are watched rather than files so that an editor's
        // write-to-temp-then-rename is seen as a change to the real name. The
        // cost is hearing about neighbours, so the ones that matter are named.
        if (only !== undefined && (filename === null || basename(filename) !== only)) {
          return;
        }
        schedule();
      });

    try {
      watcher = listen(recursive);
    } catch (error) {
      if (!recursive) {
        options.onError?.(error);
        return;
      }
      try {
        watcher = listen(false);
      } catch (fallbackError) {
        options.onError?.(fallbackError);
        return;
      }
    }
    watcher.on("error", (error) => {
      if (!closed) {
        options.onError?.(error);
      }
    });
    watchers.add(watcher);
  }

  addWatcher(project.penvDir, true);
  addWatcher(dirname(project.configFile), false, configFile);

  // The schema declares what must exist, so an edit to it changes the answer. A
  // schema inside the tree already has a watcher; one outside would have none,
  // and a watch that keeps reporting a verdict it can no longer see the reason
  // for is the silence this command exists to prevent.
  if (schemaInsideTree(project.config) === undefined) {
    const schemaFile = resolve(project.root, schemaFileOf(project.config));
    addWatcher(dirname(schemaFile), false, basename(schemaFile));
  }

  // The current answer, before anything changes: a watch that says nothing until
  // the next keystroke leaves the user guessing at the state they already have.
  void validate();

  return {
    close(): void {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of [...watchers]) {
        stop(watcher);
      }
    },
  };
}

/**
 * One cycle's report: `penv validate`'s, with a rule above it — on a loop, the
 * reader's first question is where the last run ended — and the drift below it.
 *
 * Drift comes last because it is the part that is not a verdict. The rows above
 * say whether the configuration is valid; these say what the schema and the tree
 * disagree about, which is often *why*, and is worth reading even on a run that
 * passed.
 */
export function renderWatch(result: ValidateResult): string[] {
  return ["", ...renderValidate(result), ...renderDrift(result.drift, result.environment)];
}

/**
 * The drift rows. Nothing at all when the schema and the tree agree: a loop
 * reprints its whole report on every keystroke, and a block that says "no drift"
 * forever is the first thing the eye learns to skip past — taking the block that
 * matters with it.
 */
export function renderDrift(drift: DriftReport, environment: string): string[] {
  const rows: Row[] = [
    ...drift.declared.map((item) => ({
      glyph: WARN,
      label: "Declared, no value",
      subject: item.subject,
      detail: item.detail,
    })),
    ...drift.undeclared.map((item) => ({
      glyph: WARN,
      label: "Unused parameter",
      subject: item.variable,
      detail: "present, not in schema",
    })),
  ];
  if (rows.length === 0) {
    return [];
  }

  const lines = ["", out.bold(`Schema and tree differ for ${environment}:`), ...formatRows(rows)];
  // The paste block, exactly as `doctor` prints it — the reader who sees drift
  // here and drift there is looking at one report, not two that resemble each other.
  for (const remedy of new Set(drift.declared.map((item) => item.remedy))) {
    lines.push(tip(remedy));
  }
  return lines;
}

export const watchCommand = defineCommand({
  meta: {
    name: "watch",
    description: "Re-validate whenever .penv/ or penv.config.ts changes",
  },
  args: {
    env: { type: "string", description: "The environment to validate" },
  },
  run({ args }) {
    return guard(async () => {
      const handle = runWatch({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        onResult: (result) => {
          write(renderWatch(result));
        },
        // A failing cycle is reported and watching continues. `reportError`
        // marks the process failed, which `validate` wants and a loop does not:
        // a cycle that failed mid-save ten minutes ago must not decide the exit
        // code of a session the user ended deliberately. The message is what is
        // wanted here, not the verdict.
        onError: (error) => {
          const previous = process.exitCode;
          reportError(error);
          process.exitCode = previous;
        },
      });
      write([`Watching .penv/ and penv.config.ts. ${out.dim("Ctrl-C to stop.")}`]);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => {
          handle.close();
          resolve();
        });
      });
    });
  },
});
