/**
 * The read source `resolveSync` walks when there is no `penv.config.ts` on disk —
 * a bundled or serverless runtime, where the filesystem provider has nothing to
 * read. It answers the same `listSync()`/`readSync()` shape the resolution loop
 * already consumes from the filesystem provider, so the cascade, decryption, and
 * validation downstream are byte-identical; only the byte source changes.
 *
 * The grammar stays core's: `listSync` re-parses each embedded key through
 * `parseFilename`, so a snapshot address is read exactly as the filesystem walker
 * would read the file it names, and `readSync` is a record lookup keyed by
 * `formatValueFile`. There is one filename authority, and this is not a second.
 */

import type { PenvSnapshot, ValueFile } from "@penvhq/core";
import { formatValueFile, parseFilename } from "@penvhq/core";

/** The synchronous read surface the value cascade consumes. */
export interface SnapshotProvider {
  listSync(): ValueFile[];
  readSync(file: ValueFile): string | undefined;
}

export function createSnapshotProvider(snapshot: PenvSnapshot): SnapshotProvider {
  const { config, values } = snapshot;
  return {
    listSync() {
      const files: ValueFile[] = [];
      for (const key of Object.keys(values)) {
        const parsed = parseFilename(key, config);
        if (parsed.kind === "value") {
          files.push({
            namespace: parsed.namespace,
            name: parsed.name,
            scope: parsed.scope,
            encrypted: parsed.encrypted,
          });
        }
      }
      return files;
    },
    readSync(file) {
      return values[formatValueFile(file)];
    },
  };
}
