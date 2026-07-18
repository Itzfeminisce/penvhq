/**
 * A retaining provider backed by a JSON file on disk.
 *
 * It satisfies the same `@penvhq/core` provider contract the filesystem does, but
 * differs in the one way that makes a `dual-valid` rehearsal possible: it retains
 * previous versions. Each value-file address maps to an *ordered list* of
 * versions; a write appends, a read returns the newest, and `readPrevious`
 * returns the one before it. That is the whole capability {@link RetainingProvider}
 * asks for — "give me the previous value" — and nothing more (no TTL, no count,
 * no window: penv owns the grace-window clock).
 *
 * Two properties keep it honest, mirroring the in-memory contract fixture:
 *  - Values and meta live under disjoint keyspaces, so a written meta can never be
 *    returned by `list()` as though it were a value.
 *  - Meta round-trips through JSON, so nothing hands back a live object reference a
 *    caller could mutate after the fact.
 *
 * Unlike that fixture it persists to a JSON file, read on each op and rewritten
 * after each mutation, so a second CLI invocation pointed at the same `storePath`
 * sees prior writes. That is what lets a rotation be rehearsed across processes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Meta, ParameterRef, RetainingProvider, Scope, ValueFile } from "@penvhq/core";
import { assertNever } from "@penvhq/core";

export interface MockProviderOptions {
  /**
   * Absolute path to the JSON file the provider persists to. It is read on every
   * op and rewritten after every mutation, so two providers sharing a path share
   * a store — the mechanism that survives across CLI invocations.
   */
  readonly storePath: string;
}

/** Every scope that carries an environment keys on it, so two environments never collide. */
function scopeKey(scope: Scope): string {
  switch (scope.kind) {
    case "unscoped":
      return "unscoped";
    case "environment":
      return `environment:${scope.environment}`;
    case "local":
      return "local";
    case "environment-local":
      return `environment-local:${scope.environment}`;
    default:
      return assertNever(scope, "scope");
  }
}

/**
 * Every contract field of a value file joined into one key. ` ` never appears
 * in a namespace segment, name, or scope, so it separates them unambiguously, and
 * `encrypted` is part of the key so a sealed value never aliases its plaintext.
 */
function valueKey(file: ValueFile): string {
  return [file.namespace.join("/"), file.name, scopeKey(file.scope), String(file.encrypted)].join(
    " ",
  );
}

function metaKey(ref: ParameterRef): string {
  return [ref.namespace.join("/"), ref.name].join(" ");
}

/** A defensive copy, so a caller mutating the file it handed us cannot reach the store. */
function cloneValueFile(file: ValueFile): ValueFile {
  return {
    namespace: [...file.namespace],
    name: file.name,
    scope: file.scope,
    encrypted: file.encrypted,
  };
}

/**
 * One address's history: the file it addresses (for `list`) and its versions
 * oldest-first, so the last element is the current value and the second-to-last
 * is what `readPrevious` returns.
 */
interface VersionedEntry {
  readonly file: ValueFile;
  readonly versions: string[];
}

/**
 * The on-disk shape. Values and meta are separate maps under disjoint keyspaces,
 * mirroring the in-memory fixture so a written meta is never listed as a value.
 */
interface PersistedStore {
  readonly values: Record<string, VersionedEntry>;
  readonly meta: Record<string, string>;
}

function emptyStore(): PersistedStore {
  return { values: {}, meta: {} };
}

export class MockProvider implements RetainingProvider {
  readonly type = "mock";

  readonly #storePath: string;

  constructor(options: MockProviderOptions) {
    this.#storePath = options.storePath;
  }

  /** The JSON file this provider persists to, absolute. */
  get storePath(): string {
    return this.#storePath;
  }

  async read(file: ValueFile): Promise<string | undefined> {
    const versions = this.#load().values[valueKey(file)]?.versions;
    // The newest version is the current value; an empty history reads as absent.
    return versions === undefined || versions.length === 0
      ? undefined
      : versions[versions.length - 1];
  }

  /**
   * Reads the value held before the current one, or `undefined` when the address
   * has fewer than two versions. Absence is never an error: a provider that has
   * pruned its history, or one written only once, has no previous value to give,
   * and penv's timer and the store's retention do not commute.
   */
  async readPrevious(file: ValueFile): Promise<string | undefined> {
    const versions = this.#load().values[valueKey(file)]?.versions;
    return versions === undefined || versions.length < 2
      ? undefined
      : versions[versions.length - 2];
  }

  async write(file: ValueFile, value: string): Promise<void> {
    const store = this.#load();
    const key = valueKey(file);
    const existing = store.values[key];
    // Append a version rather than overwrite, so the prior value survives as history.
    const versions = existing === undefined ? [] : [...existing.versions];
    versions.push(value);
    store.values[key] = { file: cloneValueFile(file), versions };
    this.#save(store);
  }

  async list(): Promise<ValueFile[]> {
    // An address with no surviving versions holds no value, so it is not listed.
    return Object.values(this.#load().values)
      .filter((entry) => entry.versions.length > 0)
      .map((entry) => cloneValueFile(entry.file));
  }

  async remove(file: ValueFile): Promise<void> {
    const store = this.#load();
    delete store.values[valueKey(file)];
    this.#save(store);
  }

  async readMeta(ref: ParameterRef): Promise<Meta | undefined> {
    const stored = this.#load().meta[metaKey(ref)];
    return stored === undefined ? undefined : (JSON.parse(stored) as Meta);
  }

  async writeMeta(ref: ParameterRef, meta: Meta): Promise<void> {
    const store = this.#load();
    store.meta[metaKey(ref)] = JSON.stringify(meta);
    this.#save(store);
  }

  async removeMeta(ref: ParameterRef): Promise<void> {
    const store = this.#load();
    delete store.meta[metaKey(ref)];
    this.#save(store);
  }

  /** Reads the store fresh on every op; a missing file is an empty store, not an error. */
  #load(): PersistedStore {
    let contents: string;
    try {
      contents = readFileSync(this.#storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
      throw error;
    }
    const parsed = JSON.parse(contents) as Partial<PersistedStore>;
    return {
      values: parsed.values ?? {},
      meta: parsed.meta ?? {},
    };
  }

  #save(store: PersistedStore): void {
    mkdirSync(dirname(this.#storePath), { recursive: true });
    writeFileSync(this.#storePath, JSON.stringify(store, null, 2), "utf8");
  }
}

export function createMockProvider(options: MockProviderOptions): MockProvider {
  return new MockProvider(options);
}
