/**
 * `$PENV_HOME` — the one directory the launcher owns.
 *
 * Engines and extensions are addressed by exact name and exact version, so a
 * machine holds every version any of its projects pins at once and no project's
 * command is ever answered by another project's bytes.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PenvError } from "@penvhq/core";

/** A read-only view of the process environment. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The variable that moves the store off `~/.penv`. */
export const PENV_HOME_VAR = "PENV_HOME";

/** The two things the store holds, and the directory each lives under. */
export type PackageKind = "engines" | "extensions";

/** How the launcher was installed, recorded by the installer that did it. */
export const HOME_META_FILE = "meta.json";

/** Written beside an installed package: the SSRI of the tarball it came from. */
export const INTEGRITY_FILE = ".penv-integrity";

/** The update command for a launcher whose installer recorded nothing. */
export const NPM_UPDATE_COMMAND = "npm install -g penv";

/** The store, from the environment. `~/.penv` unless `$PENV_HOME` says otherwise. */
export function penvHome(env: Environment): string {
  const declared = env[PENV_HOME_VAR];
  if (declared !== undefined && declared.trim() !== "") {
    return resolve(declared);
  }
  return join(homedir(), ".penv");
}

/**
 * Where one exact version lives.
 *
 * The manifest's grammar already refuses a name or a version that could climb
 * out of the store, so the containment check is the second lock rather than the
 * first: this function is also reached from `penv add`, where the name is
 * whatever the user typed.
 */
export function packageDir(home: string, kind: PackageKind, name: string, version: string): string {
  const root = resolve(home);
  const dir = resolve(root, kind, ...name.split("/"), version);
  if (!dir.startsWith(root + sep)) {
    throw new PenvError(
      "PENV_HOME_ESCAPE",
      `\`${name}\` at \`${version}\` resolves to ${dir}, which is outside ${root}`,
      "Name the package exactly as npm does, e.g. `@penvhq/provider-vault`.",
    );
  }
  return dir;
}

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
