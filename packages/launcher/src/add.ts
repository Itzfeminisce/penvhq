/**
 * `penv add <package>` — the one command that decides to trust something.
 *
 * It belongs to the launcher rather than the engine because everything it does
 * is the launcher's: resolve an exact version, verify the bytes, install them
 * into `$PENV_HOME`, and write the manifest that pins them. No engine is needed
 * for any of that, and the engine importing the store would close a cycle.
 *
 * The trust model exists for strangers, and only strangers pay it. An
 * `@penvhq/*` package is resolved, verified and recorded without one question;
 * a public third-party package waits out a minimum age and commits a block
 * saying who published it and why a person trusted it; a package from a private
 * registry commits the registry and the acknowledgement. Credentials are never
 * part of any of it — `.npmrc` owns those.
 *
 * Nothing here puts adapter code on any startup path. What lands in the project
 * is two committed files with no runtime in them: the manifest entry, and a
 * type-only declaration.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Manifest, ManifestExtension, ManifestTrust } from "@penvhq/core";
import {
  findConfigFile,
  MANIFEST_PATH,
  OFFICIAL_SCOPE,
  parseManifest,
  serializeManifest,
} from "@penvhq/core";
import { readProviderEntries, setProviderType } from "./config-edit.js";
import { readExtensionPackage, writeDeclaration } from "./declaration.js";
import {
  AddFlagError,
  AddPackageNameError,
  AddRegistryError,
  AddSubjectError,
  MIN_PACKAGE_AGE_DAYS,
  OfficialRegistryError,
  PackageTooYoungError,
  TRUST_YOUNG_FLAG,
  TrustDeclinedError,
  TrustPromptNeededError,
  TrustPublisherMissingError,
  TrustReasonMissingError,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import type { LauncherIo } from "./io.js";
import { fetchRelease, type Release } from "./registry.js";
import { DEFAULT_REGISTRY, installPin } from "./store.js";

/** npm's package-name grammar, scoped or bare — the manifest's, checked before the fetch. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

const REGISTRY_FLAG = "--registry";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which ceremony a package pays, decided by its scope and where it comes from. */
type Tier = "official" | "third-party" | "private";

export interface AddOptions {
  /** The tokens after `add`. */
  readonly argv: readonly string[];
  /** The project root — the directory holding `.penv/`. */
  readonly root: string;
  readonly manifestFile: string;
  readonly home: string;
  readonly io: LauncherIo;
  readonly fetcher: Fetcher;
  /** Injected so the age gate is testable without waiting seven days. */
  readonly now?: () => Date;
}

export interface AddResult {
  /** The engine command the provider declares, when its offer was accepted. */
  readonly onboard: readonly string[] | undefined;
}

interface Request {
  readonly name: string;
  readonly version: string | undefined;
  /** Absent means npmjs, which the manifest never names. */
  readonly registry: string | undefined;
  readonly trustYoung: boolean;
}

/** npmjs under any spelling is not a registry the manifest records. */
function normalizeRegistry(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AddRegistryError(raw);
  }
  if (url.protocol !== "https:") {
    throw new AddRegistryError(raw);
  }
  return url.origin === new URL(DEFAULT_REGISTRY).origin ? undefined : raw.replace(/\/+$/, "");
}

/** `@scope/name@version` splits at the last `@`, which is never the scope's. */
function splitSpec(spec: string): { name: string; version: string | undefined } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    return { name: spec, version: undefined };
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function parseRequest(argv: readonly string[]): Request {
  let spec: string | undefined;
  let registry: string | undefined;
  let trustYoung = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === TRUST_YOUNG_FLAG) {
      trustYoung = true;
      continue;
    }
    if (token === REGISTRY_FLAG) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new AddFlagError(REGISTRY_FLAG);
      }
      registry = normalizeRegistry(value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new AddFlagError(token);
    }
    if (spec !== undefined) {
      throw new AddSubjectError();
    }
    spec = token;
  }

  if (spec === undefined || spec === "") {
    throw new AddSubjectError();
  }
  const { name, version } = splitSpec(spec);
  if (!PACKAGE_NAME.test(name) || version === "") {
    throw new AddPackageNameError(spec);
  }
  return { name, version, registry, trustYoung };
}

