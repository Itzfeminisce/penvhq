/**
 * The launcher protocol.
 *
 * One question is asked on every invocation — which penv is this project's — and
 * everything here is the answer to it: find the manifest, read only the format
 * it declares, prove the pinned bytes are on this machine, hand the command
 * over. The launcher parses `--no-download` and `--version` and nothing else;
 * every other token is the engine's business and crosses untouched.
 *
 * Downloading is the one behavior that differs by where penv is running. CI and
 * production never download during a run — they refuse and name the command that
 * installs — because a production start that is also a network event is a
 * production start that can fail for a reason nobody chose.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment, Manifest, ManifestEngine, PackageKind } from "@penvhq/core";
import {
  MANIFEST_FORMAT,
  MANIFEST_PATH,
  PENV_HOME_VAR,
  PenvError,
  parseManifest,
  penvHome,
  serializeManifest,
  UnsupportedManifestFormatError,
} from "@penvhq/core";
import { add } from "./add.js";
import type { Spawner } from "./delegate.js";
import { type Engine, engineAt } from "./engine.js";
import {
  INSTALL_COMMAND,
  InstallDeclinedError,
  ManifestEntriesUnreadableError,
  NoProjectError,
  PackageCorruptError,
  PackageMissingError,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import { printAddHelp, printInstallHelp, printLauncherCommands, printUpgradeHelp } from "./help.js";
import { launcherUpdateCommand } from "./home.js";
import type { LauncherIo } from "./io.js";
import { releaseEnginePin } from "./pins.js";
import type { Project } from "./project.js";
import { findAdoptedRoot, findProject } from "./project.js";
import { type RepairableManifest, readManifestForRepair } from "./repair.js";
import { inspectInstall, installPin, type Pin } from "./store.js";
import { upgrade } from "./upgrade.js";

export interface LauncherOptions {
  /** The command line, minus the executable — `process.argv.slice(2)`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Environment;
  readonly io: LauncherIo;
  readonly fetcher: Fetcher;
  readonly spawn: Spawner;
  /** The engine that shipped with this launcher, resolved only when it is needed. */
  readonly bundledEngine: () => Engine;
  /** That engine's published identity, embedded at release time. */
  readonly bundledPin: ManifestEngine;
}

