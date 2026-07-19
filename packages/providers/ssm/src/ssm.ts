/**
 * The AWS SSM Parameter Store provider — the second proof that a provider is
 * portable, built against the v0.5 contract with no contract change permitted.
 *
 * It satisfies the same `@penvhq/core` contract the filesystem and Vault do. Like
 * Vault it is a {@link RetainingProvider}: SSM keeps a bounded history (the last
 * 100 versions), so it can hand back the value a parameter held before its
 * current one. Three things SSM forces the adapter to absorb, none of which the
 * contract bends for:
 *
 *   1. **Reads must decrypt.** A value is stored as a `SecureString`; a
 *      `GetParameter` without `WithDecryption` returns the *ciphertext as the
 *      value* — a silent wrong value in penv's own adapter. Every read here
 *      decrypts, and the default transport is the one place that flag lives.
 *   2. **Values cannot be empty.** `PutParameter` rejects an empty `Value`, and a
 *      penv value is opaque bytes that may be empty (`""`). The adapter stores
 *      every value behind a one-byte sentinel so the stored value is never empty,
 *      and strips it on read — byte-identical to what penv wrote, never to what
 *      SSM holds.
 *   3. **Meta needs its own address.** `PutParameter` requires a `Value` and
 *      cannot carry a bare `Description`, so meta is a sibling parameter at its
 *      own name, exactly as Vault stores it — excluded from every value listing.
 *
 * SSM is reached only through an injected {@link SsmTransport}; the default shells
 * out to the `aws` CLI (see `./transport.ts`), so penv holds no AWS credential of
 * its own. Tests inject a faithful in-memory fake, which is what the contract
 * suite runs against.
 */

import type { Meta, ParameterRef, RetainingProvider, Scope, ValueFile } from "@penvhq/core";
import {
  formatMetaFile,
  formatValueFile,
  META_FORMATS,
  parseMeta,
  serializeMeta,
} from "@penvhq/core";
import { defaultSsmTransport } from "./transport.js";

/**
 * The SSM data-plane operations the adapter needs, and nothing wider. Every read
 * operation returns the *decrypted* value — the `WithDecryption` discipline is the
 * transport's to keep, not a per-call flag the provider can forget.
 */
export interface SsmTransport {
  /**
   * Reads a parameter's current value, decrypted. Resolves to `undefined` when the
   * name holds nothing.
   */
  getParameter(name: string): Promise<SsmValue | undefined>;
  /**
   * Writes a parameter, overwriting in place (a new version). `secure` selects
   * `SecureString` (values) over `String` (meta). SSM rejects an empty `Value`;
   * the caller has already ensured it is non-empty.
   */
  putParameter(name: string, value: string, secure: boolean): Promise<void>;
  /** Deletes a parameter and its whole history. Absent is not an error, mirroring `remove`. */
  deleteParameter(name: string): Promise<void>;
  /**
   * The names of every parameter at or below a `/`-prefixed path, recursively —
   * `GetParametersByPath`. An absent path lists as `[]`, never an error.
   */
  listNames(path: string): Promise<string[]>;
  /**
   * The parameter's version history, decrypted, ordered oldest-to-newest —
   * `GetParameterHistory`. `[]` when the name holds nothing. SSM caps this at the
   * most recent 100 versions.
   */
  getHistory(name: string): Promise<SsmValue[]>;
}

/** One version of a parameter: its decrypted value and SSM's monotonic version number. */
export interface SsmValue {
  readonly value: string;
  readonly version: number;
}

export interface SsmProviderOptions {
  /**
   * The `/`-prefixed base path penv maps records under; the plugin factory
   * fills it from `providers.*.location`. Defaults to `/penv`. Every parameter
   * name is `<path>/<value-filename>`.
   */
  readonly path?: string;
  /** The transport. Defaults to shelling out to the `aws` CLI; injected in tests. */
  readonly transport?: SsmTransport;
}

/**
 * A one-byte sentinel every value is stored behind, so an empty penv value is a
 * non-empty SSM value (which `PutParameter` requires). Stripped on read, so it is
 * never seen by penv. It is positional, not parsed — exactly one byte is added
 * and one removed — so a value that itself begins with this byte round-trips
 * exactly.
 */
const VALUE_SENTINEL = "\u0001";

const ENC = "enc";
const LOCAL = "local";

function isMetaFormat(segment: string): boolean {
  return (META_FORMATS as readonly string[]).includes(segment);
}

