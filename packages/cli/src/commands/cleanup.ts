/**
 * `penv cleanup` — the end of a dotenv migration.
 *
 * The cutover keeps one rollback bundle so `penv init undo` can put the original
 * files back. This drops it, and only it: the records, the schema, the config
 * and the loader are the project's, and cleaning up after a migration is not the
 * same as undoing an adoption. It is also what unblocks a second migration,
 * which is refused while a bundle is unresolved.
 */

import { CUTOVER_PATH, ROLLBACK_DOTENV_PATH } from "@penvhq/core";
import { defineCommand } from "citty";
import type { CleanupResult } from "../cutover.js";
import { runCleanup } from "../cutover.js";
import { out } from "../style.js";
import { CHECK, formatSteps, guard, type Step, write } from "../ui.js";

export function renderCleanup(result: CleanupResult): string[] {
  if (!result.cleaned) {
    return [`${out.green(CHECK)} No dotenv rollback bundle to clean up.`];
  }
  const steps: Step[] = [
    ...result.removed.map((name) => ({
      glyph: CHECK,
      text: `Removed ${name}`,
      note: `from ${ROLLBACK_DOTENV_PATH}/`,
    })),
    { glyph: CHECK, text: `Removed ${CUTOVER_PATH}` },
  ];
  return [
    ...formatSteps(steps),
    "",
    `${out.green(CHECK)} ${out.bold("Cleaned up.")} The migration is over; your records, schema and config are untouched.`,
  ];
}

export const cleanupCommand = defineCommand({
  meta: {
    name: "cleanup",
    description: "Drop the dotenv rollback bundle the last `penv init` kept",
  },
  run() {
    return guard(async () => {
      write(renderCleanup(runCleanup({ cwd: process.cwd() })));
    });
  },
});
