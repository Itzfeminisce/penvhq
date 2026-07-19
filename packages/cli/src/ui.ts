/**
 * The CLI's output voice.
 *
 * Reports are tables: a glyph, a label, and the parameter the line is about.
 * Columns are sized to the widest cell in one block so that a report reads down
 * the page as well as across it, and every command that reports uses this module
 * rather than assembling its own spacing.
 *
 * Color is applied here and nowhere lower: the glyph carries the verdict (green
 * pass, yellow warning, red failure, dim "could not look"), details and asides
 * are dimmed as metadata, and a remedy is a cyan-arrowed `tip` — the one shape a
 * reader learns once and then recognizes in every command. All of it degrades to
 * the exact plain bytes when the stream is not a terminal (see `style.ts`), so
 * pipes, CI logs, and tests never see an escape code.
 */

import { PenvError } from "@penvhq/core";
import { err, out, padVisible, visibleWidth } from "./style.js";

export const CHECK = "✓";
export const WARN = "⚠";
export const CROSS = "✗";
/** "I could not look" — a check that ran but could not reach a verdict. Never a pass. */
export const UNKNOWN = "?";

/** The verdict each glyph carries, painted once here so every command agrees. */
function paintGlyph(glyph: string): string {
  switch (glyph) {
    case CHECK:
      return out.green(glyph);
    case WARN:
      return out.yellow(glyph);
    case CROSS:
      return out.red(glyph);
    case UNKNOWN:
      return out.dim(glyph);
    default:
      return glyph;
  }
}

/** One reported line. `detail` is the last column and is never padded. */
export interface Row {
  readonly glyph: string;
  readonly label: string;
  readonly subject?: string;
  readonly detail?: string;
}

/** A step in a scaffolding run: what penv did, and an aligned aside. */
export interface Step {
  readonly glyph: string;
  readonly text: string;
  readonly note?: string;
}

/** Where a step's aside starts, measured from the glyph. */
const NOTE_COLUMN = 29;

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, visibleWidth(value)), 0);
}

export function formatRows(rows: readonly Row[]): string[] {
  const labelWidth = widest(rows.map((row) => row.label)) + 2;
  // Only rows that carry a detail need their subject padded; a row whose subject
  // is its last column must not widen the table for every other row.
  const detailed = rows.filter((row) => row.detail !== undefined);
  const subjectWidth = widest(detailed.map((row) => row.subject ?? "")) + 1;

  return rows.map((row) => {
    const head = `${paintGlyph(row.glyph)} ${padVisible(row.label, labelWidth)}`;
    if (row.detail === undefined) {
      return `${head}${row.subject ?? ""}`.trimEnd();
    }
    return `${head}${padVisible(row.subject ?? "", subjectWidth)}${out.dim(row.detail)}`.trimEnd();
  });
}

/**
 * Free-form aligned columns, for output that is a table rather than a report.
 * Every column but the last is padded to its widest cell. Cells may arrive
 * styled: widths are measured on what the terminal renders, not on the bytes.
 */
export function columns(rows: readonly (readonly string[])[], gap = 2): string[] {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let column = 0; column < count; column += 1) {
    widths.push(widest(rows.map((row) => row[column] ?? "")) + gap);
  }
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : padVisible(cell, widths[index] ?? 0),
      )
      .join("")
      .trimEnd(),
  );
}

export function formatSteps(steps: readonly Step[]): string[] {
  return steps.map((step) => {
    if (step.note === undefined) {
      return `${paintGlyph(step.glyph)} ${step.text}`;
    }
    // A text wider than the column gets a single space instead of alignment.
    // `padEnd` returns the string untouched when it is already too long, so the
    // aside ran straight into the last word — legible right up until the day a
    // step had something long to say, which is the day it mattered.
    const text =
      visibleWidth(step.text) >= NOTE_COLUMN ? `${step.text} ` : padVisible(step.text, NOTE_COLUMN);
    return `${paintGlyph(step.glyph)} ${text}${out.dim(step.note)}`;
  });
}

/**
 * A command's title line: what ran, and against which environment. The context
 * is dimmed so the eye lands on the report below, not the banner above it.
 */
export function heading(command: string, context?: string): string {
  return context === undefined
    ? out.bold(command)
    : `${out.bold(command)} ${out.dim(`· ${context}`)}`;
}

/**
 * A line the reader can act on — the `penv set` to paste, the rename to make.
 * One shape for every command: an arrow, then the remedy, indented under the
 * report it belongs to.
 */
export function tip(text: string): string {
  return `  ${out.cyan("→")} ${text}`;
}

/**
 * A styled interactive question: `? parameter · context › `. Every prompt in the
 * CLI is this shape, so answering penv feels like one conversation.
 */
export function prompt(subject: string, context?: string): string {
  const head = `${out.cyan("?")} ${out.bold(subject)}`;
  const tail = out.dim("› ");
  return context === undefined ? `${head} ${tail}` : `${head} ${out.dim(`· ${context}`)} ${tail}`;
}

export function write(lines: readonly string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * A `PenvError` already names the parameter, the environment, and the remedy, so
 * it is printed as written — the remedy re-shaped into the same arrowed tip the
 * reports use. Anything else is a bug in penv and keeps its stack.
 */
export function reportError(error: unknown): void {
  if (error instanceof PenvError) {
    // The constructor folds the remedy into `message`; unfold it so the remedy
    // can wear the tip shape instead of a bare indent.
    const suffix = error.remedy === undefined ? undefined : `\n  ${error.remedy}`;
    const message =
      suffix !== undefined && error.message.endsWith(suffix)
        ? error.message.slice(0, -suffix.length)
        : error.message;
    process.stderr.write(`${err.red(CROSS)} ${message}\n`);
    if (error.remedy !== undefined) {
      process.stderr.write(`  ${err.cyan("→")} ${error.remedy}\n`);
    }
  } else if (error instanceof Error) {
    process.stderr.write(`${err.red(CROSS)} ${error.message}\n`);
    // The stack minus the message line it repeats, dimmed: it is for the bug
    // report, not the reader — but it must survive a copy-paste, so it is
    // printed rather than hidden.
    const stack = error.stack;
    const frames = stack?.startsWith(`${error.name}: ${error.message}`)
      ? stack.slice(`${error.name}: ${error.message}`.length).replace(/^\n/, "")
      : stack;
    if (frames !== undefined && frames !== "") {
      process.stderr.write(`${err.dim(frames)}\n`);
    }
  } else {
    process.stderr.write(`${err.red(CROSS)} ${String(error)}\n`);
  }
  process.exitCode = 1;
}

/** Turns a thrown error into a printed one and a non-zero exit code. */
export async function guard(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportError(error);
  }
}
