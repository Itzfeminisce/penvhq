/**
 * The public surface of the launcher.
 *
 * The store, the fetcher and the verifier are exported because `penv add`
 * installs into the same `$PENV_HOME` by the same rules: one implementation of
 * "download, verify, install", or the two commands would disagree about what
 * counts as installed.
 */

export type { AddOptions, AddResult } from "./add.js";
export { add } from "./add.js";
export type { ProviderEntry } from "./config-edit.js";
export { readProviderEntries, setProviderType } from "./config-edit.js";
export type { DeclarationSubject, ExtensionPackage } from "./declaration.js";
export {
  declarationPath,
  readExtensionPackage,
  renderDeclaration,
  writeDeclaration,
} from "./declaration.js";
export type { Delegation, Spawner } from "./delegate.js";
export { nodeSpawner } from "./delegate.js";
export type { Engine } from "./engine.js";
export { bundledEngine, ENGINE_BIN, engineAt } from "./engine.js";
export {
  AddFlagError,
  AddLocalFlagError,
  AddLocalInCiError,
  AddNoDownloadError,
  AddPackageNameError,
  AddRegistryError,
  AddSubjectError,
  AddTrustUnattendedError,
  ArchiveError,
  DeclarationMissingError,
  DeclarationNotSelfContainedError,
  DownloadFailedError,
  DownloadIntegrityError,
  EngineEntryError,
  EnginePinMismatchError,
  EnginePinUnreleasedError,
  ExtensionNotImportableError,
  ExtensionUnloadableError,
  INSTALL_COMMAND,
  InstallDeclinedError,
  LOCAL_FLAG,
  LocalExtensionUnresolvedError,
  MIN_PACKAGE_AGE_DAYS,
  NoProjectError,
  OfficialRegistryError,
  PackageCorruptError,
  PackageMissingError,
  PackageTooYoungError,
  PackageUnknownError,
  RegistryUnreadableError,
  ReleaseIncompleteError,
  TRUST_YOUNG_FLAG,
  TrustDeclinedError,
  TrustPublisherMissingError,
  TrustReasonMissingError,
  UPGRADE_COMMAND,
  UpgradeDeclinedError,
  UpgradeFlagError,
  UpgradeInstallFailedError,
  UpgradeNoDownloadError,
  UpgradeSubjectError,
  UpgradeUnattendedError,
  VersionUnknownError,
  YES_FLAG,
} from "./errors.js";
export type { Fetcher } from "./fetcher.js";
export { httpFetcher } from "./fetcher.js";
export {
  HOME_META_FILE,
  INTEGRITY_FILE,
  launcherUpdateCommand,
  NPM_UPDATE_COMMAND,
} from "./home.js";
export { integrityOf } from "./integrity.js";
export type { LauncherIo } from "./io.js";
export type { LauncherOptions } from "./launcher.js";
export { runLauncher } from "./launcher.js";
export {
  assertReleasePin,
  BUNDLED_ENGINE_PIN,
  DEV_PIN_INTEGRITY,
  DEV_PIN_VERSION,
  releaseEnginePin,
} from "./pins.js";
export type { Project } from "./project.js";
export { findAdoptedRoot, findProject } from "./project.js";
export type { Release, ReleaseQuery } from "./registry.js";
export { fetchRelease, packumentUrl } from "./registry.js";
export type { Installation, InstallOptions, InstallState, Pin } from "./store.js";
export { DEFAULT_REGISTRY, inspectInstall, installPin, tarballUrl } from "./store.js";
export type { ArchiveSubject, TarEntry } from "./tar.js";
export { readTarball } from "./tar.js";
export type { UpgradeOptions } from "./upgrade.js";
export { upgrade } from "./upgrade.js";
