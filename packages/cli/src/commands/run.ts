/**
 * `penv run` — how an adopted project starts.
 *
 * It resolves the cascade, checks it against the schema, builds a child
 * environment penv owns, and starts the exact command after `--`. Everything
 * after `--` belongs to the child: argument boundaries, pipes, shell syntax,
 * `pre*`/`post*` lifecycle hooks, exit code, signals. penv never rewrites a
 * script, detects an operator, or generates a backing script — the package
 * manager stays the child, and keeps everything that is its business.
 *
 * Two properties are worth stating because they are what the command is for:
 *
 * **It is network-forbidden.** `run` constructs no provider and contacts
 * nothing. It reads what is already materialised locally, and a missing
 * materialisation is a named failure with the `penv pull` line to run — a
 * provider being down is not a reason an application cannot start. `--watch` is
 * the single opt-in exception, and even there a failed sync leaves the running
 * child exactly where it was.
 *
 * **The verdict is `penv validate`'s.** The check runs once, here, and `run`
 * refuses precisely what `validate` refuses: two implementations of "is this
 * configuration good" would eventually let `run` start a process CI had already
 * rejected. `checkEnvironment` hands back the resolutions and the validated
 * object it reached that verdict on, so the child environment is built from the
 * same read rather than a second one.
 *
 * The daily form is `penv run -- pnpm dev`: `--source` defaults to `project`,
 * and `--env` falls back to the config's `defaultEnvironment`. CI names both.
 */

import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { Artifact, ParameterRef, Resolution } from "@penvhq/core";
import {
  ARTIFACT_BUILD_COMMAND,
  assertArtifactFor,
  isPublicVariable,
  isSecret,
  keySourceFrom,
  MissingMaterializationError,
  openSealed,
  PenvError,
  parseArtifact,
  RECORDS_PATH,
  UndecryptableValueError,
  variableName,
} from "@penvhq/core";
import type { DeliveredValue } from "@penvhq/runtime";
import {
  childEnvironment,
  declaredRefs,
  deliveredEnvironment,
  hasRemoteSource,
  RUN_MARKER,
  SNAPSHOT_VARIABLE,
} from "@penvhq/runtime";
import { defineCommand } from "citty";
import type { z } from "zod";
import type { ChildResult, StartChild } from "../child.js";
import { noCommand, startChild } from "../child.js";
import { activeDotenvFiles } from "../dotenv-files.js";
import { shorthandCandidates } from "../env-flags.js";
import { engineVersion } from "../install.js";
import type { Project } from "../project.js";
import { openProject, targetEnvironment } from "../project.js";
import { guard, heading, reportError, writeError } from "../ui.js";
import type { PullOptions, PullResult } from "./pull.js";
import { runPull } from "./pull.js";
import type { EnvironmentCheck, ValidateResult } from "./validate.js";
import { checkEnvironment } from "./validate.js";

/** Where a run reads its values from. `snapshot` is the sealed artifact. */
export type RunSource = "project" | "snapshot";

const SOURCES: readonly RunSource[] = ["project", "snapshot"];

/** How long a change waits for its neighbours before `--watch` acts on it. */
const DEBOUNCE_MS = 100;

export interface RunOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
  /** Defaults to `project`. */
  readonly source?: string;
  /** The one mode allowed to synchronise. Off by default. */
  readonly watch?: boolean;
  /** The command exactly as it followed `--`. */
  readonly command: readonly string[];
  /** The environment penv itself was started with. Defaults to `process.env`. */
  readonly host?: Readonly<Record<string, string | undefined>>;
  /** Injected in tests: how a child is started. */
  readonly start?: StartChild;
  /** Injected in tests: the sync `--watch` performs. */
  readonly pull?: (options: PullOptions) => Promise<PullResult>;
  /** Injected in tests: what tells `--watch` something changed. */
  readonly changes?: (onChange: () => void) => { close(): void };
}

export interface RunResult {
  readonly environment: string;
  readonly source: RunSource;
  readonly command: readonly string[];
  /** Declared variables written into the child. */
  readonly written: number;
  /** Declared-but-valueless variables deleted from the child. */
  readonly deleted: number;
  /** penv's own variables removed before the child saw them. */
  readonly stripped: readonly string[];
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  /** How many times `--watch` replaced the child. */
  readonly restarts: number;
}

/**
 * The command a run is, written the way the user would type it. It is what the
 * child carries in {@link RUN_MARKER}, so a nested `penv run` can name the
 * wrapper it found itself inside.
 */
