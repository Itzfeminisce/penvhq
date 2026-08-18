/**
 * The recovery state of one dotenv cutover.
 *
 * `penv init` moves a project's active dotenv files into
 * `.penv/state/rollback/dotenv/` and writes `.penv/state/cutover.json` beside
 * it. Together they are a single migration's undo, and deliberately nothing
 * more: this is not local secret versioning, and a second cutover is refused
 * while a bundle is unresolved rather than stacked on top of it.
 *
 * Both are ignored by the committed `state/.gitignore`. The bundle holds the
 * plaintext values that were in the user's `.env` (invariant 20), and the state
 * file names a bundle that exists on exactly one machine — a teammate who cloned
 * it would be told a migration they never ran is waiting to be undone.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CUTOVER_PATH,
  findConfigFile,
  PenvError,
  ROLLBACK_DOTENV_PATH,
  ROLLBACK_PATH,
} from "@penvhq/core";

/** The only cutover format penv reads. A later one is a penv the project needs. */
export const CUTOVER_FORMAT = 1;

export interface Cutover {
  readonly format: number;
  /** When the files were moved, ISO-8601 UTC. */
  readonly movedAt: string;
  /** The filenames as they were at the project root — what undo restores, exactly. */
  readonly files: readonly string[];
  /** The environments the cutover declared, so a report can name them without the config. */
  readonly environments: readonly string[];
}

function fileFor(root: string, relativePosix: string): string {
  return join(root, ...relativePosix.split("/"));
}

/** The bundle directory of `root`, absolute. */
export function bundleDir(root: string): string {
  return fileFor(root, ROLLBACK_DOTENV_PATH);
}

export function cutoverFile(root: string): string {
  return fileFor(root, CUTOVER_PATH);
}

/**
 * The project `undo` and `cleanup` act on: the directory holding the
 * `penv.config.ts` this one is inside, exactly as every other command finds it.
 *
 * Rooted at the working directory instead, both commands would report nothing to
 * do from any subdirectory of the project they were meant to recover.
 */
export function cutoverRoot(cwd: string): string {
  const file = findConfigFile(cwd);
  return file === undefined ? resolve(cwd) : dirname(file);
}

/** The filenames the rollback bundle holds, sorted. Empty when there is no bundle. */
export function bundledFiles(root: string): string[] {
  try {
    return readdirSync(bundleDir(root)).sort();
  } catch {
    return [];
  }
}

/**
 * True while a cutover is still waiting on `penv init undo` or `penv cleanup`.
 *
 * The bundle counts on its own, not only the record that names it: a bundle with
 * no `cutover.json` is a cutover whose record was deleted by hand, and reading it
 * as "no cutover" is how a second migration would move a second set of files over
 * the first one's — into a gitignored directory nothing would ever look in again.
 */
export function bundleUnresolved(root: string): boolean {
  return readCutover(root) !== undefined || bundledFiles(root).length > 0;
}

/**
 * The recorded cutover, or `undefined` when this project has none. A file that
 * exists and cannot be read is an error, never an absence: reading it as "no
 * cutover" is how a second migration would move a second set of files over the
 * first one's bundle.
 */
export function readCutover(root: string): Cutover | undefined {
  const file = cutoverFile(root);
  if (!existsSync(file)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw unreadable("it is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unreadable("it is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== CUTOVER_FORMAT) {
    throw unreadable(
      `it is format ${JSON.stringify(record.format)}, and penv reads format ${CUTOVER_FORMAT}`,
    );
  }
  const files = record.files;
  if (!Array.isArray(files) || files.some((name) => typeof name !== "string")) {
    throw unreadable("it lists no filenames");
  }
  const environments = Array.isArray(record.environments)
    ? record.environments.filter((name): name is string => typeof name === "string")
    : [];
  return {
    format: CUTOVER_FORMAT,
    movedAt: typeof record.movedAt === "string" ? record.movedAt : "",
    files: files as string[],
    environments,
  };
}

function unreadable(what: string): PenvError {
  return new PenvError(
    "CUTOVER_UNREADABLE",
    `${CUTOVER_PATH} records the last dotenv cutover, and ${what}`,
    `Run \`penv cleanup\` to drop that record and the rollback bundle it names.`,
  );
}

/** Sorted keys and a trailing newline, so the file is the same bytes on every machine. */
export function serializeCutover(cutover: Cutover): string {
  return `${JSON.stringify(
    {
      environments: [...cutover.environments],
      files: [...cutover.files],
      format: cutover.format,
      movedAt: cutover.movedAt,
    },
    null,
    2,
  )}\n`;
}

/**
 * Records the cutover, then moves the selected dotenv files into the bundle.
 *
 * The move is last in a cutover — everything else has already been written and
 * validated — so a failure before it leaves a project whose dotenv files are
 * exactly where they were. Within the move, the record goes first and names every
 * file the move intends: a crash or a file lock between two renames then leaves a
 * bundle penv can still describe, and `penv init undo` puts back what arrived.
 * Written the other way round, the files already moved would be orphaned in a
 * gitignored directory no command knew to look in.
 */
export function bundleDotenvFiles(
  root: string,
  files: readonly string[],
  environments: readonly string[],
  now: Date = new Date(),
): Cutover {
  const cutover: Cutover = {
    format: CUTOVER_FORMAT,
    movedAt: now.toISOString(),
    files: [...files],
    environments: [...environments],
  };
  const file = cutoverFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeCutover(cutover), "utf8");

  const bundle = bundleDir(root);
  mkdirSync(bundle, { recursive: true });
  for (const name of files) {
    renameSync(join(root, name), join(bundle, name));
  }
  return cutover;
}

