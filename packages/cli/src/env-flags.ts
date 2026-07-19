/**
 * Environment shorthand flags: `penv pull --production` for any environment the
 * config whitelists.
 *
 * User-defined names land in penv's flag namespace under three rules that keep
 * the two from ever fighting:
 *
 * 1. **A real flag always wins.** Candidates are collected *after* every flag
 *    the command declares (and penv's globals) is excluded, so an environment
 *    named `yes` simply has no shorthand — `--env yes` still works, and config
 *    can never rebind a flag penv defines.
 * 2. **Exactly one.** Two environment flags in one invocation is a hard error,
 *    never first-wins; a shorthand that contradicts an explicit `--env` is the
 *    same error.
 * 3. **`--env` stays canonical.** The shorthand is sugar; scripts and error
 *    messages use the spelling that always works, including for names that
 *    cannot be flags at all.
 *
 * Resolution happens post-parse against the loaded config's whitelist — the
 * parser knows nothing about environments, so the config cannot influence
 * parsing, only interpretation.
 */

import type { PenvConfig } from "@penvhq/core";
import { PenvError } from "@penvhq/core";

/** Flags every penv invocation owns regardless of command. */
const BASE_RESERVED = ["help", "version", "h", "v", "_", "--"] as const;

/**
 * Every flag name a penv command declares, across commands. An environment named
 * one of these loses its shorthand (rule 1) — `doctor` warns through
 * {@link shadowedEnvironments} so the user hears it once, calmly, rather than
 * discovering a flag that silently means something else.
 */
const COMMAND_FLAGS = [
  ...BASE_RESERVED,
  "env",
  "out",
  "allow-decrypt",
  "destination",
  "dest",
  "d",
  "location",
  "l",
  "yes",
  "y",
] as const;

/** The declared environments whose names a real flag shadows — no shorthand for these. */
export function shadowedEnvironments(config: PenvConfig): string[] {
  const flags = new Set<string>(COMMAND_FLAGS);
  return config.environments.filter((environment) => flags.has(environment));
}

/**
 * The bare `--<flag>` switches this invocation carries that the command did not
 * declare — the only place an environment shorthand can live. Collected in the
 * command layer, where the declared flag names are known; judged later, where
 * the config is.
 */
export function shorthandCandidates(
  args: Readonly<Record<string, unknown>>,
  declared: readonly string[],
): string[] {
  const reserved = new Set<string>([...BASE_RESERVED, ...declared]);
  return Object.keys(args).filter((key) => !reserved.has(key) && args[key] === true);
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `\`--${value}\``).join(", ");
}

/**
 * The environment the shorthand flags name, judged against the whitelist. An
 * unknown bare flag is an error naming the environments that would have worked
 * — before this, a typo'd `--prodction` was silently ignored.
 */
export function environmentFromShorthand(
  config: PenvConfig,
  candidates: readonly string[],
  explicit: string | undefined,
): string | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const hits = candidates.filter((candidate) => config.environments.includes(candidate));
  const strangers = candidates.filter((candidate) => !config.environments.includes(candidate));

  if (strangers.length > 0) {
    throw new PenvError(
      "UNKNOWN_FLAG",
      `${quoteList(strangers)} ${strangers.length === 1 ? "is not a flag" : "are not flags"} this command takes, and ${strangers.length === 1 ? "names" : "name"} no declared environment`,
      `Declared environments work as bare flags: ${quoteList(config.environments)}. Anything else needs \`--env <name>\`.`,
    );
  }
  if (hits.length > 1) {
    throw new PenvError(
      "ENVIRONMENT_FLAG_AMBIGUOUS",
      `${quoteList(hits)} name two environments at once, and a command acts on exactly one`,
      "Pass a single environment flag, or the canonical `--env <name>`.",
    );
  }
  const hit = hits[0];
  if (hit !== undefined && explicit !== undefined && explicit !== hit) {
    throw new PenvError(
      "ENVIRONMENT_FLAG_AMBIGUOUS",
      `\`--env ${explicit}\` and \`--${hit}\` name two environments at once`,
      "Drop one of them — `--env` is the canonical spelling.",
    );
  }
  return hit;
}
