/**
 * The HashiCorp Vault KV v2 provider — the milestone proof that a `providers.*.type`
 * can move off the filesystem with zero application edits.
 *
 * It satisfies the same `@penvhq/core` contract the filesystem does and never bends
 * it to suit Vault: a value is opaque bytes stored under one fixed data key, meta
 * is a sibling record at its own path, and `list()` reconstructs every `ValueFile`
 * from the path it was written to. The one capability beyond the base contract is
 * retention — Vault versions every write, so {@link VaultProvider} is a
 * {@link RetainingProvider} and can hand back the value a parameter held before its
 * current one.
 *
 * Vault is reached only through an injected {@link VaultTransport}. The default one
 * shells out to the `vault` CLI (see `./transport.ts`), so penv holds no Vault
 * credential of its own — `VAULT_ADDR`/`VAULT_TOKEN` stay the CLI's. Tests inject a
 * faithful in-memory KV v2 fake instead, which is what the contract suite runs
 * against.
 */

import type { Meta, ParameterRef, RetainingProvider, Scope, ValueFile } from "@penvhq/core";
import {
  formatMetaFile,
  formatValueFile,
  META_FORMATS,
  parseMeta,
  serializeMeta,
} from "@penvhq/core";
import { VaultKvVersionError } from "./errors.js";
import { defaultVaultTransport } from "./transport.js";

/**
 * The KV v2 data-plane operations the adapter needs, and nothing wider. Modelled
 * so a fake can implement it exactly (see `createInMemoryKvV2` in the tests) and
 * the real CLI transport implements the same surface — the injection seam that
 * keeps a live Vault out of the contract proof.
 *
 * Every `path` is relative to the mount; the transport owns the mount (a KV v2
 * concern, not penv's), so `mountVersion` takes no path.
 */
export interface VaultTransport {
  /**
   * Reads the data at a path. Resolves to `undefined` when the path holds nothing.
   * With `version`, reads that specific version — the read {@link VaultProvider.readPrevious}
   * is built on; resolves to `undefined` when that version was pruned.
   */
  readData(path: string, version?: number): Promise<Record<string, string> | undefined>;
  /** Writes data at a path, creating a new version. */
  writeData(path: string, data: Record<string, string>): Promise<void>;
  /** The current version number at a path, or `undefined` when the path holds nothing. */
  currentVersion(path: string): Promise<number | undefined>;
  /** Destroys every version at a path. Absent is not an error, mirroring `remove`. */
  deleteMetadata(path: string): Promise<void>;
  /**
   * Lists one level below a path. A key ending in `/` is a sub-directory; every
   * other key is a leaf secret. An absent path lists as `[]` — Vault's LIST of a
   * path holding nothing is empty, never an error.
   */
  listKeys(path: string): Promise<string[]>;
  /** The KV engine version of the mount. Anything but `2` is refused at first use. */
  mountVersion(): Promise<number>;
}

export interface VaultProviderOptions {
  /**
   * The provider-side base path penv maps records onto, from `providers.*.path`.
   * The one `ProviderConfig.path` field, in its first real use: the mapping is
   * explicit config, never inferred.
   */
  readonly path: string;
  /**
   * The KV mount to talk to. Defaults to `VAULT_MOUNT` then `secret`. Used only to
   * build the default CLI transport — an injected transport owns its own mount.
   */
  readonly mount?: string;
  /** The transport. Defaults to shelling out to the `vault` CLI; injected in tests. */
  readonly transport?: VaultTransport;
}

/** The one data key a value or meta record is stored under. A value is opaque; this is its envelope. */
const DATA_KEY = "value";

const ENC = "enc";
const LOCAL = "local";

/** Joins path parts into a single mount-relative path, dropping empty segments. */
function joinPath(...parts: readonly string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment.length > 0)
    .join("/");
}

function isMetaFormat(segment: string): boolean {
  return (META_FORMATS as readonly string[]).includes(segment);
}

/** A leaf that penv wrote, reconstructed. `undefined` for a key the adapter never wrote. */
type ParsedLeaf =
  | {
      readonly kind: "value";
      readonly name: string;
      readonly scope: Scope;
      readonly encrypted: boolean;
    }
  | { readonly kind: "meta"; readonly name: string };

/**
 * Reverses the leaf grammar {@link formatValueFile}/{@link formatMetaFile} produce.
 *
 * Unlike the filesystem's `parseFilename`, this needs no config: the store holds
 * only keys penv itself wrote, never a hand-authored file, so the
 * environment-vs-name ambiguity a config resolves cannot arise. Every segment
 * after the name is a real environment name — `enc`, `local`, and the meta formats
 * are all reserved and can never be one — or the terminal `local`/`enc` markers.
 * That makes the mapping deterministic and reversible from the path alone.
 */
function parseLeaf(leaf: string): ParsedLeaf | undefined {
  const segments = leaf.split(".");
  const name = segments[0];
  if (name === undefined || name.length === 0) return undefined;

  let rest = segments.slice(1);

  // Meta is `<name>.json` and never carries a scope or `.enc`, so detect it before
  // touching either — it is a sibling record, excluded from every value listing.
  if (rest.length === 1 && rest[0] !== undefined && isMetaFormat(rest[0])) {
    return { kind: "meta", name };
  }

  let encrypted = false;
  if (rest[rest.length - 1] === ENC) {
    encrypted = true;
    rest = rest.slice(0, -1);
  }

  const first = rest[0];
  const second = rest[1];

  let scope: Scope;
  if (first === undefined) {
    scope = { kind: "unscoped" };
  } else if (second === undefined) {
    scope = first === LOCAL ? { kind: "local" } : { kind: "environment", environment: first };
  } else if (second === LOCAL) {
    scope = { kind: "environment-local", environment: first };
  } else {
    // Not a shape penv writes; skip it rather than guess.
    return undefined;
  }

  return { kind: "value", name, scope, encrypted };
}

