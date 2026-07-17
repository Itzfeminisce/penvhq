/**
 * The public runtime surface of `penv` — what `npm install penv` puts in an
 * application's import graph.
 *
 * This file is a re-export and nothing else. `penv` is one install carrying two
 * surfaces with different weight budgets, and the boundary between them is drawn
 * here: everything below ships into the app, while `npx penv` reaches
 * `@penvhq/cli` through `./cli.js` and never through this module. Anything that is
 * not `@penvhq/runtime`'s barrel is an implementation detail of the workspace and
 * deliberately not visible under the `penv` specifier.
 */

export type { LoadOptions } from "@penvhq/runtime";
export {
  ConfigError,
  defineConfig,
  FilenameGrammarError,
  load,
  MissingParameterError,
  NameCollisionError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
  ValidationError,
} from "@penvhq/runtime";