/** Joins path parts into a single `/`-prefixed SSM name, dropping empty segments. */
function joinName(...parts: readonly string[]): string {
  const segments = parts.flatMap((part) => part.split("/")).filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`;
}

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
 * The store holds only leaves penv itself wrote, so — as in the Vault adapter —
 * every segment after the name is a real environment name (`enc`, `local`, and the
 * meta formats are all reserved and can never be one) or a terminal marker.
 */
function parseLeaf(leaf: string): ParsedLeaf | undefined {
  const segments = leaf.split(".");
  const name = segments[0];
  if (name === undefined || name.length === 0) return undefined;

  let rest = segments.slice(1);

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
    return undefined;
  }

  return { kind: "value", name, scope, encrypted };
}

export class SsmProvider implements RetainingProvider {
  readonly type = "@penvhq/provider-ssm";

  readonly #base: string;
  readonly #transport: SsmTransport;

  constructor(options: SsmProviderOptions = {}) {
    this.#base = joinName(options.path ?? "penv");
    this.#transport = options.transport ?? defaultSsmTransport({});
  }

  /** The `/`-prefixed base path every parameter is stored under. */
  get base(): string {
    return this.#base;
  }

  #nameOf(file: ValueFile): string {
    return joinName(this.#base, formatValueFile(file));
  }

  #metaNameOf(ref: ParameterRef): string {
    return joinName(this.#base, formatMetaFile({ ...ref, format: "json" }));
  }

  async read(file: ValueFile): Promise<string | undefined> {
    const got = await this.#transport.getParameter(this.#nameOf(file));
    return got === undefined ? undefined : unwrap(got.value);
  }

  async write(file: ValueFile, value: string): Promise<void> {
    await this.#transport.putParameter(this.#nameOf(file), wrap(value), true);
  }

  async remove(file: ValueFile): Promise<void> {
    await this.#transport.deleteParameter(this.#nameOf(file));
  }

  async list(): Promise<ValueFile[]> {
    const names = await this.#transport.listNames(this.#base);
    const out: ValueFile[] = [];
    const prefix = `${this.#base}/`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      const slash = relative.lastIndexOf("/");
      const namespace = slash === -1 ? [] : relative.slice(0, slash).split("/");
      const leaf = slash === -1 ? relative : relative.slice(slash + 1);
      const parsed = parseLeaf(leaf);
      if (parsed?.kind === "value") {
        out.push({
          namespace,
          name: parsed.name,
          scope: parsed.scope,
          encrypted: parsed.encrypted,
        });
      }
    }
    return out;
  }

  async readMeta(ref: ParameterRef): Promise<Meta | undefined> {
    const name = this.#metaNameOf(ref);
    const got = await this.#transport.getParameter(name);
    if (got === undefined) return undefined;
    return parseMeta(unwrap(got.value), name);
  }

  async writeMeta(ref: ParameterRef, meta: Meta): Promise<void> {
    // Meta is policy, not a secret, so it is a plaintext `String`, not a
    // `SecureString`. It is still wrapped, so an (impossible) empty serialization
    // could never trip SSM's non-empty rule.
    await this.#transport.putParameter(this.#metaNameOf(ref), wrap(serializeMeta(meta)), false);
  }

  async removeMeta(ref: ParameterRef): Promise<void> {
    await this.#transport.deleteParameter(this.#metaNameOf(ref));
  }

  /**
   * The value a parameter held before its current one. Reads the history and
   * returns the second-newest version; resolves to `undefined` when there is only
   * one version, none at all, or the previous version has aged out of SSM's
   * 100-version window. Absence is never an error — a rotation that cannot find
   * its previous value is a `doctor` failure, not a silent one.
   */
  async readPrevious(file: ValueFile): Promise<string | undefined> {
    const history = await this.#transport.getHistory(this.#nameOf(file));
    if (history.length < 2) return undefined;
    // Oldest-to-newest, so the previous version is the penultimate entry.
    const previous = history[history.length - 2];
    return previous === undefined ? undefined : unwrap(previous.value);
  }
}

/** Wraps a value behind the sentinel so the stored SSM value is never empty. */
function wrap(value: string): string {
  return VALUE_SENTINEL + value;
}

/**
 * Strips the sentinel a value was stored behind. A stored value that is not so
 * wrapped — one written outside penv, into penv's own tree — is returned verbatim
 * rather than mangled, so a foreign parameter is at worst wrong, never truncated.
 */
function unwrap(stored: string): string {
  return stored.startsWith(VALUE_SENTINEL) ? stored.slice(VALUE_SENTINEL.length) : stored;
}

export function createSsmProvider(options: SsmProviderOptions = {}): SsmProvider {
  return new SsmProvider(options);
}
