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
  MANIFEST_PATH,
  OFFICIAL_SCOPE,
  PenvError,
} from "@penvhq/core";

/** The command that materializes everything the manifest pins. */
export const INSTALL_COMMAND = "penv install";

/** How long a package outside the official scope must have existed. */
export const MIN_PACKAGE_AGE_DAYS = 7;

/** The flag that overrides {@link MIN_PACKAGE_AGE_DAYS}, and only that. */
export const TRUST_YOUNG_FLAG = "--trust-young";

/** The `penv add` that would repeat this exact decision. */
function addCommand(name: string, version?: string, extra?: string): string {
  const spec = version === undefined ? name : `${name}@${version}`;
  return `penv add ${spec}${extra === undefined ? "" : ` ${extra}`}`;
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
      `Run \`penv add <package>\` with \`${TRUST_YOUNG_FLAG}\` or \`--registry <url>\` — those ` +
        "are the two it takes.",
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

/** The registry could not be read at all. */
export class RegistryUnreadableError extends PenvError {
  override readonly name = "RegistryUnreadableError";

  constructor(name: string, url: string, detail: string) {
    super(
      "PENV_REGISTRY_UNREADABLE",
      `Reading ${name} from ${url} failed: ${detail}`,
      `Run \`${addCommand(name)}\` again when the registry is reachable.`,
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

  constructor(name: string, version: string, url: string) {
    super(
      "PENV_VERSION_UNKNOWN",
      `${url} publishes no ${version} of ${name}`,
      `Run \`${addCommand(name)}\` to take the version \`latest\` points at.`,
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
 * `penv add` on a machine with nobody at it.
 *
 * It is refused everywhere, not only for the packages that pay the trust
 * ceremony: what `add` writes is two committed files, and a pipeline that
 * rewrites the manifest it was handed is a pipeline choosing which bytes the
 * project runs. `penv install` is the command CI has, and it installs exactly
 * what a person already decided.
 */
export class AddNotInteractiveError extends PenvError {
  override readonly name = "AddNotInteractiveError";

  constructor(name: string) {
    super(
      "PENV_ADD_NOT_INTERACTIVE",
      `Adding ${name} rewrites ${MANIFEST_PATH}, and this run has nobody to decide that`,
      `Run \`${addCommand(name)}\` from a terminal and commit what it writes. In CI, run ` +
        `\`${INSTALL_COMMAND}\` — it installs the versions the committed manifest already pins.`,
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

/** A launcher built from source, asked to record which bytes it just ran. */
export class EnginePinUnreleasedError extends PenvError {
  override readonly name = "EnginePinUnreleasedError";

  constructor() {
    super(
      "PENV_ENGINE_PIN_UNRELEASED",
      `This penv was built from source, so it carries no published integrity for ${ENGINE_PACKAGE} ` +
        `to write into ${MANIFEST_PATH}`,
      "Install penv from npm with `npm install -g penv` and run the command again — a released " +
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
      "Reinstall the launcher with `npm install -g penv` — its pin and its engine ship together.",
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
