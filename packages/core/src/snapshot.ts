/**
 * The committed snapshot's inputs, and the digest that binds it to them.
 *
 * A snapshot is a projection of two things: the evaluated config, and the sealed
 * value files the tree holds. Without a link back to those inputs the projection
 * is unverifiable — a `penv set` plus a seal, with no re-run of `penv snapshot`,
 * bakes one value into the build and serves another at runtime, and nothing says
 * so. The digest is that link: `penv snapshot --check` recomputes it in CI, and
 * `load()` compares it against the tree it just read whenever both a config file
 * and a snapshot are present.
 *
 * Which values a snapshot embeds is decided here rather than in the CLI, because
 * the runtime has to recompute the same set from the same tree to compare — two
 * implementations of "the sealed inputs" would drift, and the drift check would
 * be the thing that reported it.
 */

import { createHash } from "node:crypto";
import { formatValueFile } from "./grammar.js";
import type { PenvConfig, ValueFile } from "./types.js";

/** The synchronous read surface a snapshot is built from. */
export interface SyncValueSource {
  listSync(): ValueFile[];
  readSync(file: ValueFile): string | undefined;
}

/**
 * The sealed value files of a tree, keyed by grammar address, code-unit sorted.
 *
 * Sealed records only, by decision: the snapshot ships exactly what a git clone
 * already sees — ciphertext, safe to commit — and never plaintext, at any scope,
 * nor either `.local` scope. Determinism is what makes a text compare a drift
 * check.
 */
export function sealedSnapshotValues(source: SyncValueSource): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const file of source.listSync()) {
    if (!file.encrypted) {
      continue;
    }
    if (file.scope.kind === "local" || file.scope.kind === "environment-local") {
      continue;
    }
    const stored = source.readSync(file);
    if (stored === undefined) {
      continue;
    }
    collected[formatValueFile(file)] = stored;
  }
  const values: Record<string, string> = {};
  for (const key of Object.keys(collected).sort()) {
    values[key] = collected[key] as string;
  }
  return values;
}

/** True for the values `JSON.stringify` drops from an object and nulls in an array. */
function hasNoJsonForm(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * JSON with every object's keys in code-unit order, so the digest depends on the
 * config's content and not on the order a module happened to declare it in.
 *
 * `JSON.stringify`'s own rules otherwise, to the letter, because the config this
 * digests is a live module on one side and a JSON round trip of that module on
 * the other — a digest that disagreed with JSON about either would report drift
 * between two spellings of the same config.
 */
function canonical(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value === null || typeof value !== "object") {
    return hasNoJsonForm(value) ? "null" : (JSON.stringify(value) ?? "null");
  }
  // A cycle is a config `JSON.stringify` would refuse; refusing by name beats a
  // stack overflow at process boot.
  if (seen.has(value)) {
    throw new TypeError("penv cannot digest a configuration that contains a circular reference");
  }
  seen.add(value);

  const rendered = Array.isArray(value)
    ? `[${value.map((entry) => canonical(entry, seen)).join(",")}]`
    : (() => {
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .sort()
          .filter((key) => !hasNoJsonForm(record[key]))
          .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`);
        return `{${entries.join(",")}}`;
      })();

  seen.delete(value);
  return rendered;
}

/**
 * The digest of the inputs a snapshot projects. Recomputing it from a tree and
 * comparing is the whole staleness check — `snapshot.digest` is what the build
 * baked, and this is what the tree now says.
 */
export function snapshotDigest(
  config: PenvConfig,
  values: Readonly<Record<string, string>>,
): string {
  const hash = createHash("sha256").update(canonical({ config, values }), "utf8").digest("hex");
  return `sha256:${hash}`;
}
