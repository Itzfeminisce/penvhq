/**
 * `penv import <file>` — adopt an existing dotenv file.
 *
 * Invariant 15: this is one-directional. After it runs, `.penv/` is the source of
 * truth and `.env` is an artifact `penv generate` writes; there is no reverse
 * sync of hand-edits back out of the generated file.
 *
 * Import creates flat parameters. `refFromVariable` never infers a namespace,
 * because a flat `.env` carries no structure to read — `REDIS_PASSWORD` cannot
 * say whether it came from `redis/password` or `redis-password`. Namespacing is
 * a deliberate refactor afterwards, not a guess made during adoption.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { DotenvEntry, Meta, ParameterRef, PenvConfig } from "@penv/core";
import {
  accessPath,
  checkNameCollisions,
  findConfigFile,
  isReservedToken,
  loadConfigFrom,
  PenvError,
  parseDotenv,
  ReservedTokenError,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "@penv/core";
import { defineCommand } from "citty";
import { openProject } from "../project.js";
import { CHECK, formatSteps, guard, type Step, WARN, write } from "../ui.js";
import type { InitStep, SchemaField } from "./init.js";
import { scaffold, writeConfigFile } from "./init.js";
import type { ValidateResult } from "./validate.js";
import { renderValidate, runValidate } from "./validate.js";

export interface ImportOptions {
  readonly cwd: string;
  /** The dotenv file to adopt, absolute or relative to `cwd`. */
  readonly file: string;
}

export interface ImportReport {
  readonly root: string;
  readonly file: string;
  readonly backup: string;
  readonly variables: number;
  /**
   * Comment blocks that belonged to no variable. Reported rather than discarded
   * silently: a file header has no parameter to describe, but that is not a
   * reason to pretend it was never there.
   */
  readonly orphanComments: number;
  readonly steps: readonly InitStep[];
}

const BACKUP_SUFFIX = ".backup";

/** A URL of any scheme — `postgres://` is as much a URL as `https://`. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The Zod expression for one sampled value. Values arrive as strings, so a
 * schema that must accept them declares the coercion: `z.boolean()` would reject
 * the string `"true"` this very file just imported.
 */
function inferType(value: string): string {
  if (URL_LIKE.test(value)) {
    return "z.url()";
  }
  if (/^(true|false)$/i.test(value)) {
    return "z.stringbool()";
  }
  if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return "z.coerce.number()";
  }
  return "z.string()";
}

