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
export type { DotenvEntry, DotenvParseResult } from "./dotenv.js";
export { parseDotenv, serializeDotenv } from "./dotenv.js";
export {
  ConfigError,
  FilenameGrammarError,
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
  isParameterFile,
  isReservedToken,
  parameterId,
  parseFilename,
  reservedTokensFor,
  validateEnvironmentNames,
} from "./grammar.js";
export { effectiveMeta, isRequired, isSecret, parseMeta, serializeMeta } from "./meta.js";
export {
  accessPath,
  checkNameCollisions,
  defaultVariableName,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "./names.js";
export { candidatesFor, resolveAll, resolveParameter } from "./resolve.js";
export type {
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
