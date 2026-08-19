/**
 * `$PENV_HOME` — the store the launcher fills and the engine reads.
 *
 * It lives in core because both halves of penv address it: `penv add` installs
 * the bytes a manifest pins into it, and the engine loads the extension back out
 * of it. Two implementations of "where does this exact version live" would be two
 * stores, and the second one would be the one nobody's `penv install` filled.
 *
 * Engines and extensions are addressed by exact name and exact version, so a
 * machine holds every version any of its projects pins at once and no project's
 * command is ever answered by another project's bytes.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { PenvError } from "./errors.js";

/** A read-only view of the process environment. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The variable that moves the store off `~/.penv`. */
export const PENV_HOME_VAR = "PENV_HOME";

/** The two things the store holds, and the directory each lives under. */
export type PackageKind = "engines" | "extensions";

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
 *
 * Containment is measured against the bucket, not against `$PENV_HOME`. A name
 * of `../extensions/x` stays inside the store while landing an engine among the
 * extensions, and a store where the two are not separated is a store where the
 * kind a caller asked for is not the kind it gets.
 */
export function packageDir(home: string, kind: PackageKind, name: string, version: string): string {
  const bucket = resolve(home, kind);
  const dir = resolve(bucket, ...name.split("/"), version);
  if (!dir.startsWith(bucket + sep)) {
    throw new PenvError(
      "PENV_HOME_ESCAPE",
      `\`${name}\` at \`${version}\` resolves to ${dir}, which is outside ${bucket}`,
      "Name the package exactly as npm does, e.g. `@penvhq/provider-vault`.",
    );
  }
  return dir;
}

/**
 * What Node's ESM loader takes as written. penv imports an extension with a bare
 * dynamic `import()` and no transform, so a package whose entry is TypeScript
 * source is a package penv cannot load, however well it compiles elsewhere.
 */
const IMPORTABLE = new Set([".js", ".mjs", ".cjs", ".node"]);

/** Whether `import()` can take this file as it stands. */
export function isImportableEntry(file: string): boolean {
  return IMPORTABLE.has(extname(file).toLowerCase());
}

/** The entry an extension package declares, and whether penv can import it. */
export interface PackageEntry {
  /** The file the package's own `exports` or `main` names, absolute. */
  readonly file: string;
  /** False when that file is missing, or is not something `import()` takes. */
  readonly importable: boolean;
}

/**
 * The conditions penv resolves an extension under, in order.
 *
 * penv loads a provider with `import()`, so `require` is not among them — a
 * package that ships a CJS build under `require` and TypeScript source under
 * `import` must be answered with the file the loader will actually be handed.
 */
const IMPORT_CONDITIONS = ["node", "import", "default"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  for (const condition of IMPORT_CONDITIONS) {
    const picked = pickCondition(value[condition]);
    if (picked !== undefined) {
      return picked;
    }
  }
  return undefined;
}

/** The `.` subpath of an `exports` field, whichever of its two shapes it is in. */
function mainExport(exports: unknown): string | undefined {
  if (typeof exports === "string") {
    return exports;
  }
  if (!isPlainObject(exports)) {
    return undefined;
  }
  return Object.keys(exports).some((key) => key.startsWith("."))
    ? pickCondition(exports["."])
    : pickCondition(exports);
}

function stringField(source: unknown, key: string): string | undefined {
  if (!isPlainObject(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The entry point of a package that sits alone in a directory, read from its own
 * `package.json`.
 *
 * A store directory is one extracted tarball and nothing else — no
 * `node_modules` above it and no bare specifier for Node to resolve — so the
 * package's own declaration is the only thing that can answer where its entry
 * is. `undefined` means the directory holds no readable `package.json`, or names
 * an entry outside itself.
 */
export function packageEntry(dir: string): PackageEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const declared =
    mainExport(isPlainObject(parsed) ? parsed.exports : undefined) ??
    stringField(parsed, "main") ??
    "index.js";
  const root = resolve(dir);
  const file = resolve(root, ...declared.split("/"));
  if (!file.startsWith(root + sep)) {
    return undefined;
  }
  return { file, importable: isImportableEntry(file) && existsSync(file) };
}
