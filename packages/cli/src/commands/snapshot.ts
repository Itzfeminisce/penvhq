/**
 * `penv snapshot` — (re)generate `penv.snapshot.ts` and wire it into the
 * scaffolded `env.ts`, so `load()` resolves in a bundled or serverless runtime
 * where no `penv.config.ts` is on disk.
 *
 * The snapshot embeds the evaluated config and every committed sealed value;
 * commit it beside the config. Run it once after upgrading, and after any change
 * to committed sealed values or the config — the mutating commands already
 * refresh it for you, and `penv doctor` flags it when it drifts.
 */

import { defineCommand } from "citty";
import { openProject } from "../project.js";
import {
  SNAPSHOT_FILE,
  type SnapshotWriteResult,
  type WireResult,
  wireEnvModule,
  writeSnapshotFile,
} from "../snapshot.js";
import { CHECK, formatRows, guard, type Row, tip, WARN, write } from "../ui.js";

export interface SnapshotResult {
  readonly write: SnapshotWriteResult;
  readonly wire: WireResult;
}

export function runSnapshot(options: { readonly cwd: string }): SnapshotResult {
  const project = openProject(options.cwd);
  return { write: writeSnapshotFile(project), wire: wireEnvModule(project) };
}

export function renderSnapshot(result: SnapshotResult): string[] {
  const label =
    result.write.action === "created"
      ? "Generated"
      : result.write.action === "updated"
        ? "Updated"
        : "Up to date";
  const rows: Row[] = [{ glyph: CHECK, label, subject: SNAPSHOT_FILE }];

  if (result.wire.action === "wired") {
    rows.push({
      glyph: CHECK,
      label: "Wired",
      subject: result.wire.file,
      detail: "load reads the snapshot",
    });
  } else if (result.wire.action === "kept") {
    rows.push({ glyph: CHECK, label: "Wired", subject: result.wire.file });
  }

  const lines = formatRows(rows);
  if (result.wire.action === "manual") {
    lines.push(
      "",
      `${WARN} penv could not wire ${result.wire.file} automatically — add these two lines yourself:`,
      tip(result.wire.importLine),
      tip(result.wire.loadHint),
    );
  }
  return lines;
}

export const snapshotCommand = defineCommand({
  meta: {
    name: "snapshot",
    description: "Generate penv.snapshot.ts so load() resolves in a bundled/serverless runtime",
  },
  run() {
    return guard(async () => {
      write(renderSnapshot(runSnapshot({ cwd: process.cwd() })));
    });
  },
});
