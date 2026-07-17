/**
 * Validating the `sinks` block.
 *
 * A sink is a destination penv pushes to, declared per environment beside
 * `providers`. This checks the *shape* of the declaration — one entry per
 * declared environment, each naming a `type` — exactly as `providers` and `keys`
 * are checked. What a given sink type accepts beyond that (a GitHub `owner/repo`,
 * the destination's name grammar) is the sink's own concern and is checked in the
 * sink package, so core stays destination-agnostic.
 *
 * Mirrors `validateKeys` deliberately: `sinks` is the same shape of fact — one
 * entry per environment — and a second style of check for the same shape is a
 * second thing to learn.
 */

import { ConfigError, type PenvError } from "./errors.js";
import type { PenvConfig } from "./types.js";

/**
 * Every problem in the `sinks` block, collected rather than thrown so `penv
 * validate` reports the whole config in one pass.
 */
export function validateSinks(config: PenvConfig, declared: ReadonlySet<string>): PenvError[] {
  const errors: PenvError[] = [];
  const sinks: unknown = config.sinks;
  if (sinks === undefined) {
    return errors;
  }
  if (sinks === null || typeof sinks !== "object" || Array.isArray(sinks)) {
    errors.push(
      new ConfigError(
        "`sinks` in penv.config.ts is not an object",
        'Declare one sink per environment, e.g. `sinks: { production: { type: "github" } }`, or remove the block.',
      ),
    );
    return errors;
  }

  const entries = sinks as Readonly<Record<string, unknown>>;
  for (const environment of Object.keys(entries)) {
    if (!declared.has(environment)) {
      errors.push(
        new ConfigError(
          `The \`sinks\` block in penv.config.ts names environment ${environment}, which is not declared`,
          `Add \`${environment}\` to the \`environments\` list, or remove its \`sinks\` entry. ` +
            "Environments are a whitelist — penv never infers one.",
        ),
      );
      continue;
    }
    const entry = entries[environment];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        new ConfigError(
          `The \`sinks\` entry for environment ${environment} is not a sink object`,
          `Declare it as \`${environment}: { type: "github" }\`.`,
        ),
      );
      continue;
    }
    const { type, repo } = entry as Readonly<Record<string, unknown>>;
    if (typeof type !== "string" || type.trim().length === 0) {
      errors.push(
        new ConfigError(
          `The \`sinks\` entry for environment ${environment} declares no \`type\``,
          `Name the destination this environment's values are pushed to, e.g. \`${environment}: { type: "github" }\`.`,
        ),
      );
    }
    if (repo !== undefined && (typeof repo !== "string" || repo.trim().length === 0)) {
      errors.push(
        new ConfigError(
          `The \`sinks\` entry for environment ${environment} declares a \`repo\` that is not a non-empty string`,
          'Set `repo` to the destination target, e.g. `repo: "my-org/my-app"`, or remove it to let the ' +
            "destination's own CLI resolve it from the working directory.",
        ),
      );
    }
  }

  return errors;
}
