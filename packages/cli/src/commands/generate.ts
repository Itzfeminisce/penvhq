/**
 * `penv generate` — write a flat `.env` artifact for deploy targets that expect
 * one.
 *
 * The output is an artifact, never an input: invariant 15 makes `.penv/` the
 * source of truth, and a hand-edit here is not absorbed back. Ordering is
 * normalized rather than preserved — one value per file discards the source
 * file's sequence by construction, so `generate` emits a deterministic sorted
 * order and the output is stable and diffable across machines.
 */

import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { DotenvEntry } from "@penv/core";
import {
  checkNameCollisions,
  effectiveMeta,
  PenvError,
  requireValue,
  serializeDotenv,
  variableName,
} from "@penv/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import {
  keySourceFor,
  openProject,
  PENV_DIR,
  refsFrom,
  resolveAllSync,
  targetEnvironment,
} from "../project.js";
import { CHECK, formatRows, guard, WARN, write } from "../ui.js";

export const DEFAULT_OUTPUT = ".env";

export interface GenerateOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Where to write, absolute or relative to `cwd`. Defaults to `.env` at the project root. */
  readonly out?: string;
  /** Permits sealed values to be written into the artifact as plaintext. */
  readonly allowDecrypt?: boolean;
}

export interface GenerateResult {
  readonly file: string;
  readonly environment: string;
  readonly entries: number;
  /** How many of them were sealed and are now plaintext in the artifact. */
  readonly decrypted: number;
}

/**
 * The variables for one environment, and how many of them were sealed.
 *
 * The count is returned rather than discarded because decrypting a secret into a
 * plaintext artifact is the one thing this command does that the user cannot see
 * by looking at the tree. `generate` reports it (invariant 13).
 */
interface Artifact {
  readonly entries: DotenvEntry[];
  readonly decrypted: number;
}

function entriesFor(project: Project, environment: string, allowDecrypt: boolean): Artifact {
  const keys = keySourceFor(project, environment);
  const resolutions = resolveAllSync(project.provider, environment, keys);

  // Invariant 12, enforced where the loss would happen: two parameters mapping
  // to one variable would silently drop a value from this file.
  const collision = checkNameCollisions(
    refsFrom(resolutions.map((resolution) => resolution.ref)),
    project.config,
  )[0];
  if (collision !== undefined) {
    throw collision;
  }

  const entries: DotenvEntry[] = [];
  let decrypted = 0;
  for (const resolution of resolutions) {
    const winner = resolution.winner;
    if (winner?.file.encrypted === true) {
      // A `.env` is plaintext by construction, so writing a sealed value into one
      // unseals it. penv will do that — the leaving guarantee is that a working
      // `.env` is always reachable — but never as a side effect of a command the
      // user ran for another reason. Asking makes the moment the secret becomes
      // plaintext a moment they chose.
      if (!allowDecrypt) {
        throw new PenvError(
          "ENCRYPTED_VALUE_REFUSED",
          `Parameter ${resolution.parameter} for environment ${environment} resolves to the encrypted value file ${PENV_DIR}/${winner.location}, and \`penv generate\` writes plaintext`,
          `Re-run with \`--allow-decrypt\` to write the decrypted value into the artifact, or generate for an environment whose values are plaintext. The artifact is gitignored; a committed plaintext secret is a \`penv doctor\` failure.`,
        );
      }
      // Throws when it cannot be opened, naming the reason — never silently
      // omitting the variable, which would produce an artifact that is missing
      // exactly the secret the deploy needs.
      requireValue(resolution, environment);
      decrypted += 1;
    }
    if (resolution.value === undefined) {
      continue;
    }
    // A parameter's description is a comment in the generated file, so the
    // annotation that arrived on import survives the round trip back out.
    const description = effectiveMeta(
      project.provider.readMetaSync(resolution.ref),
      environment,
    ).description;
    entries.push({
      key: variableName(resolution.ref, project.config),
      value: resolution.value,
      ...(typeof description === "string" ? { description } : {}),
    });
  }

  // Sorted by the generated variable, which is what a reader of this file sees.
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { entries, decrypted };
}

/** The `.env` text for one environment — what `penv generate` writes. */
export function generateDotenv(options: Omit<GenerateOptions, "out">): string {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  return serializeDotenv(entriesFor(project, environment, options.allowDecrypt === true).entries);
}

export function runGenerate(options: GenerateOptions): GenerateResult {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const { entries, decrypted } = entriesFor(project, environment, options.allowDecrypt === true);

  // `--out` is the caller's path, so it is relative to where they are standing;
  // the default artifact belongs next to the config it was generated from.
  const file =
    options.out === undefined
      ? resolve(project.root, DEFAULT_OUTPUT)
      : isAbsolute(options.out)
        ? options.out
        : resolve(options.cwd, options.out);

  writeFileSync(file, serializeDotenv(entries), "utf8");
  return { file, environment, entries: entries.length, decrypted };
}

/** The artifact's path as the caller would type it, when it is below them. */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split("\\").join("/");
}

export function renderGenerate(result: GenerateResult, cwd: string): string[] {
  const rows = [
    {
      glyph: CHECK,
      label: "Generated",
      subject: displayPath(cwd, result.file),
      detail: `${result.entries} variables for environment ${result.environment}`,
    },
  ];
  // A secret that was sealed a moment ago and is plaintext now is worth a line of
  // its own. The artifact is gitignored, which is a reason it is safe to write —
  // not a reason to write it quietly.
  if (result.decrypted > 0) {
    rows.push({
      glyph: WARN,
      label: "Decrypted",
      subject: `${result.decrypted} ${result.decrypted === 1 ? "secret" : "secrets"}`,
      detail: "written as plaintext into the artifact",
    });
  }
  return formatRows(rows);
}

export const generateCommand = defineCommand({
  meta: { name: "generate", description: "Write a standard .env artifact for deploy targets" },
  args: {
    env: { type: "string", description: "The environment to generate for" },
    out: { type: "string", description: "Where to write, instead of .env" },
    "allow-decrypt": {
      type: "boolean",
      description: "Write encrypted values into the artifact as plaintext",
    },
  },
  run({ args }) {
    return guard(async () => {
      const cwd = process.cwd();
      const result = runGenerate({
        cwd,
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args.out === undefined ? {} : { out: args.out }),
        ...(args["allow-decrypt"] === undefined ? {} : { allowDecrypt: args["allow-decrypt"] }),
      });
      write(renderGenerate(result, cwd));
    });
  },
});