/** Sorted, so the draft is identical on every machine. */
export function draftFields(entries: readonly DotenvEntry[]): SchemaField[] {
  return entries
    .map((entry) => {
      const key = accessPath(refFromVariable(entry.key)).join(".");
      return {
        key: IDENTIFIER.test(key) ? key : JSON.stringify(key),
        type: inferType(entry.value),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Filenames are split on `.`, so a variable that becomes a dotted name would
 * parse back as a scope segment rather than the parameter it came from.
 */
function assertImportable(ref: ParameterRef, variable: string): void {
  if (!ref.name.includes(".")) {
    return;
  }
  throw new PenvError(
    "IMPORT_UNPARSEABLE_NAME",
    `The variable ${variable} becomes the parameter \`${ref.name}\`, whose \`.\` would be read as a scope`,
    `Filenames are split on \`.\`. Rename ${variable} in the source file, then import it again.`,
  );
}

/**
 * Invariant 11: `enc`, `json`, `toml`, `yml`, `local`, and every declared
 * environment are reserved, and a collision is an error rather than a warning.
 *
 * A written `.penv/enc` does not merely import badly — it re-parses as a scope
 * segment, so every later `list()` throws and `get`, `generate`, `validate`, and
 * even `remove` stop working. The project can only be repaired by deleting the
 * file by hand, which is why this runs before anything is written rather than
 * leaving `penv validate` to report the wreckage afterwards.
 *
 * The error names the *variable*, not the parameter: the user is reading their
 * `.env`, where the line says `ENC=`, and `enc` is penv's word for it.
 */
function assertNotReserved(
  ref: ParameterRef,
  variable: string,
  where: string,
  config: PenvConfig,
): void {
  if (isReservedToken(ref.name, config)) {
    throw new ReservedTokenError("parameter", variable, where);
  }
}

/**
 * The v0.1 gate: every variable survives `import` then `generate` unchanged,
 * *modulo declared name overrides*.
 *
 * `MY-VAR` imports to the parameter `my-var` and regenerates as `MY_VAR`, so the
 * application's `process.env["MY-VAR"]` reads `undefined` after a round trip. A
 * flat `.env` cannot tell `MY-VAR` from `MY_VAR` once both collapse to one
 * parameter, so no escape scheme rescues it — the honest move is to refuse. An
 * explicit `names` override is the exception the gate allows: it makes the
 * generated name a stated decision instead of an accident. Silence does not.
 */
function assertRoundTrips(ref: ParameterRef, variable: string, config: PenvConfig): void {
  if (roundTripsCleanly(variable)) {
    return;
  }
  // The declared override the gate's "modulo" clause means. Checked against the
  // real transform, so an override that does not actually restore the variable
  // is not mistaken for one that does.
  if (variableName(ref, config) === variable) {
    return;
  }
  const generated = variableName(ref, config);
  throw new PenvError(
    "IMPORT_LOSSY_NAME",
    `The variable ${variable} becomes the parameter \`${ref.name}\`, which regenerates as ${generated}`,
    `\`penv generate\` would write ${generated}, so anything reading ` +
      `\`process.env["${variable}"]\` would read \`undefined\`. Declare the name you want in the ` +
      `\`names\` block of penv.config.ts — \`names: { "${ref.name}": "${variable}" }\` — then ` +
      `import it again. Nothing was imported.`,
  );
}

function collisionsIn(refs: readonly ParameterRef[], config: PenvConfig): void {
  const errors = checkNameCollisions(refs, config);
  const first = errors[0];
  if (first !== undefined) {
    throw first;
  }
}

/**
 * The config `import` must judge names against: the project's own when it has
 * one, and otherwise the one `penv init` writes, since that is the config the
 * scaffold below is about to put in place.
 *
 * Writing it *first* is what lets every name check run before a single value
 * file exists. It is safe to leave behind if a check then fails: it is byte for
 * byte the file `penv init` writes, it holds nothing read out of the `.env`, and
 * it is the file the reserved-token and `names` remedies both tell the user to
 * go and edit.
 */
function configInEffect(cwd: string): PenvConfig {
  const existing = findConfigFile(cwd);
  if (existing !== undefined) {
    return loadConfigFrom(existing);
  }
  writeConfigFile(cwd);
  return openProject(cwd).config;
}

/**
 * Adopts the file: parses it, scaffolds the project, writes one value file per
 * variable and each attached comment into that parameter's meta, and backs the
 * source up. Validation is the caller's next step rather than part of adoption —
 * an inferred schema is a draft, and a draft that needs correcting has still
 * imported every value correctly.
 *
 * Adoption is all or nothing. Every name is checked against the config before
 * the tree is scaffolded or a value written, because the two names that fail
 * here fail *destructively*: a reserved name bricks every later command, and a
 * lossy name renames the user's variable behind their back. A half-imported tree
 * would be the drift penv exists to remove, introduced by penv itself.
 */
export function importDotenv(options: ImportOptions): ImportReport {
  const cwd = resolve(options.cwd);
  const file = isAbsolute(options.file) ? options.file : resolve(cwd, options.file);
  if (!existsSync(file)) {
    throw new PenvError(
      "IMPORT_FILE_MISSING",
      `There is no file at ${file} to import`,
      "Point `penv import` at an existing dotenv file, e.g. `penv import .env`.",
    );
  }

  const parsed = parseDotenv(readFileSync(file, "utf8"));
  const config = configInEffect(cwd);
  const source = displayPath(cwd, file);

  const refs: ParameterRef[] = [];
  for (const entry of parsed.entries) {
    const ref = refFromVariable(entry.key);
    assertImportable(ref, entry.key);
    assertNotReserved(ref, entry.key, source, config);
    assertRoundTrips(ref, entry.key, config);
    refs.push(ref);
  }
  collisionsIn(refs, config);

  // Every check has passed, so from here the import runs to completion.
  const steps = scaffold(cwd, draftFields(parsed.entries), true);
  const project = openProject(cwd);

  for (const [index, entry] of parsed.entries.entries()) {
    const ref = refs[index];
    if (ref === undefined) {
      continue;
    }
    project.provider.writeSync(
      { namespace: ref.namespace, name: ref.name, scope: { kind: "unscoped" }, encrypted: false },
      entry.value,
    );
    // A comment sitting directly above a variable describes it, so it becomes
    // that parameter's meta description and `generate` re-emits it as a comment.
    if (entry.description !== undefined) {
      const existing = project.provider.readMetaSync(ref);
      const meta: Meta = { ...existing, description: entry.description };
      project.provider.writeMetaSync(ref, meta);
    }
  }

  const backup = `${file}${BACKUP_SUFFIX}`;
  copyFileSync(file, backup);

  return {
    root: project.root,
    file,
    backup,
    variables: parsed.entries.length,
    orphanComments: parsed.orphanComments,
    steps,
  };
}

function displayPath(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split("\\").join("/");
}

export function renderImport(result: ImportReport, validation: ValidateResult): string[] {
  const steps: Step[] = [{ glyph: CHECK, text: `Found ${result.variables} variables` }];

  // Dropped, but never silently: a comment attached to nothing has no parameter
  // to belong to, and how many there were is the user's to know.
  if (result.orphanComments > 0) {
    const plural = result.orphanComments === 1 ? "comment" : "comments";
    steps.push({
      glyph: WARN,
      text: `Dropped ${result.orphanComments} orphan ${plural}`,
      note: "attached to no variable, so nothing to describe",
    });
  }

  for (const step of result.steps) {
    steps.push(
      step.note === undefined
        ? { glyph: CHECK, text: step.text }
        : { glyph: CHECK, text: step.text, note: step.note },
    );
  }
  steps.push({ glyph: CHECK, text: `Created ${displayPath(result.root, result.backup)}` });

  const lines = formatSteps(steps);
  if (validation.ok) {
    lines.push(...formatSteps([{ glyph: CHECK, text: "Validated configuration" }]));
  } else {
    lines.push(...renderValidate(validation));
  }

  lines.push("", "Done. .penv/ is now your source of truth.");
  return lines;
}

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import an existing dotenv file; it becomes the source of truth",
  },
  args: {
    file: {
      type: "positional",
      required: true,
      description: "The dotenv file to import, e.g. .env",
    },
    env: { type: "string", description: "The environment to validate against" },
  },
  run({ args }) {
    return guard(async () => {
      const cwd = process.cwd();
      const report = importDotenv({ cwd, file: args.file });
      const validation = await runValidate({
        cwd,
        ...(args.env === undefined ? {} : { environment: args.env }),
      });
      write(renderImport(report, validation));
    });
  },
});
