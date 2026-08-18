/**
 * `penv artifact build` — the sealed deployment artifact CI hands a release.
 *
 * It is the third step of the sequence PRD §7 names: pull the target
 * environment, validate it, build the artifact, mount it. Each step is a command
 * with one job, and this one's is narrow on purpose — it does not re-reach a
 * verdict `penv validate` already reaches, because two implementations of "is
 * this configuration good" would eventually let a release be built that CI had
 * already rejected.
 *
 * Two properties are the whole design:
 *
 * **It never decrypts.** A sealed value is copied ciphertext-and-address into
 * the artifact exactly as the record holds it, so building needs no key at all —
 * CI can produce a production artifact without ever being able to read one. The
 * AAD is still the value file's full name, so the ciphertext stays bound to the
 * scope it was sealed at (invariant 17).
 *
 * **It refuses to guess the environment.** `--env` is named explicitly and never
 * defaulted, `--out` likewise. An artifact built for "whatever the default was"
 * is a release that ships the wrong environment's credentials, and the default
 * that made it is one config edit nobody reviewed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Artifact, ArtifactEntry, ParameterRef, ValueFile } from "@penvhq/core";
import {
  ARTIFACT_FORMAT,
  candidatesFor,
  deliveryDigest,
  formatValueFile,
  isSecret,
  keySourceIdentifier,
  PenvError,
  parameterId,
  serializeArtifact,
  variableName,
} from "@penvhq/core";
import { declaredRefs } from "@penvhq/runtime";
import { defineCommand } from "citty";
import { engineVersion } from "../install.js";
import type { Project } from "../project.js";
import { openProject } from "../project.js";
import { CHECK, formatRows, guard, WARN, write } from "../ui.js";
import { assertNoPublicSecret } from "./run.js";
import { loadSchema } from "./validate.js";

export interface ArtifactBuildOptions {
  readonly cwd: string;
  /** Named explicitly. There is no default, and none is invented. */
  readonly environment?: string;
  /** Named explicitly. Where the release will mount it from. */
  readonly out?: string;
}

export interface ArtifactBuildResult {
  readonly file: string;
  readonly environment: string;
  readonly engineVersion: string;
  readonly keySource: string;
  /** Delivery mappings with a value. */
  readonly values: number;
  /** How many of those travelled as ciphertext. */
  readonly sealed: number;
  /** Declared mappings the environment has no non-local winner for. */
  readonly absent: number;
  /** True when the artifact was written inside the project — a `doctor` finding. */
  readonly insideRepo: boolean;
}

/** The invocation every refusal here points back at, with what is known filled in. */
function buildCommand(environment: string | undefined, out: string | undefined): string {
  return `penv artifact build --env ${environment ?? "<environment>"} --out ${out ?? "<path>"}`;
}

/**
 * The environment, taken only from `--env`.
 *
 * Deliberately not `targetEnvironment`: `defaultEnvironment`, `PENV_ENV` and
 * `NODE_ENV` all answer for the machine the command runs on, and the machine a
 * release is built on has no opinion worth acting on about which environment the
 * release is for.
 */
function targetOf(options: ArtifactBuildOptions): string {
  const environment = options.environment?.trim();
  if (environment === undefined || environment.length === 0) {
    throw new PenvError(
      "ARTIFACT_ENV_REQUIRED",
      "`penv artifact build` names the environment it builds for, and `--env` was not given",
      `Name it: \`${buildCommand(undefined, options.out)}\`. An artifact carries one environment, and penv will not pick which.`,
    );
  }
  return environment;
}

/** The path, taken only from `--out` — there is no default, and none is inside the repo. */
function outputOf(options: ArtifactBuildOptions, environment: string): string {
  const out = options.out?.trim();
  if (out === undefined || out.length === 0) {
    throw new PenvError(
      "ARTIFACT_OUT_REQUIRED",
      "`penv artifact build` writes where it is told, and `--out` was not given",
      `Name the path: \`${buildCommand(environment, undefined)}\`. The artifact belongs outside the repository, so there is no default worth having.`,
    );
  }
  return isAbsolute(out) ? out : resolve(options.cwd, out);
}

/**
 * The winning value file for one parameter, unopened.
 *
 * `.local` scopes are skipped outright: a personal override is one developer's
 * machine, and shipping it to a release is the scope widening the cascade exists
 * to prevent. The precedence rule itself is not restated here — `candidatesFor`
 * owns the order and this only walks the list it returns.
 */
async function winnerOf(
  project: Project,
  ref: ParameterRef,
  environment: string,
): Promise<{ readonly file: ValueFile; readonly stored: string } | undefined> {
  for (const file of candidatesFor(ref, environment, true)) {
    const stored = await project.provider.read(file);
    if (stored !== undefined) {
      return { file, stored };
    }
  }
  return undefined;
}

