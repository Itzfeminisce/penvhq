/**
 * The public surface of `@penvhq/core`.
 *
 * Every consumer — the CLI, the runtime loader, future provider adapters —
 * speaks the vocabulary in `types.ts` and the errors in `errors.ts`. Nothing
 * outside this package imports a module path directly, so this barrel is the
 * contract: what is not re-exported here is an implementation detail.
 */

export type { Artifact, ArtifactEntry, ArtifactExpectation } from "./artifact.js";
export {
  ARTIFACT_BUILD_COMMAND,
  ARTIFACT_FORMAT,
  ArtifactError,
  assertArtifactFor,
  deliveryDigest,
  parseArtifact,
  serializeArtifact,
  UnsupportedArtifactFormatError,
} from "./artifact.js";
export type { JitiApi } from "./config.js";
export {
  assertEnvironment,
  defineConfig,
  findConfigFile,
  jitiFor,
  loadConfig,
  loadConfigFrom,
  lookupEnvironment,
  resolveEnvironment,
  SCHEMA_HARVEST_ENV,
  schemaHarvestActive,
  setJitiApi,
  validateConfig,
} from "./config.js";
export type { DecryptResult } from "./crypto.js";
export {
  decryptValue,
  KeyUnavailableError,
  openSealed,
  openValue,
  sameKey,
  sealValue,
  UndecryptableValueError,
} from "./crypto.js";
export type { DotenvDiagnostic, DotenvEntry, DotenvParseResult } from "./dotenv.js";
export { parseDotenv, serializeDotenv } from "./dotenv.js";
export type { Envelope } from "./envelope.js";
export { formatEnvelope, NONCE_BYTES, parseEnvelope, TAG_BYTES } from "./envelope.js";
export type { ValidationWording } from "./errors.js";
export {
  ConfigError,
  DirectStartError,
  FilenameGrammarError,
  IllegalEnvironmentNameError,
  MissingMaterializationError,
  MissingParameterError,
  NameCollisionError,
  OldLayoutError,
  PenvError,
  ReservedTokenError,
  StrayCodeFileError,
  UnknownEnvironmentError,
  ValidationError,
} from "./errors.js";
export {
  formatMetaFile,
  formatValueFile,
  isCodeModule,
  isLegalEnvironmentName,
  isParameterFile,
  isReservedToken,
  parameterId,
  parseFilename,
  reservedTokensFor,
  validateEnvironmentNames,
} from "./grammar.js";
export type { Keychain, KeyLookup, KeySource } from "./keys.js";
export {
  createEnvKeySource,
  createKeychainKeySource,
  KEY_BYTES,
  KEYCHAIN_SERVICE,
  keySourceFrom,
  keySourceIdentifier,
  NO_KEY_SOURCE,
  nullKeySource,
  resolveKeySource,
  setKeychain,
  validateKeys,
} from "./keys.js";
export {
  assertMigrated,
  CUTOVER_PATH,
  EXTENSIONS_PATH,
  MANIFEST_PATH,
  oldLayoutEntries,
  PENV_DIR,
  penvDir,
  RECORDS_PATH,
  ROLLBACK_DOTENV_PATH,
  ROLLBACK_PATH,
  recordPath,
  recordsDir,
  renderStateGitignore,
  STATE_GITIGNORE_PATH,
  STATE_PATH,
  stateDir,
} from "./layout.js";
export type {
  LauncherUpdate,
  Manifest,
  ManifestEngine,
  ManifestExtension,
  ManifestTrust,
} from "./manifest.js";
export {
  ENGINE_PACKAGE,
  MANIFEST_FORMAT,
  ManifestError,
  OFFICIAL_SCOPE,
  parseManifest,
  serializeManifest,
  UnsupportedManifestFormatError,
} from "./manifest.js";
export { effectiveMeta, isRequired, isSecret, parseMeta, serializeMeta } from "./meta.js";
export {
  accessPath,
  checkNameCollisions,
  defaultVariableName,
  deliveryNames,
  isCanonicalSegment,
  refFromAccessPath,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "./names.js";
export { candidatesFor, requireValue, resolveAll, resolveParameter } from "./resolve.js";
export type { Rotation, RotationMechanism, RotationState } from "./rotation.js";
export {
  beginRotation,
  completeRotation,
  isOverdue,
  isStuck,
  LAST_ROTATED_KEY,
  parseDuration,
  ROTATING_SINCE_KEY,
  ROTATION_MECHANISM_KEY,
  ROTATION_POLICY_KEY,
  ROTATION_STATE_KEY,
  rotationOf,
  tryParseDuration,
} from "./rotation.js";
export {
  DEFAULT_SCHEMA_FILE,
  isPublicVariable,
  SCHEMA_SHAPE_FILE,
  schemaFileOf,
  schemaInsideTree,
  validatePublicPrefixes,
  validateSchemaFile,
} from "./schema-file.js";
export type {
  AnyProvider,
  DecryptFailure,
  DecryptReason,
  KeyConfig,
  KnownProviderType,
  Meta,
  MetaBlock,
  MetaFileRef,
  MetaFormat,
  OverrideBlock,
  OverrideKey,
  OverrideKeysOf,
  ParameterRef,
  ParsedFile,
  PenvConfig,
  PenvErrorLike,
  PenvSchemaShape,
  ProjectionProvider,
  ProjectionSecret,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderConfigMap,
  ProviderFactoryContext,
  ReservedToken,
  Resolution,
  ResolutionCandidate,
  RetainingProvider,
  Scope,
  SecretScope,
  ValidatedProviderEntry,
  ValidatedProviders,
  ValueFile,
} from "./types.js";
export {
  assertNever,
  holdsProjection,
  holdsRecords,
  META_FORMATS,
  own,
  RESERVED_TOKENS,
  readsValues,
  retainsPrevious,
} from "./types.js";
