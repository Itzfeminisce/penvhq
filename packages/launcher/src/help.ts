/**
 * The half of `penv --help` that is the launcher's.
 *
 * `install`, `add` and `upgrade` are launcher commands: they never reach the
 * engine, so the engine's help — which is citty's, generated from the commands it
 * actually has — cannot list them, and used to leave `penv --help` naming
 * twenty-one commands while refusals told the reader to run a twenty-second.
 * `penv add --help` was refused outright, under a root help that promised
 * `penv <command> --help`.
 *
 * The engine's help is not touched. The launcher prints its own section after the
 * engine's, so what a reader sees is one page whose two halves each come from the
 * program that owns them and neither describes the other.
 */

import { RUNTIME_PACKAGE } from "@penvhq/cli/install";
import { ENGINE_PACKAGE, EXTENSIONS_PATH, MANIFEST_PATH } from "@penvhq/core";
import {
  INSTALL_COMMAND,
  LOCAL_FLAG,
  MIN_PACKAGE_AGE_DAYS,
  TRUST_YOUNG_FLAG,
  YES_FLAG,
} from "./errors.js";
import type { LauncherIo } from "./io.js";

/** The section that joins the engine's help, so the page lists every penv command. */
export function printLauncherCommands(io: LauncherIo): void {
  io.out("");
  io.out("LAUNCHER COMMANDS (penv itself, whatever engine a project pins)");
  io.out("");
  io.out(`  install                Installs everything ${MANIFEST_PATH} pins`);
  io.out("  add <package>          Pins a provider extension, and commits the decision");
  io.out(`  add ${LOCAL_FLAG} <package>  Adds the one this repository builds — nothing is pinned`);
  io.out(`  upgrade [version]      Moves the engine pin and ${RUNTIME_PACKAGE} together`);
  io.out("");
}

/** `penv install --help`. */
export function printInstallHelp(io: LauncherIo): void {
  io.out(`${INSTALL_COMMAND}`);
  io.out("");
  io.out(`Downloads, verifies and installs every version ${MANIFEST_PATH} pins — the engine and`);
  io.out("every extension — into $PENV_HOME. The one penv command CI and production run that");
  io.out("may reach the registry.");
}

/** `penv add --help`. */
export function printAddHelp(io: LauncherIo): void {
  io.out("penv add <package>[@<version>]");
  io.out("");
  io.out(`  ${LOCAL_FLAG}            Add the package this repository builds, resolved from it`);
  io.out("  --registry <url>   Take the release from a private registry instead of npmjs");
  io.out(
    `  ${TRUST_YOUNG_FLAG}      Add a release published less than ${MIN_PACKAGE_AGE_DAYS} days ago`,
  );
  io.out("");
  io.out(`Pins the release in ${MANIFEST_PATH} and writes its type declaration to`);
  io.out(`${EXTENSIONS_PATH}/. Both are committed, so \`${INSTALL_COMMAND}\` gives every machine`);
  io.out(`the bytes you reviewed. \`${LOCAL_FLAG}\` pins nothing and touches no manifest.`);
}

/** `penv upgrade --help`. */
export function printUpgradeHelp(io: LauncherIo): void {
  io.out("penv upgrade [version]");
  io.out("");
  io.out(`  ${YES_FLAG}              Skip the question — unattended runs need it and a version`);
  io.out("");
  io.out(`Moves the ${ENGINE_PACKAGE} pin in ${MANIFEST_PATH} and this project's`);
  io.out(`${RUNTIME_PACKAGE} dependency to the same exact version. No version takes whatever`);
  io.out("`latest` points at; the integrity is the one the registry states, never one penv");
  io.out("computed. Both files are shown before either moves, and they move together or not");
  io.out("at all. Extensions keep their own pins.");
}
