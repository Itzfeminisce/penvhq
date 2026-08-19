/**
 * What the launcher alone knows about `$PENV_HOME`: how the installation that
 * created it updates itself, and what it writes beside an installed package.
 *
 * The store's layout — where `$PENV_HOME` is and where one exact version lives —
 * is `@penvhq/core`'s, because the engine reads the same directories the
 * launcher fills.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** How the launcher was installed, recorded by the installer that did it. */
export const HOME_META_FILE = "meta.json";

/** Written beside an installed package: the SSRI of the tarball it came from. */
export const INTEGRITY_FILE = ".penv-integrity";

/** The update command for a launcher whose installer recorded nothing. */
export const NPM_UPDATE_COMMAND = "npm install -g @penvhq/launcher";

/** The advisory record an installer leaves in the store. */
interface LauncherMeta {
  readonly installMethod?: unknown;
  readonly updateCommand?: unknown;
}

/**
 * The command that updates this launcher.
 *
 * Advisory, so it never throws: a store with no `meta.json`, or one holding
 * something unreadable, falls back to the npm form rather than turning a
 * manifest-format refusal into a second failure about a metadata file.
 */
export function launcherUpdateCommand(home: string): string {
  let meta: LauncherMeta;
  try {
    meta = JSON.parse(readFileSync(join(home, HOME_META_FILE), "utf8")) as LauncherMeta;
  } catch {
    return NPM_UPDATE_COMMAND;
  }
  const command = meta?.updateCommand;
  if (typeof command === "string" && command.trim() !== "") {
    return command.trim();
  }
  return NPM_UPDATE_COMMAND;
}
