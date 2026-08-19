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
 *
 * Because those two files are committed, `add` is a decision and needs a person:
 * `--no-download` and a run with nobody at it are both refused before the first
 * request, and CI gets `penv install`, which installs what the manifest already
 * pins rather than choosing what it should.
 *
 * `--local` is the one path with no release behind it: a repository that writes
 * a provider adds the package it already builds. Nothing is fetched and nothing
 * is pinned, so the manifest is not touched — see {@link addLocal}.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest, ManifestExtension, ManifestTrust, PackageEntry } from "@penvhq/core";
import {
  findConfigFile,
  isImportableEntry,
  LOCAL_EXTENSIONS_PATH,
  localExtensionsFile,
  MANIFEST_PATH,
  OFFICIAL_SCOPE,
  packageEntry,
  parseLocalExtensions,
  serializeLocalExtensions,
  serializeManifest,
} from "@penvhq/core";
import { readProviderEntries, setProviderType } from "./config-edit.js";
import { readExtensionPackage, writeDeclaration } from "./declaration.js";
import {
  AddFlagError,
  AddLocalFlagError,
  AddLocalInCiError,
  AddNoDownloadError,
  AddNotInteractiveError,
  AddPackageNameError,
  AddRegistryError,
  AddSubjectError,
  ExtensionNotImportableError,
  ExtensionUnloadableError,
  LOCAL_FLAG,
  LocalExtensionUnresolvedError,
  ManifestEntriesUnreadableError,
  MIN_PACKAGE_AGE_DAYS,
  OfficialRegistryError,
  PackageTooYoungError,
  TRUST_YOUNG_FLAG,
  TrustDeclinedError,
  TrustPublisherMissingError,
  TrustReasonMissingError,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import type { LauncherIo } from "./io.js";
import { fetchRelease, type Release } from "./registry.js";
import { readManifestForRepair } from "./repair.js";
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
  /** The launcher's `--no-download`: this run reaches no registry at all. */
  readonly noDownload?: boolean;
  /** True on a CI runner, which may have a terminal and still have nobody at it. */
  readonly ci?: boolean;
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
  /** The package is this project's own — resolved from it, pinned nowhere. */
  readonly local: boolean;
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
  let local = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === LOCAL_FLAG) {
      local = true;
      continue;
    }
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
  // A local extension is whatever this checkout builds, so every flag that
  // describes a published release contradicts it. Refused rather than ignored:
  // silently dropping `--registry` would answer a different question than asked.
  if (local) {
    if (version !== undefined) {
      throw new AddLocalFlagError("a version");
    }
    if (registry !== undefined) {
      throw new AddLocalFlagError(`\`${REGISTRY_FLAG}\``);
    }
    if (trustYoung) {
      throw new AddLocalFlagError(`\`${TRUST_YOUNG_FLAG}\``);
    }
  }
  return { name, version, registry, trustYoung, local };
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

/**
 * The manifest with this one extension recorded, serialized — and so validated.
 *
 * The entry being replaced is allowed to be one penv cannot read: a broken entry
 * refuses with `penv add <pkg>`, and a remedy has to survive the parse it names.
 * Every other entry is validated as usual, and what gets written is validated in
 * full by {@link serializeManifest}, so `add` cannot leave behind an entry the
 * next command chokes on.
 */
function recordExtension(manifestFile: string, name: string, entry: ManifestExtension): string {
  const { manifest, broken } = readManifestForRepair(readFileSync(manifestFile, "utf8"));
  const others = broken.filter((other) => other !== name);
  if (others.length > 0) {
    throw new ManifestEntriesUnreadableError(others);
  }
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

/**
 * The directory of a package the project can already reach, or `undefined`.
 *
 * Resolution is anchored at the project, exactly where the engine anchors it
 * when it loads a provider — so what `--local` records is the same package the
 * next command will import, not a second answer to the same question.
 */
function resolvePackageDir(name: string, root: string): string | undefined {
  const require = createRequire(resolve(root, "noop.js"));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // A package whose `exports` hides its own package.json still resolves by
    // entry point; walk up from there to the directory that declares the name.
    let dir: string;
    try {
      dir = dirname(require.resolve(name));
    } catch {
      return undefined;
    }
    for (let current = dir, parent = dirname(dir); current !== parent; parent = dirname(current)) {
      if (readExtensionPackage(current).name === name) {
        return current;
      }
      current = parent;
    }
    return undefined;
  }
}

