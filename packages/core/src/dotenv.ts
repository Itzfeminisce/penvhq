/**
 * The dotenv parser and serializer.
 *
 * `import` then `generate` must round-trip every key and value losslessly. What
 * survives is the record, not the presentation: a comment block attached to a
 * variable becomes that parameter's description, ordering is the caller's to
 * decide, and blank lines are discarded — one-value-per-file has nowhere to keep
 * them. Orphan comments are dropped but counted, so `import` can report exactly
 * what it could not carry across.
 *
 * Parsing is dotenv-compatible and stays that way: a quoted value legitimately runs
 * across newlines, so the scanners do not stop at the line end. That compatibility
 * has a cost — an unclosed quote can silently eat the next assignment — and import
 * is the moment `.penv/` becomes the source of truth. So the parser reports what it
 * cannot be sure about instead of guessing: the semantics never change, and the
 * caller gets `diagnostics` to surface.
 */

/** One `KEY=VALUE` record, plus the comment block that sat directly above it. */
export interface DotenvEntry {
  readonly key: string;
  readonly value: string;
  /** The attached comment block, `#` markers stripped, lines joined with `\n`. */
  readonly description?: string;
}

/**
 * Something the parser read successfully but that the author probably did not mean.
 * Never an error — the entry is produced exactly as dotenv would produce it — but
 * never silent either.
 */
export interface DotenvDiagnostic {
  readonly kind: "value-spans-lines" | "trailing-characters-after-quote";
  /** The key whose value the diagnostic is about. */
  readonly key: string;
  /** 1-based line of the assignment or the closing quote the diagnostic points at. */
  readonly line: number;
  readonly detail: string;
}

export interface DotenvParseResult {
  readonly entries: readonly DotenvEntry[];
  /**
   * How many comment blocks were attached to nothing — a file header, or a block
   * a blank line separated from the next variable. Counted per block, not per line.
   */
  readonly orphanComments: number;
  /** Values that parsed cleanly but read like a mistake. Empty for a healthy file. */
  readonly diagnostics: readonly DotenvDiagnostic[];
}

