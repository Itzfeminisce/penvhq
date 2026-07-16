/**
 * The reference provider, and the ground truth for the provider contract.
 *
 * The contract in `@penv/core` is the shape every provider satisfies; this
 * module implements it against a `.penv/` directory and never bends it to suit
 * the filesystem. The sync read path below is *additional* to the contract, not
 * a replacement for it: the runtime `load(schema)` is synchronous, and a
 * network-backed provider still satisfies the async contract unchanged.
 */

import type { Dirent } from "node:fs";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Meta, ParameterRef, PenvConfig, Provider, ValueFile } from "@penv/core";
import {
  formatMetaFile,
  formatValueFile,
  isParameterFile,
  parseFilename,
  parseMeta,
  serializeMeta,
} from "@penv/core";

/** The only meta format parsed today. The grammar reserves `toml` and `yml`. */
const META_FORMAT = "json";

export interface FilesystemProviderOptions {
  readonly root: string;
  /**
   * Required because `list()` parses environment segments, and a segment is an
   * environment only if the config declares it — never inferred from the tree.
   */
  readonly config: PenvConfig;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export class FilesystemProvider implements Provider {
  readonly type = "filesystem";

  readonly #root: string;
  readonly #config: PenvConfig;

  constructor(options: FilesystemProviderOptions) {
    this.#root = resolve(options.root);
    this.#config = options.config;
  }

  /** The `.penv/` directory this provider is rooted at, absolute. */
  get root(): string {
    return this.#root;
  }

  /*
   * The async methods are `async` rather than `Promise.resolve(...)` wrappers so
   * that a grammar error surfaces as a rejection. A contract method returning a
   * promise must never throw synchronously — no caller of the contract expects
   * both failure channels.
   */

  async read(file: ValueFile): Promise<string | undefined> {
    return this.readSync(file);
  }

  async write(file: ValueFile, value: string): Promise<void> {
    this.writeSync(file, value);
  }

  async list(): Promise<ValueFile[]> {
    return this.listSync();
  }

  async remove(file: ValueFile): Promise<void> {
    this.removeSync(file);
  }

  async readMeta(ref: ParameterRef): Promise<Meta | undefined> {
    return this.readMetaSync(ref);
  }

  async writeMeta(ref: ParameterRef, meta: Meta): Promise<void> {
    this.writeMetaSync(ref, meta);
  }

  /**
   * The value, with the one trailing newline the file was written with removed.
   * No other whitespace is touched — a value is opaque bytes.
   */
  readSync(file: ValueFile): string | undefined {
    const contents = this.#readFile(this.#pathOf(formatValueFile(file)));
    if (contents === undefined) return undefined;
    return contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  }

  listSync(): ValueFile[] {
    const files: ValueFile[] = [];
    this.#walk(this.#root, [], files);
    return files;
  }

  readMetaSync(ref: ParameterRef): Meta | undefined {
    const relative = formatMetaFile({ ...ref, format: META_FORMAT });
    const contents = this.#readFile(this.#pathOf(relative));
    if (contents === undefined) return undefined;
    return parseMeta(contents, relative);
  }

  writeSync(file: ValueFile, value: string): void {
    this.#writeFile(formatValueFile(file), `${value}\n`);
  }

  writeMetaSync(ref: ParameterRef, meta: Meta): void {
    this.#writeFile(formatMetaFile({ ...ref, format: META_FORMAT }), serializeMeta(meta));
  }

  removeSync(file: ValueFile): void {
    const path = this.#pathOf(formatValueFile(file));
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) throw error;
      return;
    }
    this.#pruneEmpty(dirname(path));
  }

  #pathOf(relativePosix: string): string {
    return join(this.#root, ...relativePosix.split("/"));
  }

  #readFile(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "EISDIR")) return undefined;
      throw error;
    }
  }

  #writeFile(relativePosix: string, contents: string): void {
    const path = this.#pathOf(relativePosix);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  /** Namespaces are folders, so a namespace with no parameters left is no namespace. */
  #pruneEmpty(directory: string): void {
    let current = directory;
    while (current !== this.#root && current.startsWith(this.#root + sep)) {
      try {
        rmdirSync(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  #walk(directory: string, namespace: readonly string[], out: ValueFile[]): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }

    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        this.#walk(join(directory, entry.name), [...namespace, entry.name], out);
        continue;
      }
      /*
       * The tree holds files penv never wrote — `.DS_Store`, `.gitignore`,
       * editor swap files — plus `env.ts`. Ignoring them is not leniency about
       * the grammar: anything that *is* claiming to be a parameter is still
       * parsed in full, and its grammar error still propagates. penv ignores
       * files that never claimed to be parameters, and complains loudly about
       * ones that do.
       */
      const relativePath = [...namespace, entry.name].join("/");
      if (!isParameterFile(relativePath)) continue;

      const parsed = parseFilename(relativePath, this.#config);
      if (parsed.kind === "value") {
        out.push({
          namespace: parsed.namespace,
          name: parsed.name,
          scope: parsed.scope,
          encrypted: parsed.encrypted,
        });
      }
    }
  }
}

export function createFilesystemProvider(options: FilesystemProviderOptions): FilesystemProvider {
  return new FilesystemProvider(options);
}
