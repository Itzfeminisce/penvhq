/**
 * What the launcher refuses, and the one command that clears each refusal.
 *
 * Every one of these is a wrong-bytes or no-bytes answer to the same question —
 * which penv is this project's — so they all name the package, the version, and
 * a single next command. Only the two engine-pin refusals mention the
 * launcher/engine split, because a launcher that cannot record which engine it
 * ran is the one failure that cannot be described without it; the rest name a
 * package and a command, and leave penv looking like one program.
 */

import {
  ENGINE_PACKAGE,
  EXTENSIONS_PATH,
  LOCAL_EXTENSIONS_PATH,
  MANIFEST_PATH,
  OFFICIAL_SCOPE,
  PenvError,
  RESERVED_ENTRY_FIELDS,
} from "@penvhq/core";

/** The command that materializes everything the manifest pins. */
export const INSTALL_COMMAND = "penv install";

/** The command that moves the engine pin, with no version: whatever `latest` points at. */
export const UPGRADE_COMMAND = "penv upgrade";

/** The flag that answers `upgrade`'s one question ahead of time. */
export const YES_FLAG = "--yes";

/** How long a package outside the official scope must have existed. */
export const MIN_PACKAGE_AGE_DAYS = 7;

/** The flag that overrides {@link MIN_PACKAGE_AGE_DAYS}, and only that. */
export const TRUST_YOUNG_FLAG = "--trust-young";

/** The `penv add` that would repeat this exact decision. */
function addCommand(name: string, version?: string, extra?: string): string {
  const spec = version === undefined ? name : `${name}@${version}`;
  return `penv add ${spec}${extra === undefined ? "" : ` ${extra}`}`;
}

/** The same command for either kind of add, each in the spelling the docs use. */
function addCommandFor(name: string, local: boolean): string {
  return local ? `penv add ${LOCAL_FLAG} ${name}` : addCommand(name);
}

/** The command was typed outside any penv project. */
export class NoProjectError extends PenvError {
  override readonly name = "NoProjectError";

  constructor(cwd: string) {
    super(
      "PENV_NO_PROJECT",
      `penv found no ${MANIFEST_PATH} in ${cwd} or any parent directory`,
      "Run `penv init` here to adopt this project.",
    );
  }
}

/** The pinned bytes are not on this machine, and this run does not download. */
export class PackageMissingError extends PenvError {
  override readonly name = "PackageMissingError";

  constructor(name: string, version: string, home: string) {
    super(
      "PENV_PACKAGE_MISSING",
      `${name} ${version} is not installed in ${home}, and this run does not download`,
      `Run \`${INSTALL_COMMAND}\` — CI and production install the versions the manifest pins ` +
        "before the command that needs them.",
    );
  }
}

/** The bytes on this machine are not the bytes the manifest pins. */
export class PackageCorruptError extends PenvError {
  override readonly name = "PackageCorruptError";

  constructor(name: string, version: string, dir: string) {
    super(
      "PENV_PACKAGE_CORRUPT",
      `${name} ${version} in ${dir} is not the bytes ${MANIFEST_PATH} pins`,
      `Delete ${dir} and run \`${INSTALL_COMMAND}\` — penv runs the exact bytes the manifest ` +
        "names, or nothing.",
    );
  }
}

/** The download was offered and declined. */
export class InstallDeclinedError extends PenvError {
  override readonly name = "InstallDeclinedError";

  constructor(name: string, version: string) {
    super(
      "PENV_INSTALL_DECLINED",
      `${name} ${version} was not downloaded`,
      `Run \`${INSTALL_COMMAND}\` when you want penv to fetch the versions this project pins.`,
    );
  }
}

/** The registry could not be reached, or answered with something other than the tarball. */
export class DownloadFailedError extends PenvError {
  override readonly name = "DownloadFailedError";

  constructor(name: string, version: string, url: string, detail: string) {
    super(
      "PENV_DOWNLOAD_FAILED",
      `Downloading ${name} ${version} from ${url} failed: ${detail}`,
      `Run \`${INSTALL_COMMAND}\` again when the registry is reachable.`,
    );
  }
}

