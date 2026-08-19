/**
 * The Vercel name pre-flight: judge every generated variable against Vercel's key
 * grammar *before* anything is pushed, so a push is all or nothing and a rejected
 * key is never discovered after forty variables are already placed.
 *
 * The rule that matters most: validate the variable `penv generate` actually
 * emits, never the parameter name. Composed from the real transform
 * (`variableName`) rather than re-deriving it, so it cannot drift from what a
 * push actually sends.
 *
 * Two rules, both Vercel's own and both documented as deployment errors:
 * `env_key_invalid_characters` and `env_key_invalid_length`.
 * https://vercel.com/docs/rest-api/errors
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { parameterId, variableName } from "@penvhq/core";
import { VercelNameError } from "./errors.js";

/** "The only valid characters are letters, digits and `_`". */
const LEGAL_KEY = /^[A-Za-z0-9_]+$/;
/** "the maximum permitted name is 256 characters". */
const MAX_KEY_LENGTH = 256;

function charset(variable: string, parameter: string): VercelNameError {
  return new VercelNameError(
    "charset",
    variable,
    [parameter],
    `The parameter \`${parameter}\` generates the variable \`${variable}\`, which Vercel rejects — an environment-variable name may contain only letters, digits, and \`_\``,
    "Rename the parameter, or map it to a name matching `[A-Za-z0-9_]` in the `override` block of " +
      "penv.config.ts.",
  );
}

function length(variable: string, parameter: string): VercelNameError {
  return new VercelNameError(
    "length",
    variable,
    [parameter],
    `The parameter \`${parameter}\` generates the variable \`${variable}\`, which is ${variable.length} characters — Vercel allows ${MAX_KEY_LENGTH}`,
    `Shorten the parameter, or map it to a name of ${MAX_KEY_LENGTH} characters or fewer in the ` +
      "`override` block of penv.config.ts.",
  );
}

/**
 * Every generated variable that violates Vercel's grammar, collected rather than
 * thrown so a push reports every bad name at once and refuses before the first
 * write. Deterministic: violations in variable order, then parameter order.
 *
 * Exact-string collisions are core's `checkNameCollisions`, run before this.
 * Vercel keys are case-*sensitive*, so — unlike GitHub — there is no
 * case-collision rule to add here.
 */
export function checkVercelNames(
  refs: readonly ParameterRef[],
  config: PenvConfig,
): VercelNameError[] {
  const named = refs
    .map((ref) => ({ variable: variableName(ref, config), parameter: parameterId(ref) }))
    .sort((a, b) =>
      a.variable < b.variable
        ? -1
        : a.variable > b.variable
          ? 1
          : a.parameter < b.parameter
            ? -1
            : a.parameter > b.parameter
              ? 1
              : 0,
    );

  const errors: VercelNameError[] = [];
  for (const { variable, parameter } of named) {
    if (!LEGAL_KEY.test(variable)) {
      errors.push(charset(variable, parameter));
    } else if (variable.length > MAX_KEY_LENGTH) {
      errors.push(length(variable, parameter));
    }
  }
  return errors;
}
