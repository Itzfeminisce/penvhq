/**
 * Finding the project a command was typed in.
 *
 * The manifest is the marker, not `penv.config.ts`: the launcher's whole job is
 * to run the engine the project pins, and the manifest is the file that pins it.
 * A checkout whose `node_modules` has never been installed still answers.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MANIFEST_PATH } from "@penvhq/core";

export interface Project {
  /** The directory holding `.penv/`. */
  readonly root: string;
  /** The manifest, absolute. */
  readonly manifestFile: string;
}

const MANIFEST_SEGMENTS = MANIFEST_PATH.split("/");

/** The nearest project at or above `cwd`, or `undefined` outside one. */
export function findProject(cwd: string): Project | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const manifestFile = join(dir, ...MANIFEST_SEGMENTS);
    if (existsSync(manifestFile)) {
      return { root: dir, manifestFile };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
