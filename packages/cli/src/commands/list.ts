/**
 * `penv list` — every parameter, and the scope that wins for one environment.
 *
 * The winning scope is the point: `production` and `default` are both "it
 * resolves", and only one of them means the value was written for production.
 */

import type { Scope } from "@penvhq/core";
import { assertNever, resolveAll, variableName } from "@penvhq/core";
import { defineCommand } from "citty";
import { keySourceFor, openProject, PENV_DIR, targetEnvironment } from "../project.js";
import { out } from "../style.js";
import { columns, guard, heading, tip, write } from "../ui.js";

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

  const keys = keySourceFor(project, environment);
  const parameters: ListEntry[] = [];
  // `list` names which file wins, never a value, so an undecryptable winner is
  // listed exactly like any other: the scope column is the answer here.
  for (const resolution of await resolveAll(environment, project.provider, keys)) {
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

/**
 * The scope column is the report, so it carries the verdict's color: green for a
 * value written for this environment, yellow for the silent-drift shapes —
 * `absent`, and a real environment riding the unscoped default (invariant 13:
 * fallback is never silent) — and plain for everything else.
 */
function paintScope(entry: ListEntry): string {
  if (entry.scope === "absent" || entry.viaUnscopedFallback) {
    return out.yellow(entry.scope);
  }
  return out.green(entry.scope);
}

export function renderList(result: ListResult): string[] {
  if (result.parameters.length === 0) {
    return [
      `No parameters in ${PENV_DIR}/ for environment ${result.environment}.`,
      tip(`penv set <key> --env ${result.environment}`),
    ];
  }
  const header = ["parameter", "scope", "variable", ""].map((cell) => out.dim(cell));
  const rows = result.parameters.map((entry) => [
    entry.parameter,
    paintScope(entry),
    entry.variable,
    entry.encrypted ? out.dim("encrypted") : "",
  ]);
  return [
    heading("penv list", `environment ${result.environment}`),
    "",
    ...columns([header, ...rows]),
  ];
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
