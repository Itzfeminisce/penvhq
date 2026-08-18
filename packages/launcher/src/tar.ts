/**
 * The npm tarball reader.
 *
 * An npm package is a gzipped ustar archive whose every path begins `package/`,
 * so this reads exactly that and refuses everything else: no symlinks, no
 * hardlinks, no absolute paths, no `..`, nothing outside `package/`. The
 * checksum in each header is not verified because the SSRI over the whole
 * tarball already was, before a single block was read.
 */

import { gunzipSync } from "node:zlib";
import { ArchiveError } from "./errors.js";

/** One regular file, at its path relative to the package root. */
export interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The package a refusal names. */
export interface ArchiveSubject {
  readonly name: string;
  readonly version: string;
}

const BLOCK = 512;
const NAME = { start: 0, length: 100 };
const SIZE = { start: 124, length: 12 };
const TYPE_FLAG = 156;
const PREFIX = { start: 345, length: 155 };
const ROOT = "package/";

function text(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end)).trim();
}

function octal(block: Uint8Array, start: number, length: number): number {
  const value = text(block, start, length);
  return value === "" ? 0 : Number.parseInt(value, 8);
}

/** The `path` record of a pax header, which is how a long name arrives. */
function paxPath(data: Uint8Array): string | undefined {
  for (const record of new TextDecoder().decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * The path an entry is written to, relative to the destination.
 *
 * Every refusal here is the same refusal — an archive that would write outside
 * the directory penv extracts into — so they carry one code and name the entry.
 */
function safePath(raw: string, subject: ArchiveSubject): string {
  if (!raw.startsWith(ROOT)) {
    throw new ArchiveError(subject.name, subject.version, raw);
  }
  const path = raw.slice(ROOT.length);
  const segments = path.split("/");
  if (
    path === "" ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === ".." || segment === "")
  ) {
    throw new ArchiveError(subject.name, subject.version, raw);
  }
  return path;
}

/** Every regular file in an npm tarball, `package/` stripped. */
export function readTarball(gzipped: Uint8Array, subject: ArchiveSubject): TarEntry[] {
  const archive = new Uint8Array(gunzipSync(gzipped));
  const entries: TarEntry[] = [];
  let override: string | undefined;

  for (let offset = 0; offset + BLOCK <= archive.length; offset += BLOCK) {
    const header = archive.subarray(offset, offset + BLOCK);
    const name = text(header, NAME.start, NAME.length);
    if (name === "") {
      break;
    }
    const size = octal(header, SIZE.start, SIZE.length);
    const dataStart = offset + BLOCK;
    // A size that is not a whole count of bytes inside this archive is refused
    // rather than clamped: NaN or a negative walked the offset off the end and
    // returned the entries read so far, which is a truncated package that passed.
    if (!Number.isSafeInteger(size) || size < 0 || dataStart + size > archive.length) {
      throw new ArchiveError(subject.name, subject.version, name);
    }
    const flag = String.fromCharCode(header[TYPE_FLAG] ?? 0);
    const data = archive.subarray(dataStart, dataStart + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "x" || flag === "g") {
      override = paxPath(data) ?? override;
      continue;
    }
    const prefix = text(header, PREFIX.start, PREFIX.length);
    const raw = override ?? (prefix === "" ? name : `${prefix}/${name}`);
    override = undefined;

    // Directories are implied by the files written into them, so a directory
    // entry produces nothing and needs no path check.
    if (flag === "5") {
      continue;
    }
    if (flag !== "0" && flag !== "\0") {
      throw new ArchiveError(subject.name, subject.version, raw);
    }
    entries.push({ path: safePath(raw, subject), bytes: new Uint8Array(data) });
  }

  return entries;
}
