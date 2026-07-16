/**
 * `penv get <key>` — read a parameter, or explain which file wins and why.
 *
 * Fallback is never silent, and neither is precedence: `--explain` prints every
 * candidate in the order the cascade considered them, so a value quietly coming
 * from a shared default has nowhere to hide.
 */

import { PenvError, resolveParameter } from "@penv/core";
import { defineCommand } from "citty";
import {
  describeResolution,
  openProject,
  PENV_DIR,
  refFromKey,
  targetEnvironment,
} from "../project.js";
import { columns, guard, write } from "../ui.js";

export interface GetOptions {
  readonly cwd: string;
  readonly key: string;
  readonly environment?: string;
}

export interface GetExplanation {
  readonly parameter: string;
  readonly environment: string;
  /** `undefined` when no candidate was present. */
  readonly location: string | undefined;
  readonly candidates: readonly GetCandidate[];
}

export interface GetCandidate {
  readonly location: string;
  readonly present: boolean;
  readonly wins: boolean;
  /** Why a present candidate did not win, or why it was never considered. */
  readonly skipped: string | undefined;
}

/** The value, or a named error. `.enc` winners are refused here, not described. */
export async function runGet(options: GetOptions): Promise<string> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const ref = refFromKey(options.key);

  const resolution = await resolveParameter(ref, environment, project.provider);
  if (resolution.value === undefined) {
    throw new PenvError(
      "PARAMETER_ABSENT",
      `Parameter ${resolution.parameter} resolves to no value for environment ${environment}`,
      `Set it with \`penv set ${options.key} --env ${environment}\`, or run \`penv get ${options.key} --env ${environment} --explain\` to see every file penv looked at.`,
    );
  }
  return resolution.value;
}

function skipReason(reason: string | undefined): string | undefined {
  if (reason === "lower-precedence") {
    return "skipped, a more specific scope wins";
  }
  if (reason === "local-skipped-in-test") {
    return "skipped, .local never applies in test";
  }
  return undefined;
}

export async function runExplain(options: GetOptions): Promise<GetExplanation> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const ref = refFromKey(options.key);

  const resolution = await describeResolution(ref, environment, project.provider);
  const winner = resolution.winner;

  return {
    parameter: resolution.parameter,
    environment,
    location: winner === undefined ? undefined : winner.location,
    candidates: resolution.candidates.map((candidate) => ({
      location: candidate.location,
      present: candidate.present,
      wins: candidate === winner,
      skipped: skipReason(candidate.skippedReason),
    })),
  };
}

export function renderExplain(explanation: GetExplanation): string[] {
  const target =
    explanation.location === undefined ? "nothing" : `${PENV_DIR}/${explanation.location}`;

  // Candidates stay in the order the cascade considered them: the answer to
  // "why this file" is the list above it that did not win.
  const rows = explanation.candidates.map((candidate) => [
    candidate.location,
    candidate.wins
      ? "present, wins"
      : candidate.present
        ? (candidate.skipped ?? "present")
        : (candidate.skipped ?? "absent"),
  ]);

  return [
    `${explanation.parameter} resolves to ${target} for environment ${explanation.environment}`,
    "",
    ...columns(rows).map((line) => `  ${line}`),
  ];
}

export const getCommand = defineCommand({
  meta: { name: "get", description: "Read a parameter" },
  args: {
    key: { type: "positional", required: true, description: "The parameter, e.g. redis/password" },
    env: { type: "string", description: "The environment to read" },
    explain: { type: "boolean", description: "Print which file wins, and why" },
  },
  run({ args }) {
    return guard(async () => {
      const options: GetOptions = {
        cwd: process.cwd(),
        key: args.key,
        ...(args.env === undefined ? {} : { environment: args.env }),
      };
      if (args.explain === true) {
        write(renderExplain(await runExplain(options)));
        return;
      }
      write([await runGet(options)]);
    });
  },
});