/** The launcher's own commands. Everything else belongs to the engine. */
const INSTALL = "install";
const ADD = "add";
const UPGRADE = "upgrade";
const VERSION_FLAGS = new Set(["--version", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const NO_DOWNLOAD = "--no-download";

/** What runs outside a project, on the engine that shipped with the launcher — and leaves one behind. */
const ADOPTS = new Set(["init", "migrate"]);

interface PinnedPackage {
  readonly kind: PackageKind;
  readonly pin: Pin;
}

/**
 * `--no-download` leads, or it is the engine's.
 *
 * The launcher owns the tokens before the command name and nothing after it, so
 * a flag the engine also understands can never be eaten here, and what the
 * engine receives is what the user typed.
 */
function splitLauncherFlags(argv: readonly string[]): {
  noDownload: boolean;
  forwarded: readonly string[];
} {
  let index = 0;
  let noDownload = false;
  while (argv[index] === NO_DOWNLOAD) {
    noDownload = true;
    index += 1;
  }
  return { noDownload, forwarded: argv.slice(index) };
}

/** The command the user ran, replayed so a refusal can tell them to run it again. */
function invokedCommand(argv: readonly string[]): string {
  const parts = argv.map((token) => (/\s/.test(token) ? JSON.stringify(token) : token));
  return ["penv", ...parts].join(" ");
}

function isCi(env: Environment): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false";
}

/** The engine's pin, which is the one every run needs. */
function enginePinOf(manifest: Manifest): Pin {
  return {
    name: manifest.engine.package,
    version: manifest.engine.version,
    integrity: manifest.engine.integrity,
  };
}

function extensionPinsOf(manifest: Manifest): Pin[] {
  return Object.entries(manifest.extensions).map<Pin>(([name, entry]) => ({
    name,
    version: entry.version,
    integrity: entry.integrity,
    ...(entry.registry === undefined ? {} : { registry: entry.registry }),
  }));
}

/** Everything the manifest pins, engine first. */
function pinsOf(manifest: Manifest): PinnedPackage[] {
  return [
    { kind: "engines", pin: enginePinOf(manifest) },
    ...extensionPinsOf(manifest).map<PinnedPackage>((pin) => ({ kind: "extensions", pin })),
  ];
}

/**
 * The one refusal that admits penv is two programs, with its blanks filled.
 *
 * Core writes that error; the launcher is the only place that knows how this
 * installation updates and what the user typed.
 */
function reportable(error: unknown, home: string, argv: readonly string[]): unknown {
  return error instanceof UnsupportedManifestFormatError
    ? error.withLauncherUpdate({
        updateCommand: launcherUpdateCommand(home),
        invokedCommand: invokedCommand(argv),
      })
    : error;
}

function readManifest(manifestFile: string, home: string, argv: readonly string[]): Manifest {
  try {
    return parseManifest(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw reportable(error, home, argv);
  }
}

/**
 * The manifest as `install` and `add` read it: every entry that validates, and
 * the names of the ones that do not.
 *
 * These two are the commands every other refusal names as its remedy, so they are
 * the two that must survive the file they are meant to repair. Nothing outside
 * the extension entries is relaxed — the format gate and the engine pin still
 * refuse outright, because an entry repaired in a manifest penv could not run
 * afterwards is not a repair.
 */
function readManifestToRepair(
  manifestFile: string,
  home: string,
  argv: readonly string[],
): RepairableManifest {
  try {
    return readManifestForRepair(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw reportable(error, home, argv);
  }
}

/** A `PenvError` prints as written; anything else is a bug and keeps its stack. */
function report(error: unknown, io: LauncherIo): void {
  if (error instanceof PenvError && error.remedy !== undefined) {
    const suffix = `\n  ${error.remedy}`;
    const message = error.message.endsWith(suffix)
      ? error.message.slice(0, -suffix.length)
      : error.message;
    io.err(`✗ ${message}`);
    io.err(`  → ${error.remedy}`);
    return;
  }
  io.err(`✗ ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
}

export async function runLauncher(options: LauncherOptions): Promise<number> {
  try {
    return await launch(options);
  } catch (error) {
    report(error, options.io);
    return 1;
  }
}

async function launch(options: LauncherOptions): Promise<number> {
  const { argv, cwd, env, io } = options;
  const { noDownload, forwarded } = splitLauncherFlags(argv);
  const first = forwarded[0];
  const home = penvHome(env);

  // The engine has never heard of the launcher's commands, so their help is the
  // launcher's — and it answers outside a project too, where a reader asking
  // what `penv install` is has not adopted one yet.
  if (first !== undefined && forwarded.slice(1).some((token) => HELP_FLAGS.has(token))) {
    if (first === INSTALL) {
      printInstallHelp(io);
      return 0;
    }
    if (first === ADD) {
      printAddHelp(io);
      return 0;
    }
    if (first === UPGRADE) {
      printUpgradeHelp(io);
      return 0;
    }
  }

  const project = findProject(cwd);

  if (project === undefined) {
    if (first !== undefined && VERSION_FLAGS.has(first)) {
      io.out(`penv ${options.bundledEngine().version}`);
      return 0;
    }
    if (first === undefined || HELP_FLAGS.has(first)) {
      return delegate(options, options.bundledEngine(), forwarded, home, cwd);
    }
    if (ADOPTS.has(first)) {
      return adopt(options, forwarded, home, cwd, noDownload);
    }
    throw new NoProjectError(cwd);
  }

  // The two repair commands read the manifest ahead of the strict parse, so a
  // refusal that names one of them leaves that one runnable.
  if (first === INSTALL) {
    const { manifest, broken } = readManifestToRepair(project.manifestFile, home, argv);
    return install(options, pinsOf(manifest), home, broken);
  }

  if (first === ADD) {
    return addExtension(options, project, home, forwarded.slice(1), noDownload);
  }

  const manifest = readManifest(project.manifestFile, home, argv);
  if (first !== undefined && VERSION_FLAGS.has(first)) {
    io.out(`penv ${manifest.engine.version}`);
    return 0;
  }

  // The engine never sees `upgrade`: what it moves is the pin naming which
  // engine to run, and no engine can be the authority on which one that is.
  if (first === UPGRADE) {
    await upgrade({
      argv: forwarded.slice(1),
      root: project.root,
      manifestFile: project.manifestFile,
      manifest,
      home,
      io,
      fetcher: options.fetcher,
      noDownload,
      ci: isCi(env),
    });
    return 0;
  }

  const enginePin = enginePinOf(manifest);
  const engineDir = await ensure(options, "engines", enginePin, home, noDownload);
  for (const pin of extensionPinsOf(manifest)) {
    await ensure(options, "extensions", pin, home, noDownload);
  }
  const engine = engineAt(engineDir, enginePin.name, enginePin.version);
  return delegate(options, engine, forwarded, home, cwd);
}

/**
 * `init` and `migrate` on the bundled engine, and the manifest recording which
 * engine that was.
 *
 * The write belongs here because the pin does: an engine cannot compute the npm
 * integrity of its own tarball, and neither command is allowed a network to go
 * and read it. It happens only after the child succeeds, only where the child
 * left a `.penv/state/` behind — a preview that wrote nothing is not an adoption
 * — and never over a manifest that is already there, whoever wrote it.
 *
 * The pinned engine is put on the machine here too, because adoption closes by
 * telling the developer to run `penv run -- <dev>` and that command needs bytes
 * nothing has fetched yet.
 */
async function adopt(
  options: LauncherOptions,
  forwarded: readonly string[],
  home: string,
  cwd: string,
  noDownload: boolean,
): Promise<number> {
  const engine = options.bundledEngine();
  const code = await delegate(options, engine, forwarded, home, cwd);
  if (code !== 0) {
    return code;
  }

  const root = findAdoptedRoot(cwd);
  if (root === undefined) {
    return 0;
  }
  const manifestFile = join(root, ...MANIFEST_PATH.split("/"));
  if (existsSync(manifestFile)) {
    return 0;
  }

  const pin = releaseEnginePin(options.bundledPin, engine.version);
  writeFileSync(
    manifestFile,
    serializeManifest({ format: MANIFEST_FORMAT, engine: pin, extensions: {} }),
  );
  options.io.out(`✓ ${MANIFEST_PATH} pins ${pin.package} ${pin.version}`);
  await ensureAdoptedEngine(
    options,
    { name: pin.package, version: pin.version, integrity: pin.integrity },
    home,
    noDownload,
  );
  return 0;
}

/**
 * The engine this adoption just pinned, on this machine.
 *
 * Adoption ends with "start your app with `penv run -- …`", and that command
 * refuses until the pinned bytes are in `$PENV_HOME`. So the download is offered
 * while there is still somebody reading — and when there is not, or they decline,
 * the closing message is followed by the one command that makes it true. An
 * adoption that succeeded is not turned into a failure by it: the manifest is
 * written and the exit code stays 0 either way.
 */
async function ensureAdoptedEngine(
  options: LauncherOptions,
  pin: Pin,
  home: string,
  noDownload: boolean,
): Promise<void> {
  try {
    await ensure(options, "engines", pin, home, noDownload);
  } catch (error) {
    // Missing and declined are the two expected answers, and they read as a next
    // step rather than a failure. Anything else — corrupt bytes, a registry that
    // would not answer — is still reported, and still ends at the same command.
    if (!(error instanceof PackageMissingError || error instanceof InstallDeclinedError)) {
      report(error, options.io);
    }
    options.io.out(
      `→ Run \`${INSTALL_COMMAND}\` to install ${pin.name} ${pin.version} before your first \`penv run\`.`,
    );
  }
}

/** The pinned bytes on disk, or the refusal that says why they are not. */
async function ensure(
  options: LauncherOptions,
  kind: PackageKind,
  pin: Pin,
  home: string,
  noDownload: boolean,
): Promise<string> {
  const { io, env, fetcher } = options;
  const { dir, state } = inspectInstall(home, kind, pin);
  if (state === "installed") {
    return dir;
  }
  if (state === "corrupt") {
    throw new PackageCorruptError(pin.name, pin.version, dir);
  }
  if (noDownload || isCi(env) || !io.interactive) {
    throw new PackageMissingError(pin.name, pin.version, home);
  }
  const consented = await io.confirm(
    `penv needs ${pin.name} ${pin.version} for this project. Download and verify it now?`,
  );
  if (!consented) {
    throw new InstallDeclinedError(pin.name, pin.version);
  }
  return installPin({ home, kind, pin, fetcher });
}

/**
 * `penv install`: the preinstall step, which is the one command that may download.
 *
 * Entries it could not read are installed around rather than refused on: the
 * engine and the readable extensions land, and each broken entry is reported with
 * the `penv add` that rewrites it. The exit code is still a failure, because what
 * the manifest names is not all on the machine.
 */
async function install(
  options: LauncherOptions,
  pins: readonly PinnedPackage[],
  home: string,
  broken: readonly string[],
): Promise<number> {
  for (const { kind, pin } of pins) {
    const { dir, state } = inspectInstall(home, kind, pin);
    if (state === "corrupt") {
      throw new PackageCorruptError(pin.name, pin.version, dir);
    }
    if (state === "installed") {
      options.io.out(`✓ ${pin.name} ${pin.version} already installed`);
      continue;
    }
    await installPin({ home, kind, pin, fetcher: options.fetcher });
    options.io.out(`✓ ${pin.name} ${pin.version} installed`);
  }
  if (broken.length > 0) {
    report(new ManifestEntriesUnreadableError(broken), options.io);
    return 1;
  }
  return 0;
}

/**
 * `penv add`: the launcher's command, because everything it writes is the
 * launcher's — the store and the manifest that pins it.
 *
 * The engine is resolved only if the provider's onboarding offer is accepted, so
 * a project can add an extension before its engine has ever been installed.
 */
async function addExtension(
  options: LauncherOptions,
  project: Project,
  home: string,
  argv: readonly string[],
  noDownload: boolean,
): Promise<number> {
  const { onboard } = await add({
    argv,
    root: project.root,
    manifestFile: project.manifestFile,
    home,
    io: options.io,
    fetcher: options.fetcher,
    noDownload,
    ci: isCi(options.env),
  });
  if (onboard === undefined) {
    return 0;
  }
  const enginePin = enginePinOf(readManifest(project.manifestFile, home, options.argv));
  const dir = await ensure(options, "engines", enginePin, home, noDownload);
  const engine = engineAt(dir, enginePin.name, enginePin.version);
  return delegate(options, engine, onboard, home, options.cwd);
}

/** The root help — no command at all, or a help flag before one. */
function isRootHelp(forwarded: readonly string[]): boolean {
  const first = forwarded[0];
  return first === undefined || HELP_FLAGS.has(first);
}

/**
 * The child gets the resolved store, because the engine loads the extensions the
 * launcher just verified out of it and the two must not disagree about where it
 * is. Everything else about the environment is the user's.
 *
 * The root help comes back with the launcher's own commands appended. Neither
 * half describes the other: the engine lists what it can run, and the two
 * commands that never reach it are printed by the program that does run them.
 */
async function delegate(
  options: LauncherOptions,
  engine: Engine,
  forwarded: readonly string[],
  home: string,
  cwd: string,
): Promise<number> {
  const code = await options.spawn({
    command: process.execPath,
    args: [engine.entry, ...forwarded],
    cwd,
    env: { ...options.env, [PENV_HOME_VAR]: home },
  });
  if (code === 0 && isRootHelp(forwarded)) {
    printLauncherCommands(options.io);
  }
  return code;
}