/** The registry served bytes the manifest does not pin. Nothing is installed. */
export class DownloadIntegrityError extends PenvError {
  override readonly name = "DownloadIntegrityError";

  constructor(name: string, version: string, url: string) {
    super(
      "PENV_DOWNLOAD_INTEGRITY",
      `${name} ${version} from ${url} is not the bytes ${MANIFEST_PATH} pins`,
      `Check the registry — the bytes it served are not the ones the pin was reviewed against, ` +
        "so penv installed nothing.",
    );
  }
}

/** An archive entry penv will not write to disk. */
export class ArchiveError extends PenvError {
  override readonly name = "ArchiveError";

  constructor(name: string, version: string, entry: string) {
    super(
      "PENV_ARCHIVE",
      `The ${name} ${version} archive holds \`${entry}\`, which penv will not extract`,
      "Check the registry — penv extracts regular files under `package/` and nothing else.",
    );
  }
}

/** `penv add` with nothing to add. */
export class AddSubjectError extends PenvError {
  override readonly name = "AddSubjectError";

  constructor() {
    super(
      "PENV_ADD_SUBJECT",
      "`penv add` names no package",
      "Run `penv add @penvhq/provider-vault`, or any provider package name — optionally with " +
        "`@<version>` to pin one other than the latest.",
    );
  }
}

/** A package name npm would not recognise. */
export class AddPackageNameError extends PenvError {
  override readonly name = "AddPackageNameError";

  constructor(spec: string) {
    super(
      "PENV_ADD_PACKAGE_NAME",
      `\`${spec}\` is not an npm package name`,
      "Name the package exactly as npm does, e.g. `penv add @acme/provider-consul@1.4.2`.",
    );
  }
}

/** A flag `penv add` does not have. */
export class AddFlagError extends PenvError {
  override readonly name = "AddFlagError";

  constructor(flag: string) {
    super(
      "PENV_ADD_FLAG",
      `\`penv add\` does not understand \`${flag}\``,
      `Run \`penv add <package>\` with \`${TRUST_YOUNG_FLAG}\`, \`--registry <url>\`, ` +
        `\`${LOCAL_FLAG}\`, or \`${YES_FLAG}\` — those are the four it takes.`,
    );
  }
}

/** The flag that adds an extension this project builds instead of one a registry publishes. */
export const LOCAL_FLAG = "--local";

/** `--local` asked for something only a published release has. */
export class AddLocalFlagError extends PenvError {
  override readonly name = "AddLocalFlagError";

  constructor(subject: string) {
    super(
      "PENV_ADD_LOCAL_FLAG",
      `\`penv add ${LOCAL_FLAG}\` cannot take ${subject}`,
      `${LOCAL_FLAG} adds the package this project already builds, so there is no release to ` +
        "name and nothing to pin. Publish it and run `penv add <package>` to pin one.",
    );
  }
}

/**
 * The extension resolved and is not something penv can import.
 *
 * `add` used to certify resolution and stop there, so a package whose `exports`
 * pointed at TypeScript source got three green checks and failed much later,
 * from an unrelated command. The load check runs here, at the one moment the
 * operator is looking at the provider.
 */
export class ExtensionNotImportableError extends PenvError {
  override readonly name = "ExtensionNotImportableError";

  constructor(name: string, entry: string | undefined, local: boolean) {
    super(
      "PENV_EXTENSION_NOT_IMPORTABLE",
      entry === undefined
        ? `${name} declares no entry point penv can import`
        : `${name} resolves to ${entry}, which penv cannot import`,
      "penv imports a provider with no transform, so its entry has to be built JavaScript. Point " +
        `the package's \`exports\` at its build output — \`dist/index.js\` — then run ` +
        `\`${addCommandFor(name, local)}\` again.`,
    );
  }
}

/** The extension imported and threw. Its own failure is the diagnosis. */
export class ExtensionUnloadableError extends PenvError {
  override readonly name = "ExtensionUnloadableError";

