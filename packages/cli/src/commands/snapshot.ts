/**
 * `penv snapshot` — (re)generate `penv.snapshot.ts` and wire it into the
 * scaffolded `env.ts`, so `load()` resolves in a bundled or serverless runtime
 * where no `penv.config.ts` is on disk.
 *
 * The snapshot embeds the evaluated config and every committed sealed value;
 * commit it beside the config. Run it once after upgrading, and after any change
 * to committed sealed values or the config — the mutating commands already
 * refresh it for you, and `penv doctor` flags it when it drifts.
 *
 * `--check` asks the same question and writes nothing, exiting non-zero when the
 * committed snapshot has fallen behind. That is the CI shape: a build bakes the
 * snapshot's values in, so a stale one deploys values nobody set, and a check
 * that could only warn would be a check nothing acted on.
 */

import { defineCommand } from "citty";
import { openProject } from "../project.js";
import {
  checkSnapshotFile,
  SNAPSHOT_FILE,
  type SnapshotStatus,
  type SnapshotWriteResult,
  type WireResult,
  wireEnvModule,
  writeSnapshotFile,
} from "../snapshot.js";
import { CHECK, CROSS, formatRows, guard, type Row, tip, WARN, write } from "../ui.js";

export interface SnapshotResult {
  readonly write: SnapshotWriteResult;
  readonly wire: WireResult;
}

export interface SnapshotCheckResult {
  readonly file: string;
  readonly status: SnapshotStatus;
}

export function runSnapshot(options: { readonly cwd: string }): SnapshotResult {
  const project = openProject(options.cwd);
  return { write: writeSnapshotFile(project), wire: wireEnvModule(project) };
}

export function runSnapshotCheck(options: { readonly cwd: string }): SnapshotCheckResult {
  return checkSnapshotFile(openProject(options.cwd));
}

export function renderSnapshotCheck(result: SnapshotCheckResult): string[] {
  switch (result.status) {
    case "current":
      return formatRows([
        {
          glyph: CHECK,
          label: "Up to date",
          subject: result.file,
          detail: "matches the committed sealed values and config",
        },
      ]);
    case "stale":
      return [
        ...formatRows([
          {
            glyph: CROSS,
            label: "Stale",
            subject: result.file,
            detail: "does not match the current sealed values or config",
          },
        ]),
        tip("penv snapshot"),
      ];
    default:
      return [
        ...formatRows([{ glyph: WARN, label: "Not committed", subject: result.file }]),
        tip("penv snapshot"),
      ];
  }
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
  args: {
    check: {
      type: "boolean",
      description: "Report whether the committed snapshot is current; write nothing, exit 1 if not",
    },
  },
  run({ args }) {
    return guard(async () => {
      if (args.check === true) {
        const result = runSnapshotCheck({ cwd: process.cwd() });
        write(renderSnapshotCheck(result));
        if (result.status !== "current") {
          process.exitCode = 1;
        }
        return;
      }
      write(renderSnapshot(runSnapshot({ cwd: process.cwd() })));
    });
  },
});
