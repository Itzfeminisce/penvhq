/**
 * What the registry says about one release.
 *
 * Everything `add` decides from — the exact version behind `latest`, the
 * integrity of the bytes, when it was published, who published it, whether npm
 * holds a provenance attestation — is metadata, so it arrives through the same
 * fetcher the tarball does. One network seam, and a test suite that serves both
 * from memory.
 */

import {
  PackageUnknownError,
  RegistryUnreadableError,
  ReleaseIncompleteError,
  VersionUnknownError,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import { DEFAULT_REGISTRY } from "./store.js";

/** One published version, reduced to the facts a trust decision is made on. */
export interface Release {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  /** ISO 8601, as the registry's `time` map records it. */
  readonly publishedAt: string;
  /** The npm account credited with the publish, when the registry names one. */
  readonly publisher: string | undefined;
  /** Whether npm holds a provenance attestation for these exact bytes. */
  readonly attested: boolean;
}

export interface ReleaseQuery {
  readonly name: string;
  /** Absent means whatever `latest` points at today. */
  readonly version?: string;
  /** Only when the package comes from somewhere other than npmjs. */
  readonly registry?: string;
  /** The command that would repeat this resolution. Absent means `penv add <name>`. */
  readonly retry?: string;
  readonly fetcher: Fetcher;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Own properties only: a package named `constructor` must answer `undefined`. */
function at(source: Record<string, unknown> | undefined, key: string): unknown {
  return source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The packument's address, which an exact name can be built rather than searched. */
export function packumentUrl(registry: string | undefined, name: string): string {
  return `${(registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "")}/${name}`;
}

function publisherOf(release: Record<string, unknown>): string | undefined {
  const npmUser = text(at(record(release._npmUser), "name"));
  if (npmUser !== undefined) {
    return npmUser;
  }
  const maintainers = release.maintainers;
  if (!Array.isArray(maintainers)) {
    return undefined;
  }
  return text(at(record(maintainers[0]), "name"));
}

/** The one release `add` is about to decide on, or why the registry could not say. */
export async function fetchRelease(query: ReleaseQuery): Promise<Release> {
  const url = packumentUrl(query.registry, query.name);

  let bytes: Uint8Array;
  try {
    bytes = await query.fetcher.get(url);
  } catch (cause) {
    throw new RegistryUnreadableError(
      query.name,
      url,
      cause instanceof Error ? cause.message : String(cause),
      query.retry,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new RegistryUnreadableError(
      query.name,
      url,
      cause instanceof Error ? cause.message : String(cause),
      query.retry,
    );
  }

  const packument = record(parsed);
  const versions = record(at(packument, "versions"));
  if (versions === undefined) {
    throw new PackageUnknownError(query.name, url);
  }

  const tags = record(at(packument, "dist-tags"));
  const asked = query.version ?? text(at(tags, "latest"));
  if (asked === undefined) {
    throw new PackageUnknownError(query.name, url);
  }

  // A version that is not a version is read as a dist-tag, so `@next` resolves
  // the way npm resolves it — and the manifest still pins what it pointed at.
  const version =
    record(at(versions, asked)) === undefined ? (text(at(tags, asked)) ?? asked) : asked;
  const release = record(at(versions, version));
  if (release === undefined) {
    throw new VersionUnknownError(query.name, asked, url, query.retry);
  }

  const dist = record(at(release, "dist"));
  const integrity = text(at(dist, "integrity"));
  const publishedAt = text(at(record(at(packument, "time")), version));
  if (integrity === undefined) {
    throw new ReleaseIncompleteError(query.name, version, url, "integrity");
  }
  if (publishedAt === undefined || Number.isNaN(Date.parse(publishedAt))) {
    throw new ReleaseIncompleteError(query.name, version, url, "publish time");
  }

  return {
    name: query.name,
    version,
    integrity,
    publishedAt,
    publisher: publisherOf(release),
    attested: record(at(dist, "attestations")) !== undefined,
  };
}