  constructor(name: string, entry: string, detail: string, local: boolean) {
    super(
      "PENV_EXTENSION_UNLOADABLE",
      `${name} threw while penv imported ${entry}: ${detail}`,
      "Build the package and install its dependencies, then run " +
        `\`${addCommandFor(name, local)}\` again. penv adds a provider it has loaded once, or none.`,
    );
  }
}

/** `--local` on a package the project does not have. */
export class LocalExtensionUnresolvedError extends PenvError {
  override readonly name = "LocalExtensionUnresolvedError";

  constructor(name: string, root: string) {
    super(
      "PENV_LOCAL_EXTENSION_UNRESOLVED",
      `${name} does not resolve from ${root}`,
      `${LOCAL_FLAG} records that penv should read this package out of the project, so the ` +
        "project has to have it — add it as a dependency of the root (a workspace link is one), " +
        "then run this again.",
    );
  }
}

/** `penv add --local` on a machine with nobody at it. */
export class AddLocalInCiError extends PenvError {
  override readonly name = "AddLocalInCiError";

  constructor(name: string) {
    super(
      "PENV_ADD_LOCAL_IN_CI",
      `Adding ${name} writes ${LOCAL_EXTENSIONS_PATH}, and CI does not decide what a project develops`,
      `Run \`penv add ${LOCAL_FLAG} ${name}\` from a terminal and commit what it writes.`,
    );
  }
}

/** `--registry` with something that is not an https origin. */
export class AddRegistryError extends PenvError {
  override readonly name = "AddRegistryError";

  constructor(value: string) {
    super(
      "PENV_ADD_REGISTRY",
      `\`--registry ${value}\` is not an https URL`,
      "Write the registry's origin, e.g. `--registry https://npm.acme.internal`. Over plain http " +
        "the integrity check proves only that you got the bytes an attacker on the network chose.",
    );
  }
}

/** penv's own packages, offered by a registry that is not npmjs. */
export class OfficialRegistryError extends PenvError {
  override readonly name = "OfficialRegistryError";

  constructor(name: string, registry: string) {
    super(
      "PENV_OFFICIAL_REGISTRY",
      `${name} was asked for from ${registry}, and \`${OFFICIAL_SCOPE}*\` packages come from npmjs`,
      `Run \`${addCommand(name)}\` without \`--registry\`. The official scope is the one penv ` +
        "adds without a trust question, so penv will not take it from somewhere else.",
    );
  }
}

/**
 * The registry could not be read at all.
 *
 * `retry` is the command that would repeat this resolution. Two commands read a
 * release — `add` and `upgrade` — and a refusal that named the wrong one would
 * send the reader to a command that answers a different question.
 */
export class RegistryUnreadableError extends PenvError {
  override readonly name = "RegistryUnreadableError";

  constructor(name: string, url: string, detail: string, retry: string = addCommand(name)) {
    super(
      "PENV_REGISTRY_UNREADABLE",
      `Reading ${name} from ${url} failed: ${detail}`,
      `Run \`${retry}\` again when the registry is reachable.`,
    );
  }
}

/** The registry has no such package. */
export class PackageUnknownError extends PenvError {
  override readonly name = "PackageUnknownError";

  constructor(name: string, url: string) {
    super(
      "PENV_PACKAGE_UNKNOWN",
      `${url} publishes no versions of ${name}`,
      "Check the package name against the registry — penv adds a package that exists or nothing.",
    );
  }
}

/** The package exists; the version asked for does not. */
export class VersionUnknownError extends PenvError {
  override readonly name = "VersionUnknownError";

  constructor(name: string, version: string, url: string, retry: string = addCommand(name)) {
    super(
      "PENV_VERSION_UNKNOWN",
      `${url} publishes no ${version} of ${name}`,
      `Run \`${retry}\` to take the version \`latest\` points at.`,
    );
  }
}

/** The registry answered, but without a fact the manifest has to record. */
export class ReleaseIncompleteError extends PenvError {
  override readonly name = "ReleaseIncompleteError";

