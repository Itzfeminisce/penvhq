/**
 * The public runtime surface of `@penvhq/penv` — the one dependency `penv init`
 * writes into an adopted project, and all of what it puts in the import graph.
 *
 * This file is a re-export and nothing else. The package ships two entries and no
 * command line: `.` is this barrel, and `./config` is the dotenv-shaped
 * `process.env` form. The engine is `@penvhq/cli`, which the launcher installs
 * into its own cache and never into the application's import graph. Anything that
 * is not `@penvhq/runtime`'s barrel is an implementation detail of the workspace
 * and deliberately not visible under the `@penvhq/penv` specifier.
 */

export type { InjectResult, LoadOptions, LoadOptionsFor } from "@penvhq/runtime";
export {
  ConfigError,
  DirectStartError,
  declaredRefs,
  defineConfig,
  FilenameGrammarError,
  inject,
  load,
  MissingMaterializationError,
  MissingParameterError,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
  ValidationError,
} from "@penvhq/runtime";