function invocationOf(
  environment: string | undefined,
  command: readonly string[],
  source?: RunSource,
): string {
  const named = environment === undefined ? "" : ` --env ${environment}`;
  // Only `snapshot` is spelled out: `project` is the default, so writing it would
  // teach the reader a flag they never have to type.
  const flags = named + (source === "snapshot" ? " --source snapshot" : "");
  const parts = command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part));
  return `penv run${flags} -- ${parts.join(" ")}`;
}

/**
 * An outer `penv run` meeting an in-script one.
 *
 * Both wrappers are named because neither is wrong on its own and the user
 * wrote them in different files — the outer one at a prompt, the inner one in a
 * `package.json` script they may have forgotten. Nesting is refused rather than
 * resolved: two owned environments over one process means the second silently
 * decides, and which one wins would depend on how the script was written.
 */
function assertNotNested(host: Readonly<Record<string, string | undefined>>, inner: string): void {
  const outer = host[RUN_MARKER];
  if (outer === undefined) {
    return;
  }
  throw new PenvError(
    "RUN_NESTED",
    `\`${inner}\` is starting inside \`${outer}\`, and two penv environments cannot own one process`,
    `Drop one of the two wrappers — the inner one is in a package.json script — then run \`${outer}\` again.`,
  );
}

/** The two sources a run reads. Anything else is refused on what it says, not on what it finds. */
function assertSource(source: string, inner: string): RunSource {
  if (source === "project" || source === "snapshot") {
    return source;
  }
  throw new PenvError(
    "RUN_SOURCE_UNKNOWN",
    `\`--source ${source}\` names no source penv reads`,
    `A run reads ${SOURCES.map((name) => `\`${name}\``).join(" or ")}, and \`project\` is the default — so \`${inner}\` reads the local tree.`,
  );
}

/**
 * The public-prefix policy, checked before anything starts.
 *
 * `doctor` reports this and `run` refuses it, and that is the difference between
 * a report and a delivery: the variable is about to be written into a process
 * that will inline it into a browser bundle, permanently. penv is the only thing
 * holding both halves — meta says secret, the generated name says public — so it
 * is the only thing that can stop it.
 *
 * `penv artifact build` makes the same refusal for the same reason: the artifact
 * is the other delivery, and the container reading it has no meta to check.
 * `retry` is the command that was refused, so each caller names its own.
 */
export async function assertNoPublicSecret(
  project: Project,
  environment: string,
  refs: readonly ParameterRef[],
  retry: string,
): Promise<void> {
  const prefixes = project.config.publicPrefixes ?? [];
  if (prefixes.length === 0) {
    return;
  }
  for (const ref of refs) {
    const variable = variableName(ref, project.config);
    if (!isPublicVariable(variable, project.config)) {
      continue;
    }
    if (!isSecret(await project.provider.readMeta(ref), environment)) {
      continue;
    }
    const parameter = [...ref.namespace, ref.name].join("/");
    const prefix = prefixes.find((candidate) => variable.startsWith(candidate));
    throw new PenvError(
      "RUN_PUBLIC_SECRET",
      `The secret ${parameter} maps to ${variable}, which the \`${prefix}\` prefix publishes to the browser`,
      `Rename the parameter, or drop \`secret\` from its meta if it is not one — then \`${retry}\`.`,
    );
  }
}

/** A failed check, told to someone who was trying to start something. */
function invalidConfiguration(result: ValidateResult, inner: string): PenvError {
  const lines = result.issues.map((issue) => `  ${issue.subject}: ${issue.message}`).join("\n");
  return new PenvError(
    "RUN_INVALID_CONFIGURATION",
    `Configuration for environment ${result.environment} is not valid, so nothing was started:\n${lines}`,
    `Fix the values above, then run \`${inner}\` again.`,
  );
}

/** The tree's raw values, in the shape the child-environment assembly takes. */
function valuesOf(
  resolutions: readonly Resolution[],
): { readonly ref: ParameterRef; readonly value: string }[] {
  const values: { ref: ParameterRef; value: string }[] = [];
  for (const resolution of resolutions) {
    if (resolution.value !== undefined) {
      values.push({ ref: resolution.ref, value: resolution.value });
    }
  }
  return values;
}

/** What one check produced, once it is known to be startable. */
interface Prepared {
  readonly env: Record<string, string>;
  readonly written: number;
  readonly deleted: number;
  readonly stripped: readonly string[];
}

