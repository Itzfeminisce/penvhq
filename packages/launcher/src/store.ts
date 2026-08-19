/**
 * The store: what is installed, and how something absent gets installed.
 *
 * An installed package carries the SSRI of the tarball it came from, written
 * beside it at install time, so every later run compares the manifest's pin
 * against a recorded answer instead of re-hashing a directory that would never
 * hash to an npm integrity anyway. Three states, and only three: the bytes the
 * manifest pins, no bytes, or bytes that are not the ones pinned.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type PackageKind, packageDir } from "@penvhq/core";
import { DownloadFailedError, DownloadIntegrityError } from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import { INTEGRITY_FILE } from "./home.js";
import { integrityOf } from "./integrity.js";
import { readTarball } from "./tar.js";

/** One exact thing the manifest names. */
export interface Pin {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  /** Only when the package comes from somewhere other than npmjs. */
  readonly registry?: string;
}

/** Where penv looks when a pin names no registry. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type InstallState = "installed" | "absent" | "corrupt";

export interface Installation {
  readonly dir: string;
  readonly state: InstallState;
}

/** npm's tarball address, which an exact version can be built rather than looked up. */
export function tarballUrl(pin: Pin): string {
  const registry = (pin.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const basename = pin.name.slice(pin.name.lastIndexOf("/") + 1);
  return `${registry}/${pin.name}/-/${basename}-${pin.version}.tgz`;
}

/** What this machine holds for one pin. */
export function inspectInstall(home: string, kind: PackageKind, pin: Pin): Installation {
  const dir = packageDir(home, kind, pin.name, pin.version);
  if (!existsSync(dir)) {
    return { dir, state: "absent" };
  }
  let recorded: string;
  try {
    recorded = readFileSync(join(dir, INTEGRITY_FILE), "utf8").trim();
  } catch {
    return { dir, state: "corrupt" };
  }
  return { dir, state: recorded === pin.integrity ? "installed" : "corrupt" };
}

export interface InstallOptions {
  readonly home: string;
  readonly kind: PackageKind;
  readonly pin: Pin;
  readonly fetcher: Fetcher;
}

/**
 * Downloads one pin, verifies it, and installs it — in that order, and never a
 * different one.
 *
 * The extraction happens in a staging directory and arrives by rename, so an
 * interrupted install leaves nothing that a later run could read as installed.
 */
export async function installPin(options: InstallOptions): Promise<string> {
  const { home, kind, pin, fetcher } = options;
  const dir = packageDir(home, kind, pin.name, pin.version);
  const url = tarballUrl(pin);

  let bytes: Uint8Array;
  try {
    bytes = await fetcher.get(url);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new DownloadFailedError(pin.name, pin.version, url, detail);
  }
  if (integrityOf(bytes) !== pin.integrity) {
    throw new DownloadIntegrityError(pin.name, pin.version, url);
  }

  const entries = readTarball(bytes, pin);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${pin.version}-`));
  try {
    for (const entry of entries) {
      const file = join(staging, ...entry.path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entry.bytes);
    }
    writeFileSync(join(staging, INTEGRITY_FILE), `${pin.integrity}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return dir;
}