function tierOf(request: Request): Tier {
  if (request.name.startsWith(OFFICIAL_SCOPE)) {
    if (request.registry !== undefined) {
      throw new OfficialRegistryError(request.name, request.registry);
    }
    return "official";
  }
  return request.registry === undefined ? "third-party" : "private";
}

/** The block the reader of the commit sees before they are asked to decide. */
function showRelease(io: LauncherIo, release: Release, registry: string | undefined): void {
  io.out(`  publisher   ${release.publisher ?? "not stated by the registry"}`);
  io.out(`  published   ${release.publishedAt}`);
  io.out(`  integrity   ${release.integrity}`);
  if (registry !== undefined) {
    io.out(`  registry    ${registry}`);
  }
}

async function askReason(io: LauncherIo, release: Release): Promise<string> {
  const reason = (await io.ask("Why do you trust it? One line, for the next reviewer.")).trim();
  if (reason === "") {
    throw new TrustReasonMissingError(release.name, release.version);
  }
  return reason;
}

/**
 * The trust ceremony, or nothing at all.
 *
 * Seal 6: the official scope reaches the `return undefined` above every prompt,
 * so an `@penvhq/*` add cannot grow a question by accident — there is no code
 * path from here to `confirm` for it.
 */
async function trustFor(
  tier: Tier,
  release: Release,
  request: Request,
  io: LauncherIo,
  now: Date,
): Promise<ManifestTrust | undefined> {
  if (tier === "official") {
    return undefined;
  }
  if (!io.interactive) {
    throw new TrustPromptNeededError(release.name, release.version);
  }

  if (tier === "third-party") {
    const age = now.getTime() - Date.parse(release.publishedAt);
    if (age < MIN_PACKAGE_AGE_DAYS * DAY_MS && !request.trustYoung) {
      throw new PackageTooYoungError(release.name, release.version, release.publishedAt);
    }
    io.out(
      `${release.name} ${release.version} is outside \`${OFFICIAL_SCOPE}*\`, so the manifest ` +
        "records who you trusted and why.",
    );
    showRelease(io, release, undefined);
    if (!(await io.confirm(`Trust ${release.name} ${release.version}?`))) {
      throw new TrustDeclinedError(release.name, release.version);
    }
    const publisher =
      release.publisher ?? (await io.ask("Who publishes it? The npm account name.")).trim();
    if (publisher === "") {
      throw new TrustPublisherMissingError(release.name, release.version);
    }
    return {
      tier: "third-party",
      publisher,
      publishedAt: release.publishedAt,
      acknowledgedAt: now.toISOString(),
      reason: await askReason(io, release),
    };
  }

  io.out(
    `${release.name} ${release.version} comes from a private registry. The manifest records the ` +
      "registry and your acknowledgement; your `.npmrc` keeps the credentials.",
  );
  showRelease(io, release, request.registry);
  if (!(await io.confirm(`Trust ${release.name} ${release.version}?`))) {
    throw new TrustDeclinedError(release.name, release.version);
  }
  return {
    tier: "private",
    acknowledgedAt: now.toISOString(),
    reason: await askReason(io, release),
  };
}

/** The manifest with this one extension recorded, serialized — and so validated. */
function recordExtension(manifestFile: string, name: string, entry: ManifestExtension): string {
  const manifest = parseManifest(readFileSync(manifestFile, "utf8"));
  const next: Manifest = {
    ...manifest,
    extensions: { ...manifest.extensions, [name]: entry },
  };
  return serializeManifest(next);
}

/**
 * The `penv.config.ts` edit, offered once per environment and applied on a yes.
 *
 * Every provider entry is its own decision — a team rarely points development
 * and production at the same store on the same day — so this asks per
 * environment rather than assuming one answer covers the file.
 */