export interface UndoResult {
  readonly root: string;
  /** The files put back, in the order they were moved. */
  readonly restored: readonly string[];
  /** Recorded names already at the project root — what an interrupted undo had reached. */
  readonly alreadyBack: readonly string[];
  /** Recorded names in neither the bundle nor the project root. Nothing penv can restore. */
  readonly missing: readonly string[];
}

/**
 * Puts every bundled file back under its exact original name, then drops the
 * bundle and the state that named it.
 *
 * Undo is resumable, because the thing it recovers from is an interruption. A
 * name already at the project root and no longer in the bundle is a file an
 * earlier run put back, not a collision — only a name that is in both places at
 * once is, and that is the one case worth refusing over, since restoring would
 * write over whatever came back. A name in neither place is reported rather than
 * refused: the old refusal's remedy was `penv cleanup`, which would have deleted
 * every file that was still recoverable.
 */
export function runUndo(options: { readonly cwd: string }): UndoResult {
  const root = cutoverRoot(options.cwd);
  const cutover = readCutover(root);
  const bundled = bundledFiles(root);
  if (cutover === undefined && bundled.length === 0) {
    throw new PenvError(
      "INIT_UNDO_NOTHING",
      "There is no dotenv cutover to undo in this project",
      "Run `penv init` to adopt your dotenv files; undo puts them back afterwards.",
    );
  }

  // The record's order, then anything the bundle holds that it does not name.
  // Only a cutover ever writes into the bundle, so a file filed there belongs at
  // the project root under the name it is filed under, recorded or not.
  const recorded = cutover?.files ?? [];
  const names = [...recorded, ...bundled.filter((name) => !recorded.includes(name))];

  const bundle = bundleDir(root);
  const held = new Set(bundled);
  const occupied = names.filter((name) => held.has(name) && existsSync(join(root, name)));
  if (occupied.length > 0) {
    const listed = occupied.join(", ");
    const many = occupied.length > 1;
    throw new PenvError(
      "INIT_UNDO_OCCUPIED",
      `${listed} ${many ? "exist" : "exists"} again, and restoring what penv moved aside would write over ${many ? "them" : "it"}`,
      `Move ${listed} out of the way, or run \`penv cleanup\` to keep ${many ? "them" : "it"} and drop the bundle. Nothing was restored.`,
    );
  }

  const restored: string[] = [];
  const alreadyBack: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (held.has(name)) {
      renameSync(join(bundle, name), join(root, name));
      restored.push(name);
    } else if (existsSync(join(root, name))) {
      alreadyBack.push(name);
    } else {
      missing.push(name);
    }
  }
  removeBundle(root);
  return { root, restored, alreadyBack, missing };
}

export interface CleanupResult {
  readonly root: string;
  /** The files the bundle held. Empty when there was nothing to clean up. */
  readonly removed: readonly string[];
  readonly cleaned: boolean;
}

/**
 * Drops the rollback bundle and the cutover state, and nothing else. The records
 * tree, the schema, the config and the loader are the project's — cleanup is the
 * end of the migration, not the end of the adoption.
 */
export function runCleanup(options: { readonly cwd: string }): CleanupResult {
  const root = cutoverRoot(options.cwd);
  const held = bundledFiles(root);
  const cleaned =
    held.length > 0 || existsSync(cutoverFile(root)) || existsSync(fileFor(root, ROLLBACK_PATH));
  removeBundle(root);
  return { root, removed: held, cleaned };
}

function removeBundle(root: string): void {
  rmSync(fileFor(root, ROLLBACK_PATH), { recursive: true, force: true });
  rmSync(cutoverFile(root), { force: true });
}
