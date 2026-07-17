/**
 * The GitHub name pre-flight: judge every generated variable against GitHub's
 * secret grammar *before* anything is pushed, so a push is all or nothing and a
 * reserved name is never discovered after sixty secrets are already placed.
 *
 * The rule that matters most: validate the variable `penv generate` actually
 * emits, never the parameter name. `config.names` values reach the destination
 * verbatim with no charset or case validation in core, so a parameter named
 * `githubToken` — a perfectly good name — transforms to `GITHUB_TOKEN`, which
 * GitHub reserves. Composed from the real transform (`variableName`) rather than
 * re-deriving it, so it cannot drift from what a push actually sends.
 */

import type { ParameterRef, PenvConfig } from "@penv/core";
import { parameterId, variableName } from "@penv/core";
import { GithubNameError } from "./errors.js";

/** GitHub reserves this prefix for its own secrets. */
const RESERVED_PREFIX = "GITHUB_";
/** A secret name may not begin with a digit. */
const LEADING_DIGIT = /^[0-9]/;
/** A secret name is letters, digits, and underscores only. */
const LEGAL_NAME = /^[A-Za-z0-9_]+$/;

function reservedPrefix(variable: string, parameter: string): GithubNameError {
  return new GithubNameError(
    "reserved-prefix",
    variable,
    [parameter],
    `The parameter \`${parameter}\` generates the variable \`${variable}\`, which GitHub reserves — a secret name may not begin with \`${RESERVED_PREFIX}\``,
    "GitHub keeps the `GITHUB_` prefix for its own secrets. Rename the parameter, or map it to an " +
      "allowed name in the `names` block of penv.config.ts.",
  );
}

function leadingDigit(variable: string, parameter: string): GithubNameError {
  return new GithubNameError(
    "leading-digit",
    variable,
    [parameter],
    `The parameter \`${parameter}\` generates the variable \`${variable}\`, which GitHub rejects — a secret name may not begin with a digit`,
    "Rename the parameter, or map it to a name that starts with a letter or `_` in the `names` " +
      "block of penv.config.ts.",
  );
}

function charset(variable: string, parameter: string): GithubNameError {
  return new GithubNameError(
    "charset",
    variable,
    [parameter],
    `The parameter \`${parameter}\` generates the variable \`${variable}\`, which GitHub rejects — a secret name may contain only letters, digits, and \`_\``,
    "Rename the parameter, or map it to a name matching `[A-Za-z0-9_]` in the `names` block of " +
      "penv.config.ts.",
  );
}

function caseCollision(upper: string, parameters: readonly string[]): GithubNameError {
  return new GithubNameError(
    "case-collision",
    upper,
    parameters,
    `Parameters ${parameters.map((p) => `\`${p}\``).join(" and ")} generate variables that differ only in case, and GitHub secret names are case-insensitive — they would overwrite one another`,
    "Give one of them a distinct name — not just a different case — in the `names` block of " +
      "penv.config.ts.",
  );
}

/**
 * Every generated variable that violates GitHub's grammar, collected rather than
 * thrown so a push reports every bad name at once and refuses before the first
 * PUT. Deterministic: per-name violations in variable order, then case
 * collisions in uppercased-key order, each parameter list sorted.
 *
 * Exact-string collisions (two parameters producing the identical variable) are
 * core's `checkNameCollisions`, run before this. Here the concern is GitHub's
 * *case-insensitivity*, which core's exact-string map cannot see.
 */
export function checkGithubNames(
  refs: readonly ParameterRef[],
  config: PenvConfig,
): GithubNameError[] {
  const named = refs.map((ref) => ({
    variable: variableName(ref, config),
    parameter: parameterId(ref),
  }));

  const errors: GithubNameError[] = [];

  const perName = [...named].sort((a, b) =>
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
  for (const { variable, parameter } of perName) {
    // Case-insensitively, because GitHub reserves the prefix case-insensitively:
    // a `names` override of `github_token` reaches GitHub verbatim and is refused
    // there, so it must be refused here — the same case-folding the collision
    // check below already applies.
    if (variable.toUpperCase().startsWith(RESERVED_PREFIX)) {
      errors.push(reservedPrefix(variable, parameter));
    } else if (LEADING_DIGIT.test(variable)) {
      errors.push(leadingDigit(variable, parameter));
    } else if (!LEGAL_NAME.test(variable)) {
      errors.push(charset(variable, parameter));
    }
  }

  const byUpper = new Map<string, string[]>();
  for (const { variable, parameter } of named) {
    const key = variable.toUpperCase();
    const list = byUpper.get(key);
    if (list === undefined) {
      byUpper.set(key, [parameter]);
    } else {
      list.push(parameter);
    }
  }
  for (const key of [...byUpper.keys()].sort()) {
    const parameters = byUpper.get(key);
    if (parameters === undefined || parameters.length < 2) {
      continue;
    }
    errors.push(caseCollision(key, [...parameters].sort()));
  }

  return errors;
}