  constructor(name: string, version: string, url: string, missing: string) {
    super(
      "PENV_RELEASE_INCOMPLETE",
      `${url} records no ${missing} for ${name} ${version}`,
      `Check the registry — the manifest pins ${missing} for every package, so penv records what ` +
        "the registry states or refuses to record it at all.",
    );
  }
}

/** A third-party package younger than the age gate, with no override. */
export class PackageTooYoungError extends PenvError {
  override readonly name = "PackageTooYoungError";

  constructor(name: string, version: string, publishedAt: string) {
    super(
      "PENV_PACKAGE_TOO_YOUNG",
      `${name} ${version} was published ${publishedAt}, and penv waits ${MIN_PACKAGE_AGE_DAYS} ` +
        `days before adding a package outside \`${OFFICIAL_SCOPE}*\``,
      `Run \`${addCommand(name, version, TRUST_YOUNG_FLAG)}\` to add it anyway and record why. ` +
        "The wait is there because a hijacked publish is usually caught within days.",
    );
  }
}

/**
 * Extension entries penv could not read, that the command in hand does not repair.
 *
 * One unreadable entry is what `penv add <pkg>` exists to rewrite, so that is the
 * remedy. More than one is beyond a single `add` — each rewrites only its own —
 * and the manifest is committed, so the file itself is the thing to restore.
 */
export class ManifestEntriesUnreadableError extends PenvError {
  override readonly name = "ManifestEntriesUnreadableError";

  constructor(names: readonly string[]) {
    const one = names.length === 1;
    super(
      "PENV_MANIFEST_ENTRIES_UNREADABLE",
      `${MANIFEST_PATH} holds ${one ? "an extension entry" : "extension entries"} penv cannot ` +
        `read: ${names.join(", ")}`,
      one
        ? `Run \`${addCommand(names[0] ?? "")}\` to rewrite that entry — it resolves the package ` +
            "again and records what the registry states."
        : `Restore it with \`git checkout ${MANIFEST_PATH}\`. Each \`penv add\` rewrites only its ` +
            "own entry, so more than one broken entry is not something one of them can fix.",
    );
  }
}

/** `penv add` needs the registry, and `--no-download` says this run has no network. */
export class AddNoDownloadError extends PenvError {
  override readonly name = "AddNoDownloadError";

  constructor(name: string) {
    super(
      "PENV_ADD_NO_DOWNLOAD",
      `Adding ${name} means reading the registry for the version and integrity to pin, and ` +
        "`--no-download` says this run does not",
      `Run \`${addCommand(name)}\` without \`--no-download\`. Nothing was fetched or written.`,
    );
  }
}

/**
 * `penv add` with a question and nobody to answer it.
 *
 * Only the trust ceremony reaches here. It used to refuse every unattended add,
 * including an `@penvhq/*` one that asks nothing at all — a gate stopping a run
 * that would have been silent. What no flag can supply is the ceremony's one
 * field: a sentence about why a stranger's code is trusted, which is why
 * `--yes` does not answer it either.
 */
export class AddTrustUnattendedError extends PenvError {
  override readonly name = "AddTrustUnattendedError";

  constructor(name: string, ceremony: string) {
    super(
      "PENV_ADD_TRUST_UNATTENDED",
      `Adding ${name} records ${ceremony}, and this run has nobody to write it`,
      `Run \`${addCommand(name)}\` from a terminal, without \`${YES_FLAG}\` — the trust block is ` +
        `a line only a person can write. In CI, run \`${INSTALL_COMMAND}\`: it installs the ` +
        "versions the committed manifest already pins.",
    );
  }
}

/** The trust ceremony was declined. Nothing was installed or recorded. */
export class TrustDeclinedError extends PenvError {
  override readonly name = "TrustDeclinedError";

  constructor(name: string, version: string) {
    super(
      "PENV_TRUST_DECLINED",
      `${name} ${version} was not trusted, so penv installed and recorded nothing`,
      `Run \`${addCommand(name, version)}\` again when you have reviewed what it does.`,
    );
  }
}

/** A third-party trust block with nobody named in it. */
export class TrustPublisherMissingError extends PenvError {
  override readonly name = "TrustPublisherMissingError";

