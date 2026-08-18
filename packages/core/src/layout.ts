/**
 * Where a project keeps what penv manages, and the one answer to "where are the
 * records?".
 *
 * `.penv/` holds two different kinds of thing: `env.ts` (and any injection seam)
 * is the project's code, scaffolded once and then theirs, while everything under
 * `.penv/state/` is penv's. Drawing that line in one module is what lets the
 * safety boundary be a single committed `.gitignore` — and what keeps the tree
 * root from being a string repeated in the CLI, the runtime, and every command
 * that prints a path.
 *
 * `state/` is current state penv manages, never secret history: provider history
 * stays provider-owned.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { OldLayoutError } from "./errors.js";
import { isCodeModule } from "./grammar.js";
import { schemaFileOf, schemaInsideTree } from "./schema-file.js";
import type { PenvConfig } from "./types.js";

/** The project's penv directory, relative to the project root. */
export const PENV_DIR = ".penv";

/** Penv-managed state, relative to the project root, POSIX. */
export const STATE_PATH = `${PENV_DIR}/state`;

/** The parameter tree, relative to the project root, POSIX — the path messages print. */
export const RECORDS_PATH = `${STATE_PATH}/records`;

/** The committed safety boundary for everything under `state/`. */
export const STATE_GITIGNORE_PATH = `${STATE_PATH}/.gitignore`;

/** The committed launcher contract. What it holds is not this module's business. */
export const MANIFEST_PATH = `${STATE_PATH}/manifest.json`;

/** Committed, type-only provider declarations — `extensions/<name>.d.ts`. */
export const EXTENSIONS_PATH = `${STATE_PATH}/extensions`;

const CUTOVER_FILE = "cutover.json";
const ROLLBACK_DIR = "rollback";

/** Adoption recovery state, written when a project cuts over from dotenv. */
export const CUTOVER_PATH = `${STATE_PATH}/${CUTOVER_FILE}`;

/** The ignored, temporary bundle of the dotenv files adoption moved aside. */
export const ROLLBACK_PATH = `${STATE_PATH}/${ROLLBACK_DIR}`;

/** Where in that bundle the moved dotenv files sit, keeping their exact names. */
export const ROLLBACK_DOTENV_PATH = `${ROLLBACK_PATH}/dotenv`;

/** The `.penv/` directory of `projectRoot`, absolute. */
export function penvDir(projectRoot: string): string {
  return resolve(projectRoot, PENV_DIR);
}

/** The `.penv/state/` directory of `projectRoot`, absolute. */
export function stateDir(projectRoot: string): string {
  return resolve(projectRoot, ...STATE_PATH.split("/"));
}

/**
 * The parameter tree of `projectRoot`, absolute — the root every filesystem
 * provider is built at, and the only function that decides where records live.
 */
export function recordsDir(projectRoot: string): string {
  return resolve(projectRoot, ...RECORDS_PATH.split("/"));
}

/** One record's path as the user sees it, from the project root. */
export function recordPath(relativePosix: string): string {
  return `${RECORDS_PATH}/${relativePosix}`;
}

/** The directory name `state/` carries inside `.penv/`. */
const STATE_DIR_NAME = STATE_PATH.slice(PENV_DIR.length + 1);

/**
 * The entries directly under `.penv/` that the pre-`state/` layout kept its
 * records in — namespace folders and value or meta files, sorted.
 *
 * The exclusions are the ones the tree walker already makes: a dotfile was never
 * read as a parameter, a code module is the project's (`env.ts`, a Bun preload
 * seam), and `state/` is the new layout itself. Empty means there is nothing of
 * the old layout left, so this is both the old-layout test and the list
 * `penv migrate` moves.
 */
export function oldLayoutEntries(projectRoot: string, config: PenvConfig): string[] {
  const schema = schemaFileOf(config);
  const prefix = `${PENV_DIR}/`;
  const schemaInPenvDir = schema.startsWith(prefix) ? schema.slice(prefix.length) : undefined;

  let entries: string[];
  try {
    entries = readdirSync(penvDir(projectRoot));
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) =>
        !entry.startsWith(".") &&
        entry !== STATE_DIR_NAME &&
        entry !== schemaInPenvDir &&
        !isCodeModule(entry, config),
    )
    .sort();
}

/**
 * Refuses a project whose records still sit directly under `.penv/`.
 *
 * penv reads one layout. An engine that read both would be a tool with two
 * truths about where a project's values live, so an unmigrated project gets one
 * refusal naming the command that converts it, never a quiet second search path.
 */
export function assertMigrated(projectRoot: string, config: PenvConfig): void {
  if (oldLayoutEntries(projectRoot, config).length > 0) {
    throw new OldLayoutError();
  }
}

/**
 * The safety boundary, byte for byte. `init` writes it and `migrate` writes it,
 * so it is rendered in one place.
 *
 * Invariant 20: value files are never committed; structure, meta, config, the
 * manifest and the generated extension declarations are. The negated directory
 * pattern keeps git descending into namespace folders, which an excluded
 * directory would otherwise hide entirely — and `rollback/` is re-excluded after
 * it, because the adoption bundle is the one directory that never joins the
 * committed set.
 *
 * `cutover.json` is re-excluded for the same reason, out of the `!*.json` that
 * un-ignores meta and the manifest: it names this machine's rollback bundle, and
 * a teammate who cloned it would be told a migration they never ran is still
 * unresolved — `penv init` refused, `penv init undo` offering to restore files
 * that are not there.
 *
 * The schema is un-ignored by name only when it lives in the tree. Outside it,
 * this file has no opinion on it at all, and a `!env.ts` naming nothing is a
 * line the next reader has to work out is dead.
 */
export function renderStateGitignore(config: PenvConfig): string {
  const inside = schemaInsideTree(config);
  const listed = inside === undefined ? "" : `${inside}, `;
  return (
    `# Written by penv. Value files hold configuration values and are never\n` +
    `# committed; only the structure, ${listed}meta, the manifest, and the\n` +
    `# generated extension declarations are.\n` +
    `*\n` +
    `!*/\n` +
    `!.gitignore\n` +
    `${inside === undefined ? "" : `!${inside}\n`}` +
    `!*.json\n` +
    `!*.d.ts\n` +
    `/${CUTOVER_FILE}\n` +
    `${ROLLBACK_DIR}/\n`
  );
}
