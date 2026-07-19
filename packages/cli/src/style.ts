/**
 * The CLI's palette.
 *
 * One restrained set of meanings, applied everywhere: green is a verdict that
 * passed, yellow one that warns, red one that failed; cyan marks the actionable —
 * a prompt, a command to paste; dim is metadata the eye should be able to skip.
 * Nothing else gets a color, so a colored word is always a signal.
 *
 * Styling is a property of the stream, not the text: a terminal gets color, a
 * pipe and a test get the exact bytes the plain renderer always produced. The
 * switch honors `NO_COLOR` and `FORCE_COLOR` (in that order — an explicit "no"
 * wins), then falls back to whether the stream is a TTY.
 */

interface ColorStream {
  readonly isTTY?: boolean;
}

function supportsColor(stream: ColorStream): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return stream.isTTY === true;
}

/** Wraps text in one style. Identity when the palette's stream has no color. */
export type Paint = (text: string) => string;

export interface Palette {
  readonly enabled: boolean;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly red: Paint;
  readonly green: Paint;
  readonly yellow: Paint;
  readonly cyan: Paint;
  readonly magenta: Paint;
}

const ESC = `${String.fromCharCode(27)}[`;
const identity: Paint = (text) => text;

function sgr(open: number, close: number, on: boolean): Paint {
  if (!on) {
    return identity;
  }
  const opener = `${ESC}${open}m`;
  const closer = `${ESC}${close}m`;
  return (text) => `${opener}${text}${closer}`;
}

function paletteFor(stream: ColorStream): Palette {
  const on = supportsColor(stream);
  return {
    enabled: on,
    bold: sgr(1, 22, on),
    dim: sgr(2, 22, on),
    red: sgr(31, 39, on),
    green: sgr(32, 39, on),
    yellow: sgr(33, 39, on),
    cyan: sgr(36, 39, on),
    magenta: sgr(35, 39, on),
  };
}

/** The report palette — everything written through `ui.write`. */
export const out: Palette = paletteFor(process.stdout);

/** The error palette — `reportError` writes to stderr, whose TTY-ness is its own. */
export const err: Palette = paletteFor(process.stderr);

/**
 * The width a terminal renders, with the style sequences that surround the text
 * counted at zero. Alignment must measure what the reader sees, or a styled cell
 * would push every column after it out of true.
 */
const STYLE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function visibleWidth(text: string): number {
  return text.replace(STYLE_PATTERN, "").length;
}

/** `padEnd` measured on visible width, so styled and plain cells align in one table. */
export function padVisible(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}
