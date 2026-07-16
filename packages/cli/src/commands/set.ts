/**
 * `penv set <key> [value]` — write one value file.
 *
 * The scope is chosen, never inferred: `--env <name>` writes `<name>.<env>`,
 * `--local` writes the personal override, and the default is the unscoped one
 * every environment falls back to. Writing to `--env production` when you meant
 * the default is a different file, so penv never picks for you.
 */

import type { Scope, ValueFile } from "@penv/core";
import { formatValueFile, PenvError } from "@penv/core";
import { defineCommand } from "citty";
import { openProject, PENV_DIR, refFromKey, targetEnvironment } from "../project.js";
import { CHECK, formatRows, guard, write } from "../ui.js";

export interface ScopeOptions {
  /** The environment scope. Mutually exclusive with `local`. */
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
 * The scope the flags name. `.local` is a personal override at every scope, so
 * it is not a scope *within* an environment — asking for both names two files.
 */
export function scopeFrom(options: ScopeOptions): Scope {
  if (options.local === true) {
    if (options.environment !== undefined) {
      throw new PenvError(
        "SCOPE_AMBIGUOUS",
        "`--local` and `--env` name two different value files",
        "`<name>.local` is your personal override on this machine, whatever the environment. Pass one or the other.",
      );
    }
    return { kind: "local" };
  }
  if (options.environment !== undefined) {
    return { kind: "environment", environment: options.environment };
  }
  return { kind: "unscoped" };
}

export async function runSet(options: SetOptions): Promise<SetResult> {
  const project = openProject(options.cwd);
  const ref = refFromKey(options.key);

  // An environment is a whitelist entry or nothing, so a scope naming one is
  // checked before it becomes a filename.
  if (options.environment !== undefined && options.local !== true) {
    targetEnvironment(project, options.environment);
  }

  const file: ValueFile = {
    namespace: ref.namespace,
    name: ref.name,
    scope: scopeFrom(options),
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
    local: { type: "boolean", description: "Write the <name>.local personal override" },
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
