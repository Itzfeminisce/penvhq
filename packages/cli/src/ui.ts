/**
 * The CLI's output voice.
 *
 * Reports are tables: a glyph, a label, and the parameter the line is about.
 * Columns are sized to the widest cell in one block so that a report reads down
 * the page as well as across it, and every command that reports uses this module
 * rather than assembling its own spacing.
 */

import { PenvError } from "@penv/core";

export const CHECK = "✓";
export const WARN = "⚠";

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
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

export function formatRows(rows: readonly Row[]): string[] {
  const labelWidth = widest(rows.map((row) => row.label)) + 2;
  // Only rows that carry a detail need their subject padded; a row whose subject
  // is its last column must not widen the table for every other row.
  const detailed = rows.filter((row) => row.detail !== undefined);
  const subjectWidth = widest(detailed.map((row) => row.subject ?? "")) + 1;

  return rows.map((row) => {
    const head = `${row.glyph} ${row.label.padEnd(labelWidth)}`;
    if (row.detail === undefined) {
      return `${head}${row.subject ?? ""}`.trimEnd();
    }
    return `${head}${(row.subject ?? "").padEnd(subjectWidth)}${row.detail}`.trimEnd();
  });
}

/**
 * Free-form aligned columns, for output that is a table rather than a report.
 * Every column but the last is padded to its widest cell.
 */
export function columns(rows: readonly (readonly string[])[], gap = 2): string[] {
  const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths: number[] = [];
  for (let column = 0; column < count; column += 1) {
    widths.push(widest(rows.map((row) => row[column] ?? "")) + gap);
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("")
      .trimEnd(),
  );
}

export function formatSteps(steps: readonly Step[]): string[] {
  return steps.map((step) => {
    if (step.note === undefined) {
      return `${step.glyph} ${step.text}`;
    }
    return `${step.glyph} ${step.text.padEnd(NOTE_COLUMN)}${step.note}`;
  });
}

export function write(lines: readonly string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * A `PenvError` already names the parameter, the environment, and the remedy, so
 * it is printed as written. Anything else is a bug in penv and keeps its stack.
 */
export function reportError(error: unknown): void {
  if (error instanceof PenvError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
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
