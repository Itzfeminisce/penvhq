/**
 * The public surface of `@penvhq/runtime` — what `penv` re-exports.
 *
 * `defineConfig` is re-exported from `@penvhq/core` because the docs show
 * `penv.config.ts` importing it from `penv`: one import specifier for the whole
 * tool, whatever package a symbol happens to live in.
 */

export {
  ConfigError,
  DirectStartError,
  defineConfig,
  FilenameGrammarError,
  MissingMaterializationError,
  MissingParameterError,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
  ValidationError,
} from "@penvhq/core";
export type {
  ChildEnvironment,
  ChildEnvironmentInput,
  DeclaredCredentials,
  DeliveredEnvironmentInput,
  DeliveredValue,
  Delivery,
  Environment,
} from "./child-env.js";
export {
  childEnvironment,
  consumeDelivery,
  DELIVERY_VARIABLE,
  deliveredEnvironment,
  ENVIRONMENT_VARIABLE,
  RUN_MARKER,
  SNAPSHOT_VARIABLE,
  strippedVariables,
} from "./child-env.js";
export { assertDeliverableNames } from "./control.js";
export type { InjectResult } from "./inject.js";
export { declaredRefs, inject } from "./inject.js";
export type { LoadOptions, LoadOptionsFor } from "./load.js";
export { load } from "./load.js";
export { hasRemoteSource } from "./resolve.js";
