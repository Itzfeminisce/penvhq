/**
 * Finding the project a command was typed in.
 *
 * The manifest is the marker, not `penv.config.ts`: the launcher's whole job is
 * to run the engine the project pins, and the manifest is the file that pins it.
 * A checkout whose `node_modules` has never been installed still answers.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_PATH, stateDir } from "@penvhq/core";

export interface Project {
  /** The directory holding `.penv/`. */
  readonly root: string;
  /** The manifest, absolute. */
  readonly manifestFile: string;
}

const MANIFEST_SEGMENTS = MANIFEST_PATH.split("/");

function findUp(cwd: string, matches: (dir: string) => boolean): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (matches(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** The nearest project at or above `cwd`, or `undefined` outside one. */
export function findProject(cwd: string): Project | undefined {
  const root = findUp(cwd, (dir) => existsSync(join(dir, ...MANIFEST_SEGMENTS)));
  return root === undefined ? undefined : { root, manifestFile: join(root, ...MANIFEST_SEGMENTS) };
}

/**
 * The project a delegated `init` or `migrate` left behind, recognised by the
 * state directory rather than the manifest it does not have yet.
 *
 * A command that previewed and wrote nothing leaves none, which is what keeps a
 * `penv migrate` typed in an ordinary directory from being handed a manifest.
 */
export function findAdoptedRoot(cwd: string): string | undefined {
  return findUp(cwd, (dir) => existsSync(stateDir(dir)));
}
