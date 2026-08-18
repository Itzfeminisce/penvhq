/**
 * Putting a project back exactly as init found it.
 *
 * `penv init` is all-or-nothing, and everything before the dotenv move is
 * arranged so a refusal costs a re-run and nothing else. The scaffold is the one
 * step that reaches that promise by construction only until it doesn't: the
 * draft schema is written, the records are imported, and *then* the draft is
 * loaded — so a draft that cannot be loaded used to leave `penv.config.ts`,
 * `penv.schema.ts`, a rewritten `tsconfig.json`, `.penv/env.ts` and a records
 * tree behind, and the next `penv init` kept all of it rather than starting
 * clean.
 *
 * So the paths init may write are snapshotted before it writes them, and put
 * back on the way out: a file penv created is deleted, a file penv edited is
 * rewritten byte for byte, and a directory penv made is removed. Nothing outside
 * the snapshotted paths is touched, which is why the caller names them rather
 * than this module guessing at the project.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface ScaffoldUndo {
  /** The project root. Nothing above it is ever removed. */
  readonly root: string;
  /** The files and directories init may write, absolute. */
  readonly paths: readonly string[];
  /** What each file held before, byte for byte. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** The directories that already existed, so the rest are penv's to remove. */
  readonly dirs: ReadonlySet<string>;
}

function record(path: string, files: Map<string, Buffer>, dirs: Set<string>): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isDirectory()) {
    dirs.add(path);
    for (const entry of readdirSync(path)) {
      record(join(path, entry), files, dirs);
    }
    return;
  }
  if (stats.isFile()) {
    files.set(path, readFileSync(path));
  }
}

/** The state of `paths` right now, enough to restore it exactly. */
export function captureScaffold(root: string, paths: readonly string[]): ScaffoldUndo {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  for (const path of paths) {
    for (let dir = dirname(path); dir.startsWith(root) && dir !== root; dir = dirname(dir)) {
      if (existsSync(dir)) {
        dirs.add(dir);
      }
    }
    record(path, files, dirs);
  }
  return { root, paths: [...paths], files, dirs };
}

/** The project as {@link captureScaffold} found it. */
export function restoreScaffold(undo: ScaffoldUndo): void {
  for (const path of undo.paths) {
    removeAdded(path, undo);
  }
  for (const path of undo.paths) {
    pruneAncestors(path, undo);
  }
  for (const [file, contents] of undo.files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
}

function removeAdded(path: string, undo: ScaffoldUndo): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (!undo.files.has(path)) {
      unlinkSync(path);
    }
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(path)) {
    removeAdded(join(path, entry), undo);
  }
  if (!undo.dirs.has(path) && readdirSync(path).length === 0) {
    rmdirSync(path);
  }
}

/** The directories a created file needed, when they were created for it. */
function pruneAncestors(path: string, undo: ScaffoldUndo): void {
  for (
    let dir = dirname(path);
    dir.startsWith(undo.root) && dir !== undo.root;
    dir = dirname(dir)
  ) {
    if (undo.dirs.has(dir)) {
      return;
    }
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}
