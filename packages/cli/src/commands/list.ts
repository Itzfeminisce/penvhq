/**
 * `penv list` — every parameter, and the scope that wins for one environment.
 *
 * The winning scope is the point: `production` and `default` are both "it
 * resolves", and only one of them means the value was written for production.
 */

import { variableName } from "@penv/core";
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
  /** `local`, an environment name, `default`, or `absent`. */
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
      scope:
        scope === undefined
          ? "absent"
          : scope.kind === "environment"
            ? scope.environment
            : scope.kind === "local"
              ? "local"
              : "default",
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