/** Leading whitespace, an optional `export`, the key, and the equals sign. */
const KEY_ASSIGNMENT = /[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=/y;

/** Characters that cannot survive a bare emit and force double quoting. */
const BARE_UNSAFE = /["'#\n\r]/;

/**
 * The signature of a swallowed variable: the value ends on a later line with a bare
 * `KEY=` and nothing after it, because the quote that closed this value was really
 * the *opening* quote of `KEY`'s value.
 *
 * Anchoring at the end is what keeps this quiet on honest multi-line values. A PEM
 * block ends in `-----END ...-----`, a JSON blob ends in `}`, and an ini-ish blob's
 * `key=value` lines have their value after the equals sign — none of them end with a
 * dangling assignment. Firing here on a real value would be worse than not firing at
 * all, so the rule only speaks when the shape is unambiguous.
 */
const SWALLOWED_ASSIGNMENT = /\n[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=$/;

function countNewlines(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charAt(i) === "\n") total += 1;
  return total;
}

interface ScannedValue {
  readonly value: string;
  /** Index just past the closing quote. */
  readonly end: number;
}

/** Single-quoted values are literal: no escapes, no interpolation, newlines kept. */
function scanSingleQuoted(source: string, start: number): ScannedValue | undefined {
  const close = source.indexOf("'", start + 1);
  if (close === -1) return undefined;
  return { value: source.slice(start + 1, close), end: close + 1 };
}

/** Double-quoted values process `\n` `\r` `\t` `\\` `\"`. Any other escape stays literal. */
function scanDoubleQuoted(source: string, start: number): ScannedValue | undefined {
  let out = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === "\\" && i + 1 < source.length) {
      const next = source.charAt(i + 1);
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "\\") out += "\\";
      else if (next === '"') out += '"';
      else out += `\\${next}`;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return undefined;
}

/**
 * An unquoted value: trimmed, inner whitespace kept. A hash preceded by
 * whitespace opens an inline comment; a hash with no whitespace before it — a URL
 * fragment — belongs to the value. `segment` starts immediately after the `=`, so
 * a hash at index 0 was preceded by the equals sign, not whitespace.
 */
function readUnquoted(segment: string): string {
  for (let i = 1; i < segment.length; i += 1) {
    if (segment.charAt(i) !== "#") continue;
    const before = segment.charAt(i - 1);
    if (before === " " || before === "\t") return segment.slice(0, i).trim();
  }
  return segment.trim();
}

/** Strips the `#` marker and the single space conventionally following it. */
function stripCommentMarker(line: string): string {
  const body = line.trim().slice(1);
  return body.startsWith(" ") ? body.slice(1) : body;
}

function makeEntry(key: string, value: string, comments: readonly string[]): DotenvEntry {
  return comments.length > 0 ? { key, value, description: comments.join("\n") } : { key, value };
}

export function parseDotenv(source: string): DotenvParseResult {
  const entries: DotenvEntry[] = [];
  const diagnostics: DotenvDiagnostic[] = [];
  const positionByKey = new Map<string, number>();
  let orphanComments = 0;
  let pending: string[] = [];
  let pos = 0;

  // Line numbers are counted forward as the parser advances; `pos` only ever moves
  // right, so each index is charged once.
  let countedTo = 0;
  let countedLine = 1;
  const lineAt = (index: number): number => {
    countedLine += countNewlines(source.slice(countedTo, index));
    countedTo = index;
    return countedLine;
  };

  const dropPending = (): void => {
    if (pending.length > 0) {
      orphanComments += 1;
      pending = [];
    }
  };

  /** Reads the value as dotenv does, then says what looks wrong about it. */
  const inspectQuoted = (
    key: string,
    assignmentLine: number,
    open: number,
    scanned: ScannedValue,
  ): void => {
    const spanned = countNewlines(source.slice(open, scanned.end));
    const closingLine = assignmentLine + spanned;

    if (spanned > 0) {
      const swallowed = SWALLOWED_ASSIGNMENT.exec(scanned.value)?.[1];
      if (swallowed !== undefined) {
        diagnostics.push({
          kind: "value-spans-lines",
          key,
          line: assignmentLine,
          detail:
            `The value of ${key} spans lines ${assignmentLine}-${closingLine} and ends with ` +
            `the assignment ${swallowed}=, so ${swallowed} was read as part of ${key}'s value ` +
            `instead of as its own variable. ${key}'s opening quote on line ${assignmentLine} ` +
            `is probably unclosed — close it, and ${swallowed} will parse on its own.`,
        });
      }
    }

    const lineBreak = source.indexOf("\n", scanned.end);
    const tailEnd = lineBreak === -1 ? source.length : lineBreak;
    const tail = source.slice(scanned.end, tailEnd).replace(/\r$/, "").trim();
    // A closing quote is normally the end of the line, bar an inline comment. Anything
    // else on it was read and thrown away, which the author must hear about.
    if (tail !== "" && !tail.startsWith("#")) {
      diagnostics.push({
        kind: "trailing-characters-after-quote",
        key,
        line: closingLine,
        detail:
          `The value of ${key} is followed by ${JSON.stringify(tail)} after its closing quote ` +
          `on line ${closingLine}, and those characters are not part of the value. Quote the ` +
          `whole value, or escape the quote that ends it early.`,
      });
    }
  };

  while (pos < source.length) {
    const newline = source.indexOf("\n", pos);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(pos, lineEnd);
    const trimmed = line.trim();

    if (trimmed === "") {
      dropPending();
      pos = lineEnd + 1;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pending.push(stripCommentMarker(line));
      pos = lineEnd + 1;
      continue;
    }

    KEY_ASSIGNMENT.lastIndex = pos;
    const match = KEY_ASSIGNMENT.exec(source);
    const key = match?.[1];
    if (!match || key === undefined) {
      dropPending();
      pos = lineEnd + 1;
      continue;
    }

    const valueStart = KEY_ASSIGNMENT.lastIndex;
    let cursor = valueStart;
    while (source.charAt(cursor) === " " || source.charAt(cursor) === "\t") cursor += 1;
    const opener = source.charAt(cursor);

    let value: string;
    let after: number;
    const scanned =
      opener === "'"
        ? scanSingleQuoted(source, cursor)
        : opener === '"'
          ? scanDoubleQuoted(source, cursor)
          : undefined;

    if (scanned) {
      value = scanned.value;
      after = scanned.end;
      inspectQuoted(key, lineAt(pos), cursor, scanned);
    } else {
      // An unterminated quote is not a value spanning the rest of the file: dotenv
      // keeps the quote as an ordinary character and the value ends with the line.
      const carriage = source.charAt(lineEnd - 1) === "\r" ? lineEnd - 1 : lineEnd;
      value = readUnquoted(source.slice(valueStart, Math.max(valueStart, carriage)));
      after = lineEnd;
    }

    const existing = positionByKey.get(key);
    const entry = makeEntry(key, value, pending);
    if (existing === undefined) {
      positionByKey.set(key, entries.length);
      entries.push(entry);
    } else {
      // A later duplicate wins outright, description included, and keeps the
      // first occurrence's slot rather than becoming a second entry.
      entries[existing] = entry;
    }
    pending = [];

    const tailNewline = source.indexOf("\n", after);
    pos = tailNewline === -1 ? source.length : tailNewline + 1;
  }

  dropPending();
  return { entries, orphanComments, diagnostics };
}

function needsQuoting(value: string): boolean {
  if (value === "") return false;
  if (BARE_UNSAFE.test(value)) return true;
  return value !== value.trim();
}

function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/** Emits entries in the order given — the caller decides order; this does not sort. */
export function serializeDotenv(entries: readonly DotenvEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const description = entry.description;
    if (description !== undefined) {
      if (lines.length > 0) lines.push("");
      for (const line of description.split("\n")) {
        lines.push(line === "" ? "#" : `# ${line}`);
      }
    }
    const value = entry.value;
    lines.push(`${entry.key}=${needsQuoting(value) ? quote(value) : value}`);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
