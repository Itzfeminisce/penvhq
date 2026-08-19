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
 * `add` refuses a run with nobody at it only when it has something to ask. The
 * questions are known from the package name before anything is fetched, and for
 * `@penvhq/*` there are none — so the gate used to refuse a run that would have
 * been silent. What cannot be answered unattended is the trust ceremony, whose
 * one field is a sentence about why a stranger's code is trusted; `--yes` says
 * nobody is here to be asked, so it cannot answer that either. `--no-download`
 * is refused whatever the package, because there is nothing to pin without it.
 *
 * `--local` is the one path with no release behind it: a repository that writes
 * a provider adds the package it already builds. Nothing is fetched and nothing
 * is pinned, so the manifest is not touched — see {@link addLocal}.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
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
  AddPackageNameError,
  AddRegistryError,
  AddSubjectError,
  AddTrustUnattendedError,
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
  YES_FLAG,
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
  /** Nobody is here to be asked: the offers print their advice instead. */
  readonly yes: boolean;
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
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === LOCAL_FLAG) {
      local = true;
      continue;
    }
    if (token === YES_FLAG) {
      yes = true;
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
  return { name, version, registry, trustYoung, local, yes };
}

/**
 * What this add would have to ask a person, known from the name alone.
 *
 * Discovered before the registry is read, because the refusal for a run with
 * nobody at it has to come before the first request — and because an add with
 * nothing to ask must not be refused for having nobody to ask it.
 */
function ceremonyFor(tier: Tier): string | undefined {
  return tier === "official" ? undefined : "who publishes it and why you trust it";
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

/** An answer that names no environment, and one that names every offered one. */
const NONE = new Set(["", "none", "no", "n"]);
const ALL = new Set(["all", "a", "yes", "y"]);

/** The environments an answer names: all of them, none, or the ones it lists. */
function chooseEnvironments(
  answer: string,
  offered: readonly string[],
): { readonly chosen: readonly string[]; readonly unknown: readonly string[] } {
  const normalized = answer.trim().toLowerCase();
  if (NONE.has(normalized)) {
    return { chosen: [], unknown: [] };
  }
  if (ALL.has(normalized)) {
    return { chosen: offered, unknown: [] };
  }
  const chosen: string[] = [];
  const unknown: string[] = [];
  for (const token of normalized.split(/[\s,]+/).filter((part) => part !== "")) {
    const match = offered.find((environment) => environment.toLowerCase() === token);
    if (match === undefined) {
      unknown.push(token);
    } else {
      chosen.push(match);
    }
  }
  return { chosen, unknown };
}

/**
 * The `penv.config.ts` edit, offered once for the whole file.
 *
 * It used to ask per environment, so a provider that belongs to exactly one of
 * them was three questions with no way to say which up front. One question names
 * every environment it would repoint; the answer picks all of them, some by
 * name, or none. A name it does not recognise repoints nothing — a typo in a
 * list of environments is not an instruction to half-apply.
 */
async function offerConfigEdit(options: AddOptions, name: string, ask: boolean): Promise<void> {
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
  const offered = entries.filter((entry) => entry.type !== name).map((entry) => entry.environment);
  if (offered.length === 0) {
    return;
  }
  if (!ask) {
    io.out(line);
    return;
  }

  const { chosen, unknown } = chooseEnvironments(
    await io.ask(`Point which of ${offered.join(", ")} at ${name} in ${shown}? all / none / names`),
    offered,
  );
  if (unknown.length > 0) {
    io.out(`${shown} declares no ${unknown.join(", ")}, so nothing was repointed.`);
    io.out(line);
    return;
  }
  for (const environment of chosen) {
    const next = setProviderType(current, environment, name);
    if (next === undefined) {
      io.out(`Add \`type: ${JSON.stringify(name)}\` to \`${environment}\` in ${shown}.`);
      continue;
    }
    current = next;
    writeFileSync(configFile, current);
    io.out(`✓ ${shown} points \`${environment}\` at ${name}`);
  }
}

/** Seal 7: the provider's own next step, offered — never run because `add` ran. */
async function offerOnboarding(
  io: LauncherIo,
  name: string,
  onboard: string | undefined,
  ask: boolean,
): Promise<readonly string[] | undefined> {
  if (onboard === undefined) {
    return undefined;
  }
  const args = onboard.split(/\s+/).filter((token) => token !== "");
  if (args.length === 0) {
    return undefined;
  }
  const command = `penv ${args.join(" ")}`;
  if (ask && (await io.confirm(`Run \`${command}\` now?`))) {
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
 */
async function assertLoadable(
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

  const ask = io.interactive && !request.yes;
  await offerConfigEdit(options, request.name, ask);
  return { onboard: await offerOnboarding(io, request.name, installed.onboard, ask) };
}

export async function add(options: AddOptions): Promise<AddResult> {
  const { io, fetcher, home, root, manifestFile } = options;
  const request = parseRequest(options.argv);
  if (request.local) {
    return addLocal(options, request);
  }
  const tier = tierOf(request);
  const now = (options.now ?? (() => new Date()))();
  const ask = io.interactive && !request.yes;

  // Both refusals come before the first request, so a run that cannot finish an
  // add has not read the registry, written the manifest, or filled the store.
  if (options.noDownload === true) {
    throw new AddNoDownloadError(request.name);
  }
  const ceremony = ceremonyFor(tier);
  if (ceremony !== undefined && (options.ci === true || !ask)) {
    throw new AddTrustUnattendedError(request.name, ceremony);
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

  await offerConfigEdit(options, release.name, ask);
  return { onboard: await offerOnboarding(io, release.name, installed.onboard, ask) };
}
