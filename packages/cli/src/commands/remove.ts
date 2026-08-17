/**
 * `penv remove <key>` — delete one value file.
 *
 * The scope is selected exactly as `penv set` selects it, so what you removed is
 * the file you would have written. Meta is left alone: policy is a property of
 * the parameter across every environment, not of the value you just deleted.
 */

import type { ValueFile } from "@penvhq/core";
import { formatValueFile } from "@penvhq/core";
import { defineCommand } from "citty";
import { openProject, PENV_DIR, refFromKey } from "../project.js";
import { CHECK, formatRows, guard, type Row, WARN, write } from "../ui.js";
import { type ScopeOptions, targetScope } from "./set.js";

export interface RemoveOptions extends ScopeOptions {
  readonly cwd: string;
  readonly key: string;
}

export interface RemoveResult {
  readonly parameter: string;
  /** The value files that existed and are now gone, relative to `.penv/`. */
  readonly removed: readonly string[];
  /** Both files penv looked at, whether or not they were there. */
  readonly considered: readonly string[];
}

export async function runRemove(options: RemoveOptions): Promise<RemoveResult> {
  const project = openProject(options.cwd);
  const ref = refFromKey(options.key);

  // The same scope selection `set` writes through, for the same reason: the file
  // `remove` names has to be the file `set` named, byte for byte.
  const scope = targetScope(project, options, options.key);
  // `.enc` is orthogonal to scope: the encrypted file at this scope is the same
  // parameter at the same precedence, so removing the scope removes both.
  const files: ValueFile[] = [false, true].map((encrypted) => ({
    namespace: ref.namespace,
    name: ref.name,
    scope,
    encrypted,
  }));

  const removed: string[] = [];
  for (const file of files) {
    if ((await project.provider.read(file)) === undefined) {
      continue;
    }
    await project.provider.remove(file);
    removed.push(formatValueFile(file));
  }

  return {
    parameter: options.key,
    removed,
    considered: files.map((file) => formatValueFile(file)),
  };
}

export function renderRemove(result: RemoveResult): string[] {
  if (result.removed.length === 0) {
    const first = result.considered[0] ?? result.parameter;
    return formatRows([
      {
        glyph: WARN,
        label: "Nothing to remove",
        subject: `${PENV_DIR}/${first}`,
        detail: "no value file at that scope",
      },
    ]);
  }
  const rows: Row[] = result.removed.map((location) => ({
    glyph: CHECK,
    label: "Removed",
    subject: `${PENV_DIR}/${location}`,
  }));
  return formatRows(rows);
}

export const removeCommand = defineCommand({
  meta: { name: "remove", description: "Delete a parameter" },
  args: {
    key: { type: "positional", required: true, description: "The parameter, e.g. redis/password" },
    env: { type: "string", description: "Remove the <name>.<env> scope" },
    local: {
      type: "boolean",
      description: "Remove the personal override: <name>.<env>.local with --env, else <name>.local",
    },
  },
  run({ args }) {
    return guard(async () => {
      write(
        renderRemove(
          await runRemove({
            cwd: process.cwd(),
            key: args.key,
            ...(args.env === undefined ? {} : { environment: args.env }),
            ...(args.local === undefined ? {} : { local: args.local }),
          }),
        ),
      );
    });
  },
});
