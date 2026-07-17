/**
 * The public surface of `@penv/runtime` — what `penv` re-exports.
 *
 * `defineConfig` is re-exported from `@penv/core` because the docs show
 * `penv.config.ts` importing it from `penv`: one import specifier for the whole
 * tool, whatever package a symbol happens to live in.
 */

export {
  ConfigError,
  defineConfig,
  FilenameGrammarError,
  MissingParameterError,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
  ValidationError,
} from "@penv/core";
export type { LoadOptions } from "./load.js";
export { load } from "./load.js";
