/**
 * The `PENV_DEBUG=1` account of how a load resolved.
 *
 * It goes to stderr. A program's stdout belongs to the program, and a diagnostic
 * that lands in a piped payload is a diagnostic that corrupts it.
 */

const DEBUG_ENV = "PENV_DEBUG";

/** True when the caller asked for the resolution summary. */
export function debugEnabled(): boolean {
  const value = process.env[DEBUG_ENV];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function debug(lines: readonly string[]): void {
  if (!debugEnabled()) {
    return;
  }
  process.stderr.write(`${lines.map((line) => `penv: ${line}`).join("\n")}\n`);
}