/**
 * A dotenv file that came back after the project adopted penv (PRD §6).
 *
 * The framework loads `.env`, `.env.local`, `.env.<environment>` and
 * `.env.<environment>.local` on its own, so one of them reappearing beside
 * penv's records is two live sources of configuration — the drift adoption
 * removed, recreated by an editor, a generator, or a teammate's paste. It is
 * refused rather than merged: which of the two is right is not penv's to decide,
 * and the environment the file serves is not always the one being started.
 *
 * `.env.example` and its kin are documentation and no framework loads them, so
 * they are not active files and are never checked. Neither is `.env.staging` in
 * a project that never declared `staging`: nothing loads it either.
 */
function assertNoActiveDotenv(project: Project): void {
  const active = activeDotenvFiles(project.root, project.config);
  const first = active[0];
  if (first === undefined) {
    return;
  }
  throw new PenvError(
    "RUN_DOTENV_ACTIVE",
    `${first.name} is active configuration again, and your framework would read it beside penv's records`,
    `Adopt it with \`penv init\`, or delete ${first.name} — its values belong in ${RECORDS_PATH}/.`,
  );
}

async function prepare(
  project: Project,
  environment: string,
  host: Readonly<Record<string, string | undefined>>,
  inner: string,
): Promise<Prepared> {
  assertNoActiveDotenv(project);
  const check: EnvironmentCheck = await checkEnvironment(project, environment);

  if (!check.result.ok || check.schema === undefined) {
    // Nothing at all resolved, for an environment whose values live in a
    // provider: this is the clone-and-run case, and the whole tree is what is
    // missing. The schema report below would be a wall of absences with the
    // wrong remedy under it.
    if (
      check.resolutions.every((resolution) => resolution.winner === undefined) &&
      hasRemoteSource(project.config, environment)
    ) {
      throw new MissingMaterializationError(environment);
    }
    throw invalidConfiguration(check.result, inner);
  }

  const schema: z.ZodType = check.schema;
  await assertNoPublicSecret(project, environment, declaredRefs(schema), inner);

  const { env, written, deleted, stripped } = childEnvironment({
    host,
    config: project.config,
    environment,
    schema,
    values: valuesOf(check.resolutions),
    ...(check.validated === undefined ? {} : { validated: check.validated }),
    invocation: inner,
  });
  return { env, written, deleted, stripped };
}

/**
 * The artifact a `--source snapshot` run reads, and only that.
 *
 * `PENV_SNAPSHOT` is the whole of the input. There is no search, no default
 * path, and no fall back to the project tree: a container that was supposed to
 * mount an artifact and did not must say so, not quietly start from whatever
 * happens to be on disk beside it.
 */
function snapshotPath(host: Readonly<Record<string, string | undefined>>): string {
  const path = host[SNAPSHOT_VARIABLE]?.trim();
  if (path === undefined || path.length === 0) {
    throw new PenvError(
      "RUN_SNAPSHOT_UNSET",
      `\`--source snapshot\` reads the sealed artifact ${SNAPSHOT_VARIABLE} names, and ${SNAPSHOT_VARIABLE} is not set`,
      `Build one with \`${ARTIFACT_BUILD_COMMAND}\` and point ${SNAPSHOT_VARIABLE} at it.`,
    );
  }
  return path;
}

function readSnapshot(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new PenvError(
      "RUN_SNAPSHOT_MISSING",
      `${SNAPSHOT_VARIABLE} names ${path}, and penv cannot read a sealed artifact there`,
      `Point ${SNAPSHOT_VARIABLE} at the artifact your release mounted — \`${ARTIFACT_BUILD_COMMAND}\` writes one.`,
    );
  }
}

/**
 * The artifact's values, opened in memory.
 *
 * The key source is the identifier the artifact carries and nothing else — the
 * `keys` block never travelled, because provider and key *configuration* is
 * exactly what an artifact must not hold. A ciphertext that will not open is a
 * refusal here, before the child exists: the alternative is starting an
 * application with a variable silently missing.
 */
