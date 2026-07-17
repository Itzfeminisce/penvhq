/**
 * The public surface of `@penv/core`.
 *
 * Every consumer — the CLI, the runtime loader, future provider adapters —
 * speaks the vocabulary in `types.ts` and the errors in `errors.ts`. Nothing
 * outside this package imports a module path directly, so this barrel is the
 * contract: what is not re-exported here is an implementation detail.
 */

export {
  assertEnvironment,
  defineConfig,
  findConfigFile,
  loadConfig,
  loadConfigFrom,
  lookupEnvironment,
  resolveEnvironment,
  validateConfig,
} from "./config.js";
export type { DecryptResult } from "./crypto.js";
export {
  decryptValue,
  KeyUnavailableError,
  openValue,
  sameKey,
  sealValue,
  UndecryptableValueError,
} from "./crypto.js";
export type { DotenvEntry, DotenvParseResult } from "./dotenv.js";
export { parseDotenv, serializeDotenv } from "./dotenv.js";
export type { Envelope } from "./envelope.js";
export { formatEnvelope, NONCE_BYTES, parseEnvelope, TAG_BYTES } from "./envelope.js";
export {
  ConfigError,
  FilenameGrammarError,
  IllegalEnvironmentNameError,
  MissingParameterError,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
  ValidationError,
} from "./errors.js";
export {
  formatMetaFile,
  formatValueFile,
  isLegalEnvironmentName,
  isParameterFile,
  isReservedToken,
  parameterId,
  parseFilename,
  reservedTokensFor,
  validateEnvironmentNames,
} from "./grammar.js";
export type { KeyLookup, KeySource } from "./keys.js";
export {
  createEnvKeySource,
  KEY_BYTES,
  nullKeySource,
  resolveKeySource,
  validateKeys,
} from "./keys.js";
export { effectiveMeta, isRequired, isSecret, parseMeta, serializeMeta } from "./meta.js";
export {
  accessPath,
  checkNameCollisions,
  defaultVariableName,
  refFromAccessPath,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "./names.js";
export { candidatesFor, requireValue, resolveAll, resolveParameter } from "./resolve.js";
export type {
  DecryptFailure,
  DecryptReason,
  KeyConfig,
  Meta,
  MetaBlock,
  MetaFileRef,
  MetaFormat,
  ParameterRef,
  ParsedFile,
  PenvConfig,
  Provider,
  ProviderConfig,
  ReservedToken,
  Resolution,
  ResolutionCandidate,
  Scope,
  ValueFile,
} from "./types.js";
export { assertNever, META_FORMATS, RESERVED_TOKENS } from "./types.js";
