/**
 * The one-line edit `add` offers to `penv.config.ts`.
 *
 * The file is the user's, so it is scanned rather than parsed and re-emitted:
 * reformatting someone's config — dropping its comments, resorting its keys — to
 * change one string is not the edit that was offered. The scanner understands
 * exactly one thing, the `environments` block, and answers "I do not know this
 * file" for anything else rather than guessing at a rewrite.
 *
 * An entry comes in two shapes and both are repointable: the bare package string
 * is replaced whole, and the object form has its `provider` string replaced.
 */

/** One environment's declared provider, as the `environments` block writes it. */
export interface EnvironmentProvider {
  readonly environment: string;
  /** The package it names today — the shorthand string, or the entry's `provider`. */
  readonly provider: string | undefined;
}

interface ProviderSlot {
  /** The string literal a repoint replaces, quotes included. */
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface Entry extends EnvironmentProvider {
  readonly slot: ProviderSlot | undefined;
}

const QUOTES = new Set(['"', "'", "`"]);

/** The index after whitespace and comments starting at `index`. */
function skipTrivia(source: string, index: number): number {
  let i = index;
  for (;;) {
    const ch = source.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "/" && source.charAt(i + 1) === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "/" && source.charAt(i + 1) === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    return i;
  }
}

/** The index after a string or template literal opening at `index`. */
function skipString(source: string, index: number): number {
  const quote = source.charAt(index);
  let i = index + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/** The index just past the `}` matching the `{` at `open`, or -1. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (QUOTES.has(ch)) {
      i = skipString(source, i);
      continue;
    }
    const skipped = skipTrivia(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return -1;
}

/** An object key at `index` — `"name"`, `'name'` or a bare identifier — and where it ends. */
function readKey(source: string, index: number): { key: string; end: number } | undefined {
  const ch = source.charAt(index);
  if (ch === '"' || ch === "'") {
    const end = skipString(source, index);
    return { key: source.slice(index + 1, end - 1), end };
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
  return match === null ? undefined : { key: match[0], end: index + match[0].length };
}

/** The `provider: "..."` literal directly inside one entry, when it has one. */
function providerSlotIn(source: string, open: number, close: number): ProviderSlot | undefined {
  let i = skipTrivia(source, open + 1);
  while (i < close - 1) {
    const key = readKey(source, i);
    if (key === undefined) {
      return undefined;
    }
    const colon = skipTrivia(source, key.end);
    if (source.charAt(colon) !== ":") {
      return undefined;
    }
    const valueStart = skipTrivia(source, colon + 1);
    const ch = source.charAt(valueStart);
    let valueEnd: number;
    if (QUOTES.has(ch)) {
      valueEnd = skipString(source, valueStart);
      if (key.key === "provider" && ch !== "`") {
        return {
          start: valueStart,
          end: valueEnd,
          value: source.slice(valueStart + 1, valueEnd - 1),
        };
      }
    } else if (ch === "{" || ch === "[" || ch === "(") {
      valueEnd = matchBrace(source, valueStart);
      if (valueEnd === -1) {
        return undefined;
      }
    } else {
      const comma = /[,}]/.exec(source.slice(valueStart));
      valueEnd = comma === null ? close - 1 : valueStart + comma.index;
    }
    i = skipTrivia(source, valueEnd);
    if (source.charAt(i) === ",") {
      i = skipTrivia(source, i + 1);
    }
  }
  return undefined;
}

/** The `environments` block's entries, or `undefined` for a config penv cannot read. */
function scan(source: string): Entry[] | undefined {
  const found = /(?:^|[\s{,;])environments\s*:\s*\{/.exec(source);
  if (found === null) {
    return undefined;
  }
  const open = found.index + found[0].length - 1;
  const close = matchBrace(source, open);
  if (close === -1) {
    return undefined;
  }

  const entries: Entry[] = [];
  let i = skipTrivia(source, open + 1);
  while (i < close - 1) {
    const key = readKey(source, i);
    if (key === undefined) {
      return undefined;
    }
    const colon = skipTrivia(source, key.end);
    if (source.charAt(colon) !== ":") {
      return undefined;
    }
    const entryOpen = skipTrivia(source, colon + 1);
    const ch = source.charAt(entryOpen);
    let entryEnd: number;
    let slot: ProviderSlot | undefined;
    if (ch === "{") {
      entryEnd = matchBrace(source, entryOpen);
      if (entryEnd === -1) {
        return undefined;
      }
      slot = providerSlotIn(source, entryOpen, entryEnd);
    } else if (QUOTES.has(ch)) {
      // The shorthand: the whole value is the package, so the whole value is the slot.
      entryEnd = skipString(source, entryOpen);
      slot =
        ch === "`"
          ? undefined
          : {
              start: entryOpen,
              end: entryEnd,
              value: source.slice(entryOpen + 1, entryEnd - 1),
            };
    } else {
      return undefined;
    }
    entries.push({ environment: key.key, provider: slot?.value, slot });
    i = skipTrivia(source, entryEnd);
    if (source.charAt(i) === ",") {
      i = skipTrivia(source, i + 1);
    }
  }
  return entries;
}

/** Every environment the `environments` block names, in the order the file declares them. */
export function readEnvironmentProviders(source: string): EnvironmentProvider[] | undefined {
  return scan(source)?.map(({ environment, provider }) => ({ environment, provider }));
}

/** The same text with one environment pointed at `provider`, or `undefined` if it cannot be. */
export function setEnvironmentProvider(
  source: string,
  environment: string,
  provider: string,
): string | undefined {
  const entry = scan(source)?.find((candidate) => candidate.environment === environment);
  if (entry?.slot === undefined) {
    return undefined;
  }
  return `${source.slice(0, entry.slot.start)}${JSON.stringify(provider)}${source.slice(entry.slot.end)}`;
}
