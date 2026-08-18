/**
 * The committed, type-only declaration an added extension contributes.
 *
 * The adapter lives in `$PENV_HOME` and is loaded only for an explicit provider
 * operation, so the project can never import it — which would leave
 * `penv.config.ts` untyped for exactly the providers it names. This closes that
 * gap the only way a committed file can: by carrying the provider's own config
 * declaration as text, checked to reach for nothing the project does not have.
 *
 * A package points at that declaration with `penv.types` in its `package.json`;
 * one that ships none gets the open base shape under its own name, which is
 * still enough for the `type` field to be checked against something real.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { EXTENSIONS_PATH } from "@penvhq/core";
import { DeclarationMissingError, DeclarationNotSelfContainedError } from "./errors.js";

/** The one module a shipped declaration may reach for: it is the augmentation target. */
const AUGMENTATION_TARGET = "@penvhq/core";

/** `from "x"`, `import "x"`, `import("x")`, `require("x")`, `declare module "x"`. */
const MODULE_SPECIFIER = /(?:\bfrom|\bmodule|\bimport|\brequire)\s*\(?\s*(["'])([^"']*)\1/g;

/** What an extension's `package.json` tells `add`, and nothing more. */
export interface ExtensionPackage {
  /** The package's own name, which is what identifies the directory as its own. */
  readonly name: string | undefined;
  /** The package's own version. Only a local add reads it; a release pins the registry's. */
  readonly version: string | undefined;
  /** A path inside the package to a self-contained declaration file. */
  readonly types: string | undefined;
  /** The engine command that finishes setting this provider up, e.g. `cloud login`. */
  readonly onboard: string | undefined;
}

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null && Object.hasOwn(source, key)
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The `penv` block of an installed package. Advisory, so a package without one —
 * or with an unreadable `package.json` — declares nothing rather than failing an
 * install that already succeeded.
 */
export function readExtensionPackage(dir: string): ExtensionPackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return { name: undefined, version: undefined, types: undefined, onboard: undefined };
  }
  const penv = field(parsed, "penv");
  return {
    name: text(field(parsed, "name")),
    version: text(field(parsed, "version")),
    types: text(field(penv, "types")),
    onboard: text(field(penv, "onboard")),
  };
}

export interface DeclarationSubject {
  readonly name: string;
  readonly version: string;
  /** Recorded in the header: what npm knew about where these bytes came from. */
  readonly attested: boolean;
  /** The package is this project's own, resolved from it rather than pinned. */
  readonly local?: boolean;
}

function header(subject: DeclarationSubject): string {
  const local = subject.local === true;
  const provenance = local
    ? "resolved from this project, not from a published release"
    : subject.attested
      ? "npm records a provenance attestation for it"
      : "npm records no provenance attestation for it";
  return (
    `// Written by \`penv add ${local ? "--local " : ""}${subject.name}\`, and committed.\n` +
    `// ${subject.name} ${subject.version} — ${provenance}.\n` +
    "//\n" +
    "// Types only: this declares the shape of the provider's `penv.config.ts`\n" +
    "// entry. It holds no adapter code, no credentials, and no values.\n"
  );
}

/** The shape a package that ships no declaration of its own still gets. */
function openShape(name: string): string {
  return (
    `import type { ProviderConfig } from "${AUGMENTATION_TARGET}";\n` +
    "\n" +
    `declare module "${AUGMENTATION_TARGET}" {\n` +
    "  interface ProviderConfigMap {\n" +
    `    ${JSON.stringify(name)}: ProviderConfig & { readonly type: ${JSON.stringify(name)} };\n` +
    "  }\n" +
    "}\n"
  );
}

/**
 * A shipped declaration is committed verbatim or not at all.
 *
 * It is about to live in a repository where the package it came from is not
 * installed, so a specifier pointing anywhere else resolves to nothing and turns
 * a helpful type into a broken build in someone else's checkout.
 */
function assertSelfContained(name: string, file: string, source: string): void {
  MODULE_SPECIFIER.lastIndex = 0;
  for (;;) {
    const match = MODULE_SPECIFIER.exec(source);
    if (match === null) {
      return;
    }
    const specifier = match[2] ?? "";
    if (specifier !== AUGMENTATION_TARGET) {
      throw new DeclarationNotSelfContainedError(name, file, specifier);
    }
  }
}

/** The declaration's text: the package's own, or the open shape under its name. */
export function renderDeclaration(
  subject: DeclarationSubject,
  shipped?: { readonly file: string; readonly source: string },
): string {
  if (shipped === undefined) {
    return `${header(subject)}\n${openShape(subject.name)}`;
  }
  assertSelfContained(subject.name, shipped.file, shipped.source);
  const body = shipped.source.replace(/^﻿/, "").trimEnd();
  return `${header(subject)}\n${body}\n`;
}

/** The declared file's text, from inside the installed package and nowhere else. */
function readShipped(name: string, dir: string, declared: string): string {
  const root = resolve(dir);
  const file = resolve(root, ...declared.split("/"));
  if (!file.startsWith(root + sep)) {
    throw new DeclarationMissingError(name, declared);
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new DeclarationMissingError(name, declared);
  }
}

/** Where one extension's declaration lives, relative to the project root, POSIX. */
export function declarationPath(name: string): string {
  return `${EXTENSIONS_PATH}/${name}.d.ts`;
}

export interface WriteDeclarationOptions extends DeclarationSubject {
  readonly root: string;
  /** The installed package directory, read for the declaration it ships. */
  readonly dir: string;
  readonly types: string | undefined;
}

/** Writes the declaration and answers with the path a message prints. */
export function writeDeclaration(options: WriteDeclarationOptions): string {
  const relative = declarationPath(options.name);
  const file = join(options.root, ...relative.split("/"));

  let shipped: { file: string; source: string } | undefined;
  if (options.types !== undefined) {
    shipped = {
      file: options.types,
      source: readShipped(options.name, options.dir, options.types),
    };
  }

  const text = renderDeclaration(options, shipped);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return relative;
}
