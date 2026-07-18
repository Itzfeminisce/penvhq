/**
 * The Kubernetes Secrets provider — the third proof of portability, and the one
 * that shows the contract working by *declaring a capability absent* rather than
 * bending to accommodate its absence.
 *
 * It satisfies the same `@penvhq/core` contract the filesystem, Vault, and SSM do,
 * and it is deliberately a plain {@link Provider}, not a `RetainingProvider`:
 * Kubernetes Secrets keep no version history, so a Kubernetes environment cannot
 * `dual-valid` rotate and says so at config time — `retainsPrevious` narrows it to
 * `false`. That is the contract holding, not failing.
 *
 * penv's arbitrary-depth namespace flattens onto Kubernetes' three fixed levels
 * (cluster namespace, Secret name, data key). This adapter puts the whole penv
 * tree in one Secret (namespace + name from config) and encodes each record's
 * relative path into one data key. A data key admits only `[A-Za-z0-9._-]`, while
 * penv puts no character whitelist on a name or namespace segment — so the encoding
 * cannot assume the alphabet is a superset, and escapes *every* byte outside the
 * safe set (the `/` separators and anything else) as `_` plus its two-hex UTF-8
 * byte. `_` is itself escaped, so the mapping is collision-free and reversible for
 * any penv path — settling the flattening collision hazard the roadmap leaves to
 * this milestone. See {@link encodeKey}.
 *
 * Kubernetes is reached only through an injected {@link KubernetesTransport}; the
 * default shells out to `kubectl` (see `./transport.ts`), so penv holds no
 * kubeconfig of its own. Tests inject an in-memory fake, which the contract suite
 * runs against.
 */

import type { Meta, ParameterRef, Provider, Scope, ValueFile } from "@penvhq/core";
import {
  formatMetaFile,
  formatValueFile,
  META_FORMATS,
  parseMeta,
  serializeMeta,
} from "@penvhq/core";
import { defaultKubernetesTransport } from "./transport.js";

/**
 * The Secret data-plane operations the adapter needs. Every value is a plaintext
 * string; the base64 a Secret stores on the wire is the transport's concern, never
 * the provider's.
 */
export interface KubernetesTransport {
  /** Reads one data key. Resolves to `undefined` when the key, or the Secret, is absent. */
  readKey(key: string): Promise<string | undefined>;
  /** Writes one data key, creating the Secret if it does not exist. */
  writeKey(key: string, value: string): Promise<void>;
  /** Deletes one data key. Absent is not an error, mirroring `remove`. */
  deleteKey(key: string): Promise<void>;
  /** Every data key the Secret holds. `[]` when the Secret is absent. */
  listKeys(): Promise<string[]>;
}

export interface KubernetesProviderOptions {
  /** The cluster namespace the Secret lives in. When omitted, the current `kubectl` context's namespace. */
  readonly namespace?: string;
  /** The Secret that holds the whole penv tree. Defaults to `penv`. */
  readonly secretName?: string;
  /** The transport. Defaults to shelling out to `kubectl`; injected in tests. */
  readonly transport?: KubernetesTransport;
}

const ENC = "enc";
const LOCAL = "local";

function isMetaFormat(segment: string): boolean {
  return (META_FORMATS as readonly string[]).includes(segment);
}

/** The bytes a Secret data key may hold verbatim: the intersection of the key
 * alphabet `[A-Za-z0-9._-]` and what needs no escaping. `_` is excluded because it
 * is the escape marker. */
const KEY_SAFE = /^[A-Za-z0-9.-]$/;

/**
 * Encodes a relative path into one Secret data key. A data key admits only
 * `[A-Za-z0-9._-]`; penv, by contrast, puts no character whitelist on a name or a
 * namespace segment (only environment names are constrained), so a name may hold a
 * space, a `+`, or non-ASCII. Every byte outside the safe set — the `/` separators,
 * and any such character — is escaped as `_` followed by its two-hex-digit UTF-8
 * byte. `_` itself is escaped (`_5f`), so no `_` in an encoded key is ever a literal.
 * The result is always a legal key and always reversible, for any penv path.
 */
export function encodeKey(path: string): string {
  let out = "";
  for (const byte of Buffer.from(path, "utf8")) {
    const char = String.fromCharCode(byte);
    out += byte < 0x80 && KEY_SAFE.test(char) ? char : `_${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * Reverses {@link encodeKey}: a `_` introduces a two-hex-digit byte, every other
 * character is its own byte, and the bytes are reassembled as UTF-8. A key not
 * written by penv may decode to something the leaf grammar then rejects, which
 * `list` skips — never mangled into a false record.
 */
export function decodeKey(key: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i += 1) {
    if (key[i] === "_") {
      bytes.push(Number.parseInt(key.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(key.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
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
 * Reverses the leaf grammar {@link formatValueFile}/{@link formatMetaFile} produce,
 * on the decoded relative path's final segment. As in the Vault and SSM adapters,
 * the store holds only leaves penv wrote, so the mapping is deterministic.
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

export class KubernetesProvider implements Provider {
  readonly type = "kubernetes";

  readonly #transport: KubernetesTransport;

  constructor(options: KubernetesProviderOptions = {}) {
    this.#transport =
      options.transport ??
      defaultKubernetesTransport({
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        secretName: options.secretName ?? "penv",
      });
  }

  #keyOf(file: ValueFile): string {
    return encodeKey(formatValueFile(file));
  }

  #metaKeyOf(ref: ParameterRef): string {
    return encodeKey(formatMetaFile({ ...ref, format: "json" }));
  }

  async read(file: ValueFile): Promise<string | undefined> {
    return this.#transport.readKey(this.#keyOf(file));
  }

  async write(file: ValueFile, value: string): Promise<void> {
    await this.#transport.writeKey(this.#keyOf(file), value);
  }

  async remove(file: ValueFile): Promise<void> {
    await this.#transport.deleteKey(this.#keyOf(file));
  }

  async list(): Promise<ValueFile[]> {
    const keys = await this.#transport.listKeys();
    const out: ValueFile[] = [];
    for (const key of keys) {
      const relative = decodeKey(key);
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
    const key = this.#metaKeyOf(ref);
    const json = await this.#transport.readKey(key);
    if (json === undefined) return undefined;
    return parseMeta(json, decodeKey(key));
  }

  async writeMeta(ref: ParameterRef, meta: Meta): Promise<void> {
    await this.#transport.writeKey(this.#metaKeyOf(ref), serializeMeta(meta));
  }

  async removeMeta(ref: ParameterRef): Promise<void> {
    await this.#transport.deleteKey(this.#metaKeyOf(ref));
  }

  // No `readPrevious`: Kubernetes Secrets keep no history, so this provider
  // declares retention absent by omitting the method. `retainsPrevious` narrows it
  // to `false`, and a `dual-valid` rotation refuses it up front rather than
  // discovering the gap mid-rotation.
}

export function createKubernetesProvider(
  options: KubernetesProviderOptions = {},
): KubernetesProvider {
  return new KubernetesProvider(options);
}