  constructor(name: string, version: string) {
    super(
      "PENV_TRUST_PUBLISHER_MISSING",
      `The publisher of ${name} ${version} was left empty, and the registry names none either`,
      `Run \`${addCommand(name, version)}\` again and name the npm account you checked — a ` +
        "third-party trust block records who was trusted, not only that someone was.",
    );
  }
}

/** The trust block's one human field came back empty. */
export class TrustReasonMissingError extends PenvError {
  override readonly name = "TrustReasonMissingError";

  constructor(name: string, version: string) {
    super(
      "PENV_TRUST_REASON_MISSING",
      `The reason for trusting ${name} ${version} was left empty`,
      `Run \`${addCommand(name, version)}\` again and write one line on what you checked — the ` +
        "next reviewer reads that line, not the diff.",
    );
  }
}

/** `penv.types` names a file the published package does not contain. */
export class DeclarationMissingError extends PenvError {
  override readonly name = "DeclarationMissingError";

  constructor(name: string, file: string) {
    super(
      "PENV_DECLARATION_MISSING",
      `${name} declares its types at \`${file}\`, and the published package has no such file`,
      `Report it to ${name}. penv commits the declaration a provider ships, so it will not ` +
        "invent one that claims to describe this provider's configuration.",
    );
  }
}

/** The declaration a package ships reaches for something the project does not have. */
export class DeclarationNotSelfContainedError extends PenvError {
  override readonly name = "DeclarationNotSelfContainedError";

  constructor(name: string, file: string, specifier: string) {
    super(
      "PENV_DECLARATION_NOT_SELF_CONTAINED",
      `The declaration ${name} ships at \`${file}\` imports \`${specifier}\``,
      `Report it to ${name}. What penv commits to ${EXTENSIONS_PATH} is types and nothing else, ` +
        "so it can only carry a declaration that stands on its own.",
    );
  }
}

/**
 * The declaration a package ships names a field core owns on every entry.
 *
 * An environment entry carries the provider's own vocabulary beside core's four
 * names, so a shape declaring one of them would shadow what penv writes there —
 * the discriminant, or the key that seals the environment.
 */
export class DeclarationReservedFieldError extends PenvError {
  override readonly name = "DeclarationReservedFieldError";

  constructor(name: string, file: string, field: string) {
    super(
      "PENV_DECLARATION_RESERVED_FIELD",
      `The declaration ${name} ships at \`${file}\` declares \`${field}\`, which penv owns on every environment entry`,
      `Report it to ${name}. penv reserves ${RESERVED_ENTRY_FIELDS.map((reserved) => `\`${reserved}\``).join(", ")} ` +
        "inside an `environments` entry, so a provider names its own fields in its own vocabulary — " +
        "`project`, `path` — and leaves those four to penv.",
    );
  }
}

/** A launcher built from source, asked to record which bytes it just ran. */
export class EnginePinUnreleasedError extends PenvError {
  override readonly name = "EnginePinUnreleasedError";

  constructor() {
    super(
      "PENV_ENGINE_PIN_UNRELEASED",
      `This penv was built from source, so it carries no published integrity for ${ENGINE_PACKAGE} ` +
        `to write into ${MANIFEST_PATH}`,
      "Install penv from npm with `npm install -g @penvhq/launcher` and run the command again — a released " +
        "launcher ships the integrity of the engine it ships.",
    );
  }
}

/** The pin embedded at release time and the engine beside it are different versions. */
export class EnginePinMismatchError extends PenvError {
  override readonly name = "EnginePinMismatchError";

  constructor(pinned: string, ran: string) {
    super(
      "PENV_ENGINE_PIN_MISMATCH",
      `This penv carries the integrity of ${ENGINE_PACKAGE} ${pinned} and just ran ${ran}, so it ` +
        "cannot record which bytes scaffolded this project",
      "Reinstall the launcher with `npm install -g @penvhq/launcher` — its pin and its engine ship together.",
    );
  }
}

/** `penv upgrade` with something other than one optional version. */
export class UpgradeSubjectError extends PenvError {
  override readonly name = "UpgradeSubjectError";

  constructor() {
    super(
      "PENV_UPGRADE_SUBJECT",
      "`penv upgrade` takes one version, or none",
      `Run \`${UPGRADE_COMMAND}\` to move to whatever \`latest\` points at, or ` +
        `\`${UPGRADE_COMMAND} 0.9.6\` to move to an exact release.`,
    );
  }
}

