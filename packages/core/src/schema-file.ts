/**
 * Where the schema module lives.
 *
 * `.penv/env.ts` by default, and anywhere the project says. The file is the
 * user's — scaffolded once, never regenerated (invariant 2) — and a file penv
 * insists on owning the location of is not fully theirs. Nothing downstream
 * moves when it does: application code imports `@env`, and the alias is what
 * `penv init` writes.
 *
 * This is the one authority on the answer. The CLI reads the schema, the grammar
 * has to know not to read it as a parameter, and `watch` has to notice when it
 * changes — three callers, one question, so none of them works it out alone.
 */

import { ConfigError, type PenvError } from "./errors.js";
import type { PenvConfig } from "./types.js";

/** Where the schema lives when the project does not say. */
export const DEFAULT_SCHEMA_FILE = ".penv/env.ts";

/** The directory the parameter tree lives in, relative to the config. */
const PENV_DIR = ".penv";

/** The extensions penv can evaluate, matching the config file's own set. */
const EXTENSIONS = [".ts", ".js", ".mjs"] as const;

/** Every path here is POSIX, so a config written on Windows reads the same on Linux. */
function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** The schema module's path, relative to the directory holding `penv.config.ts`. */
export function schemaFileOf(config: PenvConfig): string {
  const declared = config.schemaFile;
  return declared === undefined || declared.trim().length === 0
    ? DEFAULT_SCHEMA_FILE
    : posix(declared.trim());
}

/**
 * The schema's path relative to `.penv/`, or `undefined` when it lives outside.
 *
 * The grammar reads every file in the tree as a parameter, so a schema *inside*
 * the tree has to be excluded by name — and a schema outside it never needs to
 * be, which is the quiet reason moving it out is a simplification rather than a
 * feature. Answering `undefined` is how the grammar learns it has nothing to skip.
 */
export function schemaInsideTree(config: PenvConfig): string | undefined {
  const file = schemaFileOf(config);
  const prefix = `${PENV_DIR}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

/**
 * Every problem with `schemaFile`, collected rather than thrown so `penv
 * validate` reports the whole config in one pass.
 *
 * The rules are the ones a path has to satisfy to survive being committed:
 * `penv.config.ts` is checked in, so a path that means something different on
 * another machine — or reaches outside the project — is a path that works for
 * exactly one person.
 */
export function validateSchemaFile(config: PenvConfig): PenvError[] {
  const declared = config.schemaFile;
  if (declared === undefined) {
    return [];
  }

  if (typeof declared !== "string" || declared.trim().length === 0) {
    return [
      new ConfigError(
        "`schemaFile` in penv.config.ts is not a path",
        `Give the module that exports the schema, relative to penv.config.ts — e.g. \`schemaFile: "src/env.ts"\` — or remove the key to use \`${DEFAULT_SCHEMA_FILE}\`.`,
      ),
    ];
  }

  const file = posix(declared.trim());
  const errors: PenvError[] = [];

  // An absolute path is one machine's answer. penv.config.ts is committed, so
  // the next clone — and every CI runner — would look somewhere that is not there.
  if (/^([A-Za-z]:)?\//.test(file)) {
    errors.push(
      new ConfigError(
        `\`schemaFile\` in penv.config.ts is the absolute path \`${file}\``,
        "Give it relative to penv.config.ts, e.g. `src/env.ts`. The config is committed, so an " +
          "absolute path is only correct on the machine that wrote it.",
      ),
    );
  }

  // The same refusal the grammar makes of a `..` namespace, for the same reason:
  // the project is the boundary, and a path that leaves it is not the project's.
  if (file.split("/").includes("..")) {
    errors.push(
      new ConfigError(
        `\`schemaFile\` in penv.config.ts reaches outside the project with \`..\``,
        "The schema lives inside the project that declares it. Give a path below penv.config.ts, " +
          "e.g. `src/env.ts`.",
      ),
    );
  }

  if (!EXTENSIONS.some((extension) => file.endsWith(extension))) {
    errors.push(
      new ConfigError(
        `\`schemaFile\` in penv.config.ts is \`${file}\`, which penv cannot evaluate`,
        `The schema module is ${EXTENSIONS.map((e) => `\`${e}\``).join(", ")} — penv evaluates it ` +
          "as it does penv.config.ts.",
      ),
    );
  }

  return errors;
}

/**
 * Every problem with `publicPrefixes`.
 *
 * A prefix is checked for being a plausible variable prefix rather than trusted,
 * because a typo here is silent in the worst direction: `NEXT_PUBIC_` matches
 * nothing, `doctor` finds nothing, and the check that exists to catch a secret
 * reaching a browser passes while never having looked.
 */
export function validatePublicPrefixes(config: PenvConfig): PenvError[] {
  const declared = config.publicPrefixes;
  if (declared === undefined) {
    return [];
  }
  if (!Array.isArray(declared)) {
    return [
      new ConfigError(
        "`publicPrefixes` in penv.config.ts is not an array",
        'Declare the prefixes your framework inlines into its client bundle, e.g. `publicPrefixes: ["NEXT_PUBLIC_"]`, or remove the key.',
      ),
    ];
  }

  const errors: PenvError[] = [];
  for (const prefix of declared) {
    if (typeof prefix !== "string" || !/^[A-Z][A-Z0-9_]*_$/.test(prefix)) {
      errors.push(
        new ConfigError(
          `The \`publicPrefixes\` entry \`${String(prefix)}\` in penv.config.ts is not a variable prefix`,
          "A prefix is upper-case letters, digits and underscores, ending in `_` — the shape of " +
            'the variables it matches, e.g. `"NEXT_PUBLIC_"` or `"VITE_"`.',
        ),
      );
    }
  }
  return errors;
}

/** True when `variable` is one a declared framework prefix would put in a browser. */
export function isPublicVariable(variable: string, config: PenvConfig): boolean {
  return (config.publicPrefixes ?? []).some((prefix) => variable.startsWith(prefix));
}