function openSnapshot(artifact: Artifact, path: string): DeliveredValue[] {
  const keys = keySourceFrom(artifact.keySource, artifact.environment);
  return Object.entries(artifact.values)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([parameter, entry]): DeliveredValue => {
      if (entry.kind === "absent") {
        return { parameter, variable: entry.variable };
      }
      if (entry.kind === "plain") {
        return { parameter, variable: entry.variable, value: entry.value };
      }
      const opened = openSealed(entry.address, entry.sealed, keys);
      if (opened.kind === "failed") {
        throw new UndecryptableValueError(
          parameter,
          artifact.environment,
          `${entry.address} in ${path}`,
          opened.failure,
        );
      }
      return { parameter, variable: entry.variable, value: opened.value };
    });
}

/**
 * A run from a sealed artifact: read, verify, open, inject.
 *
 * No project is opened, and that is the point rather than an optimisation.
 * There is no `penv.config.ts`, no records tree and no provider package in a
 * release container, so this path reaches for none of them — and the artifact is
 * verified whole (format, engine, environment, delivery digest) before a single
 * ciphertext is opened.
 */
function prepareFromSnapshot(
  host: Readonly<Record<string, string | undefined>>,
  environment: string | undefined,
  command: readonly string[],
): { readonly environment: string; readonly prepared: Prepared } {
  const path = snapshotPath(host);
  const artifact = parseArtifact(readSnapshot(path), path);
  assertArtifactFor(
    artifact,
    { engineVersion: engineVersion(), ...(environment === undefined ? {} : { environment }) },
    path,
  );

  const { env, written, deleted, stripped } = deliveredEnvironment({
    host,
    environment: artifact.environment,
    values: openSnapshot(artifact, path),
    invocation: invocationOf(artifact.environment, command, "snapshot"),
  });
  return { environment: artifact.environment, prepared: { env, written, deleted, stripped } };
}

/**
 * `--watch`'s sync, and whether it worked.
 *
 * Reported and swallowed rather than thrown: a provider that will not answer
 * must not take a running child down with it. The caller uses the answer to
 * decide whether to go on — mid-session it does not, because restarting on a
 * sync that did not happen would swap a validated environment for the same one
 * and stop the child for nothing.
 */
async function sync(
  project: Project,
  environment: string,
  pull: (options: PullOptions) => Promise<PullResult>,
): Promise<boolean> {
  if (!hasRemoteSource(project.config, environment)) {
    return true;
  }
  try {
    await pull({ cwd: project.root, environment });
    return true;
  } catch (error) {
    // The message is what is wanted here, not the verdict: a provider that would
    // not answer must not decide the exit code of a session the user ends later.
    const previous = process.exitCode;
    reportError(error);
    process.exitCode = previous;
    return false;
  }
}

