/**
 * Turning an installed directory into something to run.
 *
 * The engine that ships with the launcher and the engine a project pins are the
 * same kind of thing — a package directory with a `bin` — so there is one
 * resolver and one spawn path, and `penv init` outside a project takes exactly
 * the route `penv get` takes inside one.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ENGINE_PACKAGE, PenvError } from "@penvhq/core";
import { EngineEntryError } from "./errors.js";

/** The bin name the engine publishes. `penv` itself belongs to the launcher. */
export const ENGINE_BIN = "penv-engine";

export interface Engine {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  /** The JS file to hand to node, absolute. */
  readonly entry: string;
}

interface PackageManifest {
  readonly version?: unknown;
  readonly bin?: unknown;
}

function readPackageManifest(dir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function binPath(bin: unknown): string | undefined {
  if (typeof bin === "string") {
    return bin;
  }
  if (typeof bin !== "object" || bin === null) {
    return undefined;
  }
  const entries = Object.entries(bin as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const named = entries.find(([name]) => name === ENGINE_BIN);
  const chosen = named ?? (entries.length === 1 ? entries[0] : undefined);
  return chosen?.[1];
}

/** The engine installed at `dir`, or the refusal that says it is not runnable. */
export function engineAt(dir: string, name: string, version: string): Engine {
  const manifest = readPackageManifest(dir);
  const bin = manifest === undefined ? undefined : binPath(manifest.bin);
  const entry = bin === undefined ? undefined : resolve(dir, bin);
  if (entry === undefined || !existsSync(entry)) {
    throw new EngineEntryError(name, version, dir);
  }
  return { name, version, dir, entry };
}

/**
 * The engine that shipped with this launcher — the one that runs `init` in a
 * directory that is not a project yet.
 *
 * It is resolved rather than bundled: a launcher installed from npm gets the
 * engine as a dependency, which is what makes it a package directory with a
 * `bin` like every other engine in the store.
 */
export function bundledEngine(): Engine {
  const require = createRequire(import.meta.url);
  let manifestFile: string;
  try {
    manifestFile = require.resolve(`${ENGINE_PACKAGE}/package.json`);
  } catch {
    throw new PenvError(
      "PENV_NO_BUNDLED_ENGINE",
      `This penv installation is missing ${ENGINE_PACKAGE}, the engine it runs \`init\` with`,
      "Reinstall the launcher with `npm install -g penv`.",
    );
  }
  const dir = dirname(manifestFile);
  const version = readPackageManifest(dir)?.version;
  return engineAt(dir, ENGINE_PACKAGE, typeof version === "string" ? version : "unknown");
}
