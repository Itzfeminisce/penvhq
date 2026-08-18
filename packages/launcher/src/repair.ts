/**
 * Reading a manifest that one of its own remedies is supposed to fix.
 *
 * A broken extension entry refuses with `Run \`penv add <pkg>\` to rewrite that
 * entry` — and `penv add` parsed the whole manifest before it got that far, so
 * the refusal's remedy hit the refusal. Same for `penv install`, which is what
 * every missing-package refusal names.
 *
 * So the two repair commands read the manifest through here instead: every entry
 * that validates is kept, the ones that do not are named, and nothing else is
 * relaxed. The format, the engine pin, unknown root keys and the forbidden-content
 * scan are all still full refusals — an entry cannot be repaired in a file penv
 * could not run afterwards anyway. What comes back is an ordinary `Manifest`, so
 * a broken entry can never be written back out: `penv add` restores it only by
 * resolving the package again, through `serializeManifest`, which validates.
 */

import type { Manifest } from "@penvhq/core";
import { parseManifest } from "@penvhq/core";

export interface RepairableManifest {
  /** Every entry that validates, and nothing that does not. */
  readonly manifest: Manifest;
  /** The extension names whose entries were unreadable, sorted. */
  readonly broken: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The manifest with `extensions` replaced, parsed — so every other check still runs. */
function parseWith(base: Record<string, unknown>, extensions: Record<string, unknown>): Manifest {
  return parseManifest(JSON.stringify({ ...base, extensions }));
}

export function readManifestForRepair(text: string): RepairableManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all: nothing to take apart, and `parseManifest` says it better.
    return { manifest: parseManifest(text), broken: [] };
  }

  const root = isPlainObject(parsed) ? parsed : undefined;
  const declared = root?.extensions;
  if (root === undefined || !isPlainObject(declared)) {
    // `extensions` is missing or is not a map of entries. That is not one bad
    // entry, and no `penv add` names it — the refusal for it stands.
    return { manifest: parseManifest(text), broken: [] };
  }

  const { extensions: _, ...base } = root;
  // Everything outside the entries decides first, and its refusals are unchanged.
  parseWith(base, {});

  const kept: Record<string, unknown> = {};
  const broken: string[] = [];
  for (const [name, entry] of Object.entries(declared)) {
    try {
      parseWith(base, { [name]: entry });
      kept[name] = entry;
    } catch {
      broken.push(name);
    }
  }
  return { manifest: parseWith(base, kept), broken: broken.sort() };
}
