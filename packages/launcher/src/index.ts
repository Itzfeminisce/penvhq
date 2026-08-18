/**
 * The public surface of the launcher.
 *
 * The store, the fetcher and the verifier are exported because `penv add`
 * installs into the same `$PENV_HOME` by the same rules: one implementation of
 * "download, verify, install", or the two commands would disagree about what
 * counts as installed.
 */

export type { Delegation, Spawner } from "./delegate.js";
export { nodeSpawner } from "./delegate.js";
export type { Engine } from "./engine.js";
export { bundledEngine, ENGINE_BIN, engineAt } from "./engine.js";
export {
  ArchiveError,
  DownloadFailedError,
  DownloadIntegrityError,
  EngineEntryError,
  INSTALL_COMMAND,
  InstallDeclinedError,
  NoProjectError,
  PackageCorruptError,
  PackageMissingError,
} from "./errors.js";
export type { Fetcher } from "./fetcher.js";
export { httpFetcher } from "./fetcher.js";
export type { Environment, PackageKind } from "./home.js";
export {
  HOME_META_FILE,
  INTEGRITY_FILE,
  launcherUpdateCommand,
  NPM_UPDATE_COMMAND,
  PENV_HOME_VAR,
  packageDir,
  penvHome,
} from "./home.js";
export { integrityOf } from "./integrity.js";
export type { LauncherIo, LauncherOptions } from "./launcher.js";
export { runLauncher } from "./launcher.js";
export type { Project } from "./project.js";
export { findProject } from "./project.js";
export type { Installation, InstallOptions, InstallState, Pin } from "./store.js";
export { DEFAULT_REGISTRY, inspectInstall, installPin, tarballUrl } from "./store.js";
export type { ArchiveSubject, TarEntry } from "./tar.js";
export { readTarball } from "./tar.js";
