/**
 * What the launcher refuses, and the one command that clears each refusal.
 *
 * Every one of these is a wrong-bytes or no-bytes answer to the same question —
 * which penv is this project's — so they all name the package, the version, and
 * a single next command. None of them mentions the launcher/engine split: that
 * surfaces in exactly one refusal, and core owns it.
 */

import { MANIFEST_PATH, PenvError } from "@penvhq/core";

/** The command that materializes everything the manifest pins. */
export const INSTALL_COMMAND = "penv install";

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
