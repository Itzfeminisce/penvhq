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
  formatValueFile,
  PenvError,
  serializeDotenv,
  variableName,
} from "@penv/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import { openProject, PENV_DIR, refsFrom, resolveAllSync, targetEnvironment } from "../project.js";
import { CHECK, formatRows, guard, write } from "../ui.js";

export const DEFAULT_OUTPUT = ".env";

export interface GenerateOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Where to write, absolute or relative to `cwd`. Defaults to `.env` at the project root. */
  readonly out?: string;
}

export interface GenerateResult {
  readonly file: string;
  readonly environment: string;
  readonly entries: number;
}

function entriesFor(project: Project, environment: string): DotenvEntry[] {
  const resolutions = resolveAllSync(project.provider, environment);

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
  for (const resolution of resolutions) {
    const winner = resolution.winner;
    if (winner?.encrypted === true) {
      throw new PenvError(
        "ENCRYPTED_VALUE_UNSUPPORTED",
        `Parameter ${resolution.parameter} for environment ${environment} resolves to the encrypted value file ${PENV_DIR}/${formatValueFile(winner)}, which penv cannot decrypt`,
        `Decrypting \`.enc\` value files is not part of this release. Provide a plaintext value file for ${resolution.parameter}, or generate for an environment whose values are plaintext.`,
      );
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
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The `.env` text for one environment — what `penv generate` writes. */
export function generateDotenv(options: Omit<GenerateOptions, "out">): string {
  const project = openProject(options.cwd);
  return serializeDotenv(entriesFor(project, targetEnvironment(project, options.environment)));
}

export function runGenerate(options: GenerateOptions): GenerateResult {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const entries = entriesFor(project, environment);

  // `--out` is the caller's path, so it is relative to where they are standing;
  // the default artifact belongs next to the config it was generated from.
  const file =
    options.out === undefined
      ? resolve(project.root, DEFAULT_OUTPUT)
      : isAbsolute(options.out)
        ? options.out
        : resolve(options.cwd, options.out);

  writeFileSync(file, serializeDotenv(entries), "utf8");
  return { file, environment, entries: entries.length };
}

/** The artifact's path as the caller would type it, when it is below them. */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split("\\").join("/");
}

export function renderGenerate(result: GenerateResult, cwd: string): string[] {
  return formatRows([
    {
      glyph: CHECK,
      label: "Generated",
      subject: displayPath(cwd, result.file),
      detail: `${result.entries} variables for environment ${result.environment}`,
    },
  ]);
}

export const generateCommand = defineCommand({
  meta: { name: "generate", description: "Write a standard .env artifact for deploy targets" },
  args: {
    env: { type: "string", description: "The environment to generate for" },
    out: { type: "string", description: "Where to write, instead of .env" },
  },
  run({ args }) {
    return guard(async () => {
      const cwd = process.cwd();
      const result = runGenerate({
        cwd,
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args.out === undefined ? {} : { out: args.out }),
      });
      write(renderGenerate(result, cwd));
    });
  },
});
