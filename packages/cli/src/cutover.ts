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
import { dirname, join } from "node:path";
import { CUTOVER_PATH, PenvError, ROLLBACK_DOTENV_PATH, ROLLBACK_PATH } from "@penvhq/core";

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
 * Moves the selected dotenv files into the bundle and records them. The move is
 * last in a cutover — everything else has already been written and validated —
 * so a failure here leaves a project that reads its values from penv with its
 * dotenv files still in place, which is the state a re-run recovers from.
 */
export function bundleDotenvFiles(
  root: string,
  files: readonly string[],
  environments: readonly string[],
  now: Date = new Date(),
): Cutover {
  const bundle = bundleDir(root);
  mkdirSync(bundle, { recursive: true });
  for (const name of files) {
    renameSync(join(root, name), join(bundle, name));
  }
  const cutover: Cutover = {
    format: CUTOVER_FORMAT,
    movedAt: now.toISOString(),
    files: [...files],
    environments: [...environments],
  };
  const file = cutoverFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeCutover(cutover), "utf8");
  return cutover;
}

export interface UndoResult {
  readonly root: string;
  /** The files put back, in the order they were moved. */
  readonly restored: readonly string[];
}

/**
 * Puts every bundled file back under its exact original name, then drops the
 * bundle and the state that named it.
 *
 * Nothing is restored until every name is checked, for the same reason the
 * cutover preflights: a half-restored project has some values in penv and some
 * in dotenv, and no command can tell which is current.
 */
export function runUndo(options: { readonly cwd: string }): UndoResult {
  const root = options.cwd;
  const cutover = readCutover(root);
  if (cutover === undefined) {
    throw new PenvError(
      "INIT_UNDO_NOTHING",
      "There is no dotenv cutover to undo in this project",
      "Run `penv init` to adopt your dotenv files; undo puts them back afterwards.",
    );
  }

  const bundle = bundleDir(root);
  for (const name of cutover.files) {
    if (!existsSync(join(bundle, name))) {
      throw new PenvError(
        "INIT_UNDO_INCOMPLETE",
        `${ROLLBACK_DOTENV_PATH}/${name} is gone, so penv cannot put your dotenv files back as they were`,
        "Run `penv cleanup` to drop what is left of the bundle — your values are in .penv/state/records/.",
      );
    }
    if (existsSync(join(root, name))) {
      throw new PenvError(
        "INIT_UNDO_OCCUPIED",
        `${name} exists again, and restoring the one penv moved aside would write over it`,
        `Move ${name} out of the way, or run \`penv cleanup\` to keep it and drop the bundle. Nothing was restored.`,
      );
    }
  }

  for (const name of cutover.files) {
    renameSync(join(bundle, name), join(root, name));
  }
  removeBundle(root);
  return { root, restored: cutover.files };
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
  const root = options.cwd;
  const bundle = bundleDir(root);
  const held = existsSync(bundle) ? readdirSync(bundle).sort() : [];
  const cleaned =
    held.length > 0 || existsSync(cutoverFile(root)) || existsSync(fileFor(root, ROLLBACK_PATH));
  removeBundle(root);
  return { root, removed: held, cleaned };
}

function removeBundle(root: string): void {
  rmSync(fileFor(root, ROLLBACK_PATH), { recursive: true, force: true });
  rmSync(cutoverFile(root), { force: true });
}