/**
 * A secret whose winner is a plaintext file, refused at the delivery boundary.
 *
 * `doctor` reports this and the artifact refuses it, and that is the difference
 * between a report and a release: an artifact is written once and read
 * unchanged, so a plaintext secret in one is a plaintext secret in every
 * container the release reaches, for as long as it runs. penv holds both halves
 * — meta says secret, the winning filename says plaintext — so this is where it
 * stops.
 */
function plaintextSecret(parameter: string, location: string, environment: string): PenvError {
  return new PenvError(
    "ARTIFACT_PLAINTEXT_SECRET",
    `${parameter} is a secret for environment ${environment}, and its value comes from ${location}, which is not sealed`,
    `Seal it with \`penv encrypt ${parameter} --env ${environment}\` — an artifact carries ciphertext or nothing.`,
  );
}

export async function runArtifactBuild(
  options: ArtifactBuildOptions,
): Promise<ArtifactBuildResult> {
  const environment = targetOf(options);
  const file = outputOf(options, environment);
  const retry = buildCommand(environment, options.out);

  const project = openProject(options.cwd);
  const { schema, issues } = await loadSchema(project, environment);
  if (schema === undefined) {
    const lines = issues.map((issue) => `  ${issue.subject}: ${issue.message}`).join("\n");
    throw new PenvError(
      "ARTIFACT_NO_SCHEMA",
      `The schema did not load, so penv cannot tell what this artifact should deliver:\n${lines}`,
      `Fix the error above, then run \`${retry}\` again.`,
    );
  }

  const refs = declaredRefs(schema);
  await assertNoPublicSecret(project, environment, refs, retry);

  const values: Record<string, ArtifactEntry> = {};
  let sealed = 0;
  let present = 0;
  for (const ref of refs) {
    const parameter = parameterId(ref);
    const variable = variableName(ref, project.config);
    const winner = await winnerOf(project, ref, environment);
    if (winner === undefined) {
      values[parameter] = { kind: "absent", variable };
      continue;
    }
    present += 1;
    const location = formatValueFile(winner.file);
    if (winner.file.encrypted) {
      sealed += 1;
      values[parameter] = { kind: "sealed", variable, address: location, sealed: winner.stored };
      continue;
    }
    if (isSecret(await project.provider.readMeta(ref), environment)) {
      throw plaintextSecret(parameter, location, environment);
    }
    values[parameter] = { kind: "plain", variable, value: winner.stored };
  }

  const artifact: Artifact = {
    format: ARTIFACT_FORMAT,
    environment,
    engineVersion: engineVersion(),
    schemaDigest: deliveryDigest(values),
    keySource: keySourceIdentifier(project.config, environment),
    values,
  };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeArtifact(artifact), "utf8");

  const inside = relative(project.root, file);
  return {
    file,
    environment,
    engineVersion: artifact.engineVersion,
    keySource: artifact.keySource,
    values: present,
    sealed,
    absent: refs.length - present,
    insideRepo: inside !== "" && !inside.startsWith("..") && !isAbsolute(inside),
  };
}

/** The artifact's path as the caller would type it, when it is below them. */
function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split("\\").join("/");
}

export function renderArtifactBuild(result: ArtifactBuildResult, cwd: string): string[] {
  const rows = [
    {
      glyph: CHECK,
      label: "Built",
      subject: displayPath(cwd, result.file),
      detail: `${result.values} values for environment ${result.environment}, ${result.sealed} sealed`,
    },
  ];
  // Said now, while the path can still be changed, and said again by `doctor`
  // for the artifact that was committed anyway.
  if (result.insideRepo) {
    rows.push({
      glyph: WARN,
      label: "Inside the repository",
      subject: displayPath(cwd, result.file),
      detail: "a deployment artifact is stored outside git — write it somewhere else",
    });
  }
  return formatRows(rows);
}

const buildSubcommand = defineCommand({
  meta: {
    name: "build",
    description: "Write the sealed deployment artifact for one environment",
  },
  args: {
    env: { type: "string", description: "The environment to build for (required)" },
    out: { type: "string", description: "Where to write the artifact (required)" },
  },
  run({ args }) {
    return guard(async () => {
      const cwd = process.cwd();
      const result = await runArtifactBuild({
        cwd,
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args.out === undefined ? {} : { out: args.out }),
      });
      write(renderArtifactBuild(result, cwd));
    });
  },
});

export const artifactCommand = defineCommand({
  meta: {
    name: "artifact",
    description: "Build the sealed deployment artifact a release runs from",
  },
  subCommands: { build: buildSubcommand },
});