export class VaultProvider implements RetainingProvider {
  readonly type = "vault";

  readonly #base: string;
  readonly #transport: VaultTransport;
  readonly #mount: string;

  /** Memoized KV-version assertion: checked once, on the first operation, then reused. */
  #versionChecked: Promise<void> | undefined;

  constructor(options: VaultProviderOptions) {
    this.#base = joinPath(options.path);
    this.#mount = options.mount ?? process.env.VAULT_MOUNT ?? "secret";
    this.#transport = options.transport ?? defaultVaultTransport({ mount: this.#mount });
  }

  /**
   * Asserts the mount is KV v2 before the first read or write reaches it. A v1
   * mount cannot retain history, so it is refused here rather than discovered at
   * the moment a rotation reaches for a previous value. Memoized: the check is one
   * round-trip, paid once per provider.
   */
  #ensureV2(): Promise<void> {
    if (this.#versionChecked === undefined) {
      const check = this.#transport.mountVersion().then((version) => {
        if (version !== 2) {
          throw new VaultKvVersionError(this.#mount, version);
        }
      });
      // Only a *successful* assertion is memoized. A transient failure — a network
      // blip, a momentary auth expiry on the first operation — must not poison the
      // provider for the rest of its life; clearing the slot on rejection lets the
      // next operation retry once Vault is reachable again. A genuine v1 mount just
      // fails the same way again, for the price of one extra round-trip.
      this.#versionChecked = check.catch((error: unknown) => {
        this.#versionChecked = undefined;
        throw error;
      });
    }
    return this.#versionChecked;
  }

  #dataPathOf(file: ValueFile): string {
    return joinPath(this.#base, formatValueFile(file));
  }

  #metaPathOf(ref: ParameterRef): string {
    return joinPath(this.#base, formatMetaFile({ ...ref, format: "json" }));
  }

  async read(file: ValueFile): Promise<string | undefined> {
    await this.#ensureV2();
    const data = await this.#transport.readData(this.#dataPathOf(file));
    return data?.[DATA_KEY];
  }

  async write(file: ValueFile, value: string): Promise<void> {
    await this.#ensureV2();
    await this.#transport.writeData(this.#dataPathOf(file), { [DATA_KEY]: value });
  }

  async list(): Promise<ValueFile[]> {
    await this.#ensureV2();
    const out: ValueFile[] = [];
    await this.#walk([], out);
    return out;
  }

  async remove(file: ValueFile): Promise<void> {
    await this.#ensureV2();
    await this.#transport.deleteMetadata(this.#dataPathOf(file));
  }

  async readMeta(ref: ParameterRef): Promise<Meta | undefined> {
    await this.#ensureV2();
    const path = this.#metaPathOf(ref);
    const data = await this.#transport.readData(path);
    const json = data?.[DATA_KEY];
    if (json === undefined) return undefined;
    return parseMeta(json, path);
  }

  async writeMeta(ref: ParameterRef, meta: Meta): Promise<void> {
    await this.#ensureV2();
    await this.#transport.writeData(this.#metaPathOf(ref), { [DATA_KEY]: serializeMeta(meta) });
  }

  async removeMeta(ref: ParameterRef): Promise<void> {
    await this.#ensureV2();
    await this.#transport.deleteMetadata(this.#metaPathOf(ref));
  }

  /**
   * The value a parameter held before its current one, at one scope. Reads the
   * version below the current one; resolves to `undefined` when there is no prior
   * version, or when Vault has already pruned it (`max_versions` defaults to 10).
   * Absence is never an error — a rotation that cannot find its previous value is
   * a `doctor` failure, not a silent one.
   */
  async readPrevious(file: ValueFile): Promise<string | undefined> {
    await this.#ensureV2();
    const path = this.#dataPathOf(file);
    const current = await this.#transport.currentVersion(path);
    if (current === undefined || current <= 1) return undefined;
    const data = await this.#transport.readData(path, current - 1);
    return data?.[DATA_KEY];
  }

  /**
   * Enumerates the tree one LIST at a time, mirroring the filesystem's `#walk`
   * over the transport. Vault's LIST returns a single level, so a full tree is N
   * round-trips, not one scan. Meta records and any key the adapter never wrote
   * are skipped, so a written meta is never returned as a value.
   */
  async #walk(namespace: readonly string[], out: ValueFile[]): Promise<void> {
    const keys = await this.#transport.listKeys(joinPath(this.#base, ...namespace));
    for (const key of keys) {
      if (key.endsWith("/")) {
        await this.#walk([...namespace, key.slice(0, -1)], out);
        continue;
      }
      const parsed = parseLeaf(key);
      if (parsed?.kind === "value") {
        out.push({
          namespace: [...namespace],
          name: parsed.name,
          scope: parsed.scope,
          encrypted: parsed.encrypted,
        });
      }
    }
  }
}

export function createVaultProvider(options: VaultProviderOptions): VaultProvider {
  return new VaultProvider(options);
}