async function offerConfigEdit(options: AddOptions, name: string): Promise<void> {
  const { io, root } = options;
  const configFile = findConfigFile(root);
  const line = `Add \`type: ${JSON.stringify(name)}\` to an environment in penv.config.ts.`;
  if (configFile === undefined) {
    io.out(line);
    return;
  }

  const shown = relative(root, configFile).split(sep).join("/");
  let current = readFileSync(configFile, "utf8");
  const entries = readProviderEntries(current);
  if (entries === undefined || entries.length === 0) {
    io.out(line);
    return;
  }
  if (entries.every((entry) => entry.type === name)) {
    return;
  }
  if (!io.interactive) {
    io.out(line);
    return;
  }

  for (const entry of entries) {
    if (entry.type === name) {
      continue;
    }
    if (!(await io.confirm(`Point \`${entry.environment}\` at ${name} in ${shown}?`))) {
      continue;
    }
    const next = setProviderType(current, entry.environment, name);
    if (next === undefined) {
      io.out(`Add \`type: ${JSON.stringify(name)}\` to \`${entry.environment}\` in ${shown}.`);
      continue;
    }
    current = next;
    writeFileSync(configFile, current);
    io.out(`✓ ${shown} points \`${entry.environment}\` at ${name}`);
  }
}

/** Seal 7: the provider's own next step, offered — never run because `add` ran. */
async function offerOnboarding(
  io: LauncherIo,
  name: string,
  onboard: string | undefined,
): Promise<readonly string[] | undefined> {
  if (onboard === undefined) {
    return undefined;
  }
  const args = onboard.split(/\s+/).filter((token) => token !== "");
  if (args.length === 0) {
    return undefined;
  }
  const command = `penv ${args.join(" ")}`;
  if (io.interactive && (await io.confirm(`Run \`${command}\` now?`))) {
    return args;
  }
  io.out(`Run \`${command}\` to finish setting ${name} up.`);
  return undefined;
}

export async function add(options: AddOptions): Promise<AddResult> {
  const { io, fetcher, home, root, manifestFile } = options;
  const request = parseRequest(options.argv);
  const tier = tierOf(request);
  const now = (options.now ?? (() => new Date()))();

  const release = await fetchRelease({
    name: request.name,
    ...(request.version === undefined ? {} : { version: request.version }),
    ...(request.registry === undefined ? {} : { registry: request.registry }),
    fetcher,
  });
  const trust = await trustFor(tier, release, request, io, now);

  const entry: ManifestExtension = {
    version: release.version,
    integrity: release.integrity,
    ...(request.registry === undefined ? {} : { registry: request.registry }),
    ...(trust === undefined ? {} : { trust }),
  };
  // Serialized before anything is downloaded: a manifest that would not validate
  // is a refusal, not a cache full of bytes nobody can pin.
  const manifestText = recordExtension(manifestFile, release.name, entry);

  const dir = await installPin({
    home,
    kind: "extensions",
    pin: {
      name: release.name,
      version: release.version,
      integrity: release.integrity,
      ...(request.registry === undefined ? {} : { registry: request.registry }),
    },
    fetcher,
  });

  const installed = readExtensionPackage(dir);
  const declaration = writeDeclaration({
    root,
    dir,
    name: release.name,
    version: release.version,
    attested: release.attested,
    types: installed.types,
  });
  writeFileSync(manifestFile, manifestText);

  const provenance = release.attested
    ? "npm records a provenance attestation"
    : "npm records no provenance attestation";
  io.out(`✓ ${release.name} ${release.version} installed — ${provenance}`);
  io.out(`✓ ${MANIFEST_PATH} pins it`);
  io.out(`✓ ${declaration} declares its config type`);

  await offerConfigEdit(options, release.name);
  return { onboard: await offerOnboarding(io, release.name, installed.onboard) };
}