/** A flag `penv upgrade` does not have. */
export class UpgradeFlagError extends PenvError {
  override readonly name = "UpgradeFlagError";

  constructor(flag: string) {
    super(
      "PENV_UPGRADE_FLAG",
      `\`${UPGRADE_COMMAND}\` does not understand \`${flag}\``,
      `Run \`${UPGRADE_COMMAND} [version]\` with \`${YES_FLAG}\` — that is the one flag it takes.`,
    );
  }
}

/** `penv upgrade` needs the registry, and `--no-download` says this run has no network. */
export class UpgradeNoDownloadError extends PenvError {
  override readonly name = "UpgradeNoDownloadError";

  constructor() {
    super(
      "PENV_UPGRADE_NO_DOWNLOAD",
      `Upgrading means reading the registry for the version and integrity to pin, and ` +
        "`--no-download` says this run does not",
      `Run \`${UPGRADE_COMMAND}\` without \`--no-download\`. Nothing was fetched or written.`,
    );
  }
}

/**
 * `penv upgrade` on a machine with nobody at it.
 *
 * Unattended, penv will move the pin only to a version somebody named and only
 * with the flag that says they meant it: what upgrade rewrites is two committed
 * files, and a pipeline that picks the engine is a pipeline choosing which bytes
 * the project runs.
 */
export class UpgradeUnattendedError extends PenvError {
  override readonly name = "UpgradeUnattendedError";

  constructor() {
    super(
      "PENV_UPGRADE_UNATTENDED",
      `Upgrading rewrites ${MANIFEST_PATH} and package.json, and this run has nobody to decide that`,
      `Run \`${UPGRADE_COMMAND} <version> ${YES_FLAG}\` — unattended, penv moves the pin only to a ` +
        `version you named. In CI, run \`${INSTALL_COMMAND}\`: it installs what the committed ` +
        "manifest already pins.",
    );
  }
}

/** The upgrade was shown and declined. Neither committed file was touched. */
export class UpgradeDeclinedError extends PenvError {
  override readonly name = "UpgradeDeclinedError";

  constructor(version: string) {
    super(
      "PENV_UPGRADE_DECLINED",
      `${ENGINE_PACKAGE} ${version} was not installed, so ${MANIFEST_PATH} and package.json are unchanged`,
      `Run \`${UPGRADE_COMMAND} ${version}\` again when you want both of them to move.`,
    );
  }
}

/**
 * The package manager refused, so the pin stayed where it was.
 *
 * The dependency moves before the manifest for exactly this reason: an upgrade
 * that cannot finish leaves a project pinning the engine it was already running.
 * The remedy is never the command that just failed — that is the one instruction
 * known not to work. The manager printed why; that line is where to look.
 */
export class UpgradeInstallFailedError extends PenvError {
  override readonly name = "UpgradeInstallFailedError";

  constructor(manager: string, version: string) {
    super(
      "PENV_UPGRADE_INSTALL_FAILED",
      `${manager} did not finish moving this project to ${ENGINE_PACKAGE} ${version}, so ` +
        `${MANIFEST_PATH} still pins the engine it pinned before`,
      `Read what ${manager} printed above — it names what it refused. Fix that and run ` +
        `\`${UPGRADE_COMMAND} ${version}\` again; the pin and the dependency move together or ` +
        "not at all.",
    );
  }
}

/** An installed directory with nothing runnable in it. */
export class EngineEntryError extends PenvError {
  override readonly name = "EngineEntryError";

  constructor(name: string, version: string, dir: string) {
    super(
      "PENV_ENGINE_ENTRY",
      `${name} ${version} in ${dir} declares no bin penv can run`,
      `Delete ${dir} and run \`${INSTALL_COMMAND}\` to install it again.`,
    );
  }
}