/** The default change signal: the records tree and the config file, debounced. */
function watchProject(project: Project, onChange: () => void): { close(): void } {
  const watchers = new Set<FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const add = (target: string, recursive: boolean, only?: string): void => {
    if (!existsSync(target)) {
      return;
    }
    try {
      const watcher = watch(target, { recursive }, (_event, filename) => {
        if (only !== undefined && (filename === null || basename(filename) !== only)) {
          return;
        }
        schedule();
      });
      watcher.on("error", () => watchers.delete(watcher));
      watchers.add(watcher);
    } catch {
      // A platform that cannot watch this target is a weaker watch, never a
      // wrong run: the child already has the environment penv resolved.
    }
  };

  add(project.recordsDir, true);
  add(dirname(project.configFile), false, basename(project.configFile));

  return {
    close(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

export async function runRun(options: RunOptions): Promise<RunResult> {
  const command = options.command;
  const host = options.host ?? process.env;
  const inner = invocationOf(options.environment, command);

  // Before anything is opened or read: a nested run is refused on what it is,
  // not on what the project turns out to hold.
  assertNotNested(host, inner);
  const source = assertSource(options.source ?? "project", inner);
  if (command.length === 0) {
    throw noCommand();
  }

  if (source === "snapshot") {
    // `--watch` synchronises a tree from a provider, and neither exists here. It
    // is refused rather than ignored: a flag that quietly does nothing is a
    // developer waiting for a restart that is never coming.
    if (options.watch === true) {
      throw new PenvError(
        "RUN_SNAPSHOT_WATCH",
        "`--watch` re-syncs the project tree, and a run from a sealed artifact has no tree to watch",
        "Drop `--watch` — an artifact is built once and read unchanged. Watch the project instead: `penv run --watch -- <command>`.",
      );
    }
    // A release container has no project to open, so none is.
    const snapshot = prepareFromSnapshot(host, options.environment, command);
    return startAndReport(
      snapshot.environment,
      source,
      command,
      snapshot.prepared,
      options.start ?? startChild,
      options.cwd,
    );
  }

  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment, options.envFlags);
  const invocation = invocationOf(environment, command);
  const start = options.start ?? startChild;
  const pull = options.pull ?? runPull;

  if (options.watch) {
    await sync(project, environment, pull);
  }

  const first = await prepare(project, environment, host, invocation);
  if (options.watch !== true) {
    return startAndReport(environment, source, command, first, start, project.root);
  }
  announce(environment, source, first);

  let current = start({ command, env: first.env, cwd: project.root });

  let restarts = 0;
  let restarting: Promise<void> | undefined;
  let closed = false;

  const changed = (options.changes ?? ((onChange) => watchProject(project, onChange)))(() => {
    if (closed || restarting !== undefined) {
      return;
    }
    restarting = (async () => {
      // A failed sync or a failed check leaves the child exactly where it was.
      // That is the guarantee of the mode: an edit mid-thought, or a provider
      // that will not answer, must not take the dev server down — and the
      // environment the child already has is still the last one that validated.
      if (!(await sync(project, environment, pull))) {
        return;
      }
      let next: Prepared;
      try {
        next = await prepare(project, environment, host, invocation);
      } catch (error) {
        const previous = process.exitCode;
        reportError(error);
        process.exitCode = previous;
        return;
      }
      if (closed) {
        return;
      }
      const previous = current;
      previous.kill("SIGTERM");
      await previous.ended;
      current = start({ command, env: next.env, cwd: project.root });
      restarts += 1;
    })().finally(() => {
      restarting = undefined;
    });
  });

  try {
    for (;;) {
      const ended = await current.ended;
      // The child ended while a restart was in flight — the restart is what
      // ended it, so wait for the replacement rather than reporting the kill.
      if (restarting !== undefined) {
        await restarting;
        continue;
      }
      closed = true;
      return report(environment, source, command, first, ended, restarts);
    }
  } finally {
    closed = true;
    changed.close();
  }
}

/**
 * penv's one line, on stderr: the child owns stdout, and a run whose output is
 * piped somewhere must deliver the child's bytes and nothing else.
 */
function announce(environment: string, source: RunSource, prepared: Prepared): void {
  writeError([
    heading(
      `penv run · ${environment}`,
      `${source} · ${prepared.written} variables${prepared.deleted === 0 ? "" : ` · ${prepared.deleted} deleted`}`,
    ),
  ]);
}

/** The plain run, whichever source prepared it: announce, start, wait, report. */
async function startAndReport(
  environment: string,
  source: RunSource,
  command: readonly string[],
  prepared: Prepared,
  start: StartChild,
  cwd: string,
): Promise<RunResult> {
  announce(environment, source, prepared);
  const ended = await start({ command, env: prepared.env, cwd }).ended;
  return report(environment, source, command, prepared, ended, 0);
}

function report(
  environment: string,
  source: RunSource,
  command: readonly string[],
  prepared: Prepared,
  ended: ChildResult,
  restarts: number,
): RunResult {
  return {
    environment,
    source,
    command,
    written: prepared.written,
    deleted: prepared.deleted,
    stripped: prepared.stripped,
    exitCode: ended.exitCode,
    signal: ended.signal,
    restarts,
  };
}

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Start a command in a penv-owned child environment",
  },
  args: {
    env: { type: "string", description: "The environment to run against" },
    source: {
      type: "string",
      description: "Where values come from: project (default) or snapshot",
    },
    watch: { type: "boolean", description: "Re-sync and restart the child when the tree changes" },
  },
  run({ args, rawArgs }) {
    return guard(async () => {
      // The command is taken from the raw arguments, not from the parsed
      // positionals: `--` is the boundary the user drew, and re-deriving it from
      // a parse would be penv having an opinion about the argument list it
      // promised not to read.
      const separator = rawArgs.indexOf("--");
      const command = separator === -1 ? [] : rawArgs.slice(separator + 1);

      const result = await runRun({
        cwd: process.cwd(),
        command,
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.watch === true ? { watch: true } : {}),
        envFlags: shorthandCandidates(args, ["env", "source", "watch"]),
      });

      // The child's status is the run's status, both halves of it. A signal is
      // re-raised on penv itself so a shell sees the death it would have seen
      // without the wrapper.
      if (result.signal !== null) {
        process.kill(process.pid, result.signal);
        return;
      }
      process.exitCode = result.exitCode;
    });
  },
});
