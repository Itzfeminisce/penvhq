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

import { readFileSync } from "node:fs";
import type { Manifest } from "@penvhq/core";
import { PenvError, parseManifest, UnsupportedManifestFormatError } from "@penvhq/core";
import type { Spawner } from "./delegate.js";
import { type Engine, engineAt } from "./engine.js";
import {
  InstallDeclinedError,
  NoProjectError,
  PackageCorruptError,
  PackageMissingError,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import {
  type Environment,
  launcherUpdateCommand,
  type PackageKind,
  PENV_HOME_VAR,
  penvHome,
} from "./home.js";
import { findProject } from "./project.js";
import { inspectInstall, installPin, type Pin } from "./store.js";

/** Where the launcher writes, and how it asks the one question it asks. */
export interface LauncherIo {
  out(line: string): void;
  err(line: string): void;
  /** Whether a human is at the other end of the streams. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
}

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
}

/** The launcher's own commands. Everything else belongs to the engine. */
const INSTALL = "install";
const VERSION_FLAGS = new Set(["--version", "-v"]);
const HELP_FLAGS = new Set(["--help", "-h"]);
const NO_DOWNLOAD = "--no-download";

/** What runs outside a project, on the engine that shipped with the launcher. */
const OUTSIDE_PROJECT = new Set(["init"]);

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
 * The manifest, and the one refusal that admits penv is two programs.
 *
 * Core writes that error; the launcher is the only place that knows how this
 * installation updates and what the user typed, so it fills both in here.
 */
function readManifest(manifestFile: string, home: string, argv: readonly string[]): Manifest {
  const text = readFileSync(manifestFile, "utf8");
  try {
    return parseManifest(text);
  } catch (error) {
    if (error instanceof UnsupportedManifestFormatError) {
      throw error.withLauncherUpdate({
        updateCommand: launcherUpdateCommand(home),
        invokedCommand: invokedCommand(argv),
      });
    }
    throw error;
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
  const project = findProject(cwd);

  if (project === undefined) {
    if (first !== undefined && VERSION_FLAGS.has(first)) {
      io.out(`penv ${options.bundledEngine().version}`);
      return 0;
    }
    if (first === undefined || HELP_FLAGS.has(first) || OUTSIDE_PROJECT.has(first)) {
      return delegate(options, options.bundledEngine(), forwarded, home, cwd);
    }
    throw new NoProjectError(cwd);
  }

  const manifest = readManifest(project.manifestFile, home, argv);
  if (first !== undefined && VERSION_FLAGS.has(first)) {
    io.out(`penv ${manifest.engine.version}`);
    return 0;
  }

  if (first === INSTALL) {
    return install(options, pinsOf(manifest), home);
  }

  const enginePin = enginePinOf(manifest);
  const engineDir = await ensure(options, "engines", enginePin, home, noDownload);
  for (const pin of extensionPinsOf(manifest)) {
    await ensure(options, "extensions", pin, home, noDownload);
  }
  const engine = engineAt(engineDir, enginePin.name, enginePin.version);
  return delegate(options, engine, forwarded, home, cwd);
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

/** `penv install`: the preinstall step, which is the one command that may download. */
async function install(
  options: LauncherOptions,
  pins: readonly PinnedPackage[],
  home: string,
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
  return 0;
}

/**
 * The child gets the resolved store, because the engine loads the extensions the
 * launcher just verified out of it and the two must not disagree about where it
 * is. Everything else about the environment is the user's.
 */
function delegate(
  options: LauncherOptions,
  engine: Engine,
  forwarded: readonly string[],
  home: string,
  cwd: string,
): Promise<number> {
  return options.spawn({
    command: process.execPath,
    args: [engine.entry, ...forwarded],
    cwd,
    env: { ...options.env, [PENV_HOME_VAR]: home },
  });
}
