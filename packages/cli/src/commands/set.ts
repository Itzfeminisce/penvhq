/**
 * `penv set <key> [value]` — write one value file.
 *
 * The scope is chosen, never inferred: `--env <name>` writes `<name>.<env>`,
 * `--local` writes the personal override — for one environment when combined
 * with `--env`, for every environment on its own — and the default is the
 * unscoped one every environment falls back to. Writing to `--env production`
 * when you meant the default is a different file, so penv never picks for you.
 */

import type { Scope, ValueFile } from "@penv/core";
import { formatValueFile, PenvError } from "@penv/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import { openProject, PENV_DIR, refFromKey, targetEnvironment } from "../project.js";
import { CHECK, formatRows, guard, write } from "../ui.js";

export interface ScopeOptions {
  /** The environment scope. Combined with `local`, the environment-scoped override. */
  readonly environment?: string;
  readonly local?: boolean;
}

export interface SetOptions extends ScopeOptions {
  readonly cwd: string;
  readonly key: string;
  readonly value: string;
}

export interface SetResult {
  readonly parameter: string;
  /** The value file written, relative to `.penv/`. */
  readonly location: string;
}

/**
 * The scope the flags name — one flag combination per cascade level, all four.
 *
 * `--local --env <e>` is the environment-scoped personal override, mirroring
 * `.env.<e>.local`: the flags compose, because the cascade has a level where
 * both are true. Refusing the combination is what used to leave that level
 * unaddressable from the CLI.
 *
 * `environment` must already be the name {@link targetScope} validated, never
 * the raw flag — the string here becomes a filename segment verbatim.
 */
export function scopeFrom(options: ScopeOptions): Scope {
  if (options.local === true) {
    if (options.environment !== undefined) {
      return { kind: "environment-local", environment: options.environment };
    }
    return { kind: "local" };
  }
  if (options.environment !== undefined) {
    return { kind: "environment", environment: options.environment };
  }
  return { kind: "unscoped" };
}

/**
 * The scope a writer may act on: the environment as `targetEnvironment`
 * *returned* it, never as the flag carried it.
 *
 * `resolveEnvironment` trims before it checks the whitelist, so the validated
 * name and the raw flag are two different strings and only the returned one has
 * been checked against `config.environments`. Passing the raw one to
 * `formatValueFile` is what let `--env "production "` write `api-key.production `
 * — a file the filename grammar refuses to read (invariant 10), so every later
 * `list`/`get`/`generate`/`validate`/`remove` throws and the tree is repairable
 * only by deleting the file by hand. Validation is what makes a string safe to
 * put in a filename, so the validated value is the only one that may reach one.
 *
 * A blank `--env` is refused rather than resolved: `resolveEnvironment` answers
 * it from `PENV_ENV`/`NODE_ENV`, and a writer scoping a file to an environment
 * the user never named is the same wrong file by a quieter route (invariants 10
 * and 13).
 */
export function targetScope(project: Project, options: ScopeOptions, key: string): Scope {
  const environment = options.environment;
  if (environment === undefined) {
    return scopeFrom(options);
  }
  if (environment.trim().length === 0) {
    throw new PenvError(
      "ENVIRONMENT_FLAG_EMPTY",
      `\`--env\` for parameter ${key} names no environment`,
      `Pass a declared environment — ${project.config.environments.map((e) => `\`${e}\``).join(", ")} — ` +
        "e.g. `--env production`, or drop `--env` to write the scope that has no environment.",
    );
  }
  return scopeFrom({ ...options, environment: targetEnvironment(project, environment) });
}

export async function runSet(options: SetOptions): Promise<SetResult> {
  const project = openProject(options.cwd);
  const ref = refFromKey(options.key);

  const file: ValueFile = {
    namespace: ref.namespace,
    name: ref.name,
    // An environment is a whitelist entry or nothing, so a scope naming one is
    // checked before it becomes a filename — including under `--local`, where
    // the environment is a filename segment too.
    scope: targetScope(project, options, options.key),
    encrypted: false,
  };
  await project.provider.write(file, options.value);

  return { parameter: options.key, location: formatValueFile(file) };
}

export function renderSet(result: SetResult): string[] {
  return formatRows([{ glyph: CHECK, label: "Wrote", subject: `${PENV_DIR}/${result.location}` }]);
}

/** The value when it is piped in rather than typed: one trailing newline is the shell's. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export const setCommand = defineCommand({
  meta: { name: "set", description: "Update a parameter" },
  args: {
    key: { type: "positional", required: true, description: "The parameter, e.g. redis/password" },
    value: {
      type: "positional",
      required: false,
      description: "The value; read from stdin if omitted",
    },
    env: { type: "string", description: "Write the <name>.<env> scope" },
    local: {
      type: "boolean",
      description: "Write the personal override: <name>.<env>.local with --env, else <name>.local",
    },
  },
  run({ args }) {
    return guard(async () => {
      const value = args.value ?? (await readStdin());
      write(
        renderSet(
          await runSet({
            cwd: process.cwd(),
            key: args.key,
            value,
            ...(args.env === undefined ? {} : { environment: args.env }),
            ...(args.local === undefined ? {} : { local: args.local }),
          }),
        ),
      );
    });
  },
});
