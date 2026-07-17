/**
 * The sink's own errors, extending penv's base so they print with a remedy and
 * carry a stable code, exactly as core's do. They live here rather than in core
 * because they encode GitHub's grammar and GitHub's plumbing — the reserved
 * `GITHUB_` prefix, the `gh` CLI — which are someone else's product, not penv's.
 * Core stays destination-agnostic; the destination's rules live with the sink.
 */

import { PenvError } from "@penvhq/core";

/** Which of GitHub's name rules a generated variable breaks. */
export type GithubNameReason = "reserved-prefix" | "leading-digit" | "charset" | "case-collision";

/**
 * A generated variable the destination will not accept. Mirrors core's
 * `NameCollisionError`: the offending variable and the parameters that produce
 * it are public fields, the message names them, and the remedy points at the
 * `names` block — the one place any of these can be repaired.
 */
export class GithubNameError extends PenvError {
  override readonly name = "GithubNameError";
  readonly reason: GithubNameReason;
  readonly variable: string;
  /** The dotted parameter ids generating this variable — two for a case collision, one otherwise. */
  readonly parameters: readonly string[];

  constructor(
    reason: GithubNameReason,
    variable: string,
    parameters: readonly string[],
    message: string,
    remedy: string,
  ) {
    super("GITHUB_NAME", message, remedy);
    this.reason = reason;
    this.variable = variable;
    this.parameters = parameters;
  }
}

/** Why penv cannot reach GitHub. Never fallen back from — see the RFC's sink decision. */
export type GithubUnavailableReason = "not-installed" | "not-authenticated" | "command-failed";

/**
 * The destination could not be reached or refused an operation. penv holds no
 * GitHub credential of its own and never falls back to a weaker path, so it names
 * which of "not installed", "not authenticated", or "the command failed" is true
 * and stops.
 */
export class GithubUnavailableError extends PenvError {
  override readonly name = "GithubUnavailableError";
  readonly reason: GithubUnavailableReason;

  constructor(reason: GithubUnavailableReason, message: string, remedy: string) {
    super("GITHUB_UNAVAILABLE", message, remedy);
    this.reason = reason;
  }
}