/**
 * The module the *project* would import for `name` — the engine's own answer for
 * a package it reads out of `node_modules`, so what `add` checks is the file the
 * next command will be handed.
 */
function resolveProjectEntry(name: string, root: string): PackageEntry | undefined {
  let file: string;
  try {
    file = createRequire(resolve(root, "noop.js")).resolve(name);
  } catch {
    return undefined;
  }
  return { file, importable: isImportableEntry(file) };
}

/**
 * The load check: penv imports the provider once, here.
 *
 * `add` used to certify that a package *resolved* and stop there, so one whose
 * `exports` pointed at TypeScript source collected three green checks and then
 * failed from an unrelated command days later. Resolution is not loadability,
 * and this is the one moment the operator is looking at the provider.
 *
 * `penv install` runs the same check on every extension it puts in the store, so
 * the answer is the same one on the machine that pinned the provider and on the
 * clean checkout that only installs it.
 */
export async function assertLoadable(
  name: string,
  entry: PackageEntry | undefined,
  local: boolean,
): Promise<void> {
  if (entry === undefined || !entry.importable) {
    throw new ExtensionNotImportableError(name, entry?.file, local);
  }
  try {
    await import(pathToFileURL(entry.file).href);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ExtensionUnloadableError(name, entry.file, detail, local);
  }
}

/** Adds `name` to the committed list, leaving the manifest untouched. */
function recordLocalExtension(root: string, name: string): void {
  const file = localExtensionsFile(root);
  let current: string;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = "[]";
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeLocalExtensions([...parseLocalExtensions(current), name]));
}

/**
 * `penv add --local <package>` — the path a repository that *writes* a provider
 * takes.
 *
 * Nothing is fetched, nothing is pinned, and the manifest is not opened: there
 * is no release to record, and inventing a version and an integrity for a
 * working copy would put a promise in a committed file that the file cannot
 * keep. What it writes is the declaration — so `penv.config.ts` is typed for the
 * provider it names — and the package's name in a list beside the manifest, so a
 * reviewer and `penv doctor` can both see that this project reads an adapter out
 * of itself.
 */
async function addLocal(options: AddOptions, request: Request): Promise<AddResult> {
  const { io, root } = options;
  if (options.ci === true) {
    throw new AddLocalInCiError(request.name);
  }

  const dir = resolvePackageDir(request.name, root);
  if (dir === undefined) {
    throw new LocalExtensionUnresolvedError(request.name, root);
  }
  // Before anything is written: a package penv cannot import is not one it records.
  await assertLoadable(request.name, resolveProjectEntry(request.name, root), true);

  const installed = readExtensionPackage(dir);
  const declaration = writeDeclaration({
    root,
    dir,
    name: request.name,
    version: installed.version ?? "unpublished",
    attested: false,
    local: true,
    types: installed.types,
  });
  recordLocalExtension(root, request.name);

  io.out(`✓ ${request.name} resolves from this project and imports — nothing is pinned`);
  io.out(`✓ ${LOCAL_EXTENSIONS_PATH} records it`);
  io.out(`✓ ${declaration} declares its config type`);

  await offerConfigEdit(options, request.name);
  return { onboard: await offerOnboarding(io, request.name, installed.onboard) };
}

export async function add(options: AddOptions): Promise<AddResult> {
  const { io, fetcher, home, root, manifestFile } = options;
  const request = parseRequest(options.argv);
  if (request.local) {
    return addLocal(options, request);
  }
  const tier = tierOf(request);
  const now = (options.now ?? (() => new Date()))();

  // Both refusals come before the first request, so a run that cannot finish an
  // add has not read the registry, written the manifest, or filled the store.
  if (options.noDownload === true) {
    throw new AddNoDownloadError(request.name);
  }
  if (options.ci === true || !io.interactive) {
    throw new AddNotInteractiveError(request.name);
  }

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

  // The store copy is what the engine imports for a pinned extension, so it is
  // the copy the load check loads — before the manifest that pins it is written.
  await assertLoadable(release.name, packageEntry(dir), false);

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
