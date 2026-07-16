/**
 * `penv list` — every parameter, and the scope that wins for one environment.
 *
 * The winning scope is the point: `production` and `default` are both "it
 * resolves", and only one of them means the value was written for production.
 */

import type { Scope } from "@penv/core";
import { assertNever, variableName } from "@penv/core";
import { defineCommand } from "citty";
import { describeAll, openProject, PENV_DIR, targetEnvironment } from "../project.js";
import { columns, guard, write } from "../ui.js";

export interface ListOptions {
  readonly cwd: string;
  readonly environment?: string;
}

export interface ListEntry {
  readonly parameter: string;
  /** The generated `.env` variable, so the two names are legible side by side. */
  readonly variable: string;
  /** `<env>.local`, `local`, an environment name, `default`, or `absent`. */
  readonly scope: string;
  /** The winning value file relative to `.penv/`, or `undefined` when nothing wins. */
  readonly location: string | undefined;
  readonly encrypted: boolean;
  readonly viaUnscopedFallback: boolean;
}

export interface ListResult {
  readonly environment: string;
  readonly parameters: readonly ListEntry[];
}

/**
 * The cascade level a winning scope names, spelled as its filename suffix so the
 * column reads back as the file on disk. Each of the four levels is distinct:
 * `production.local` and `local` are different files with different reach, and a
 * column that called both `local` would hide which one won.
 */
function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case "environment":
      return scope.environment;
    case "local":
      return "local";
    case "environment-local":
      return `${scope.environment}.local`;
    case "unscoped":
      return "default";
    default:
      return assertNever(scope, "scope");
  }
}

export async function runList(options: ListOptions): Promise<ListResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);

  const parameters: ListEntry[] = [];
  for (const resolution of await describeAll(environment, project.provider)) {
    const winner = resolution.winner;
    const scope = winner?.file.scope;
    parameters.push({
      parameter: resolution.parameter,
      variable: variableName(resolution.ref, project.config),
      scope: scope === undefined ? "absent" : scopeLabel(scope),
      location: winner?.location,
      encrypted: winner?.file.encrypted === true,
      viaUnscopedFallback: resolution.viaUnscopedFallback,
    });
  }

  return { environment, parameters };
}

export function renderList(result: ListResult): string[] {
  if (result.parameters.length === 0) {
    return [`No parameters in ${PENV_DIR}/ for environment ${result.environment}.`];
  }
  return columns(result.parameters.map((entry) => [entry.parameter, entry.scope, entry.variable]));
}

export const listCommand = defineCommand({
  meta: { name: "list", description: "List parameters" },
  args: {
    env: { type: "string", description: "The environment to resolve against" },
    json: { type: "boolean", description: "Print machine-readable JSON" },
  },
  run({ args }) {
    return guard(async () => {
      const result = await runList({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
      });
      write(args.json === true ? [JSON.stringify(result, null, 2)] : renderList(result));
    });
  },
});
