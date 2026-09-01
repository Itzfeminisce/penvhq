/**
 * The provider's own errors, extending penv's base so they print with a remedy and
 * carry a stable code, exactly as core's do. They live here rather than in core
 * because they encode Vercel's grammar and Vercel's plumbing — the three targets,
 * the access token, the project id — which are someone else's product, not penv's.
 * Core stays destination-agnostic; the destination's rules live with the provider.
 */

import { PenvError } from "@penvhq/core";

/** Which of Vercel's key rules a generated variable breaks. */
export type VercelNameReason = "charset" | "length";

/**
 * A generated variable Vercel will not accept. Mirrors core's `NameCollisionError`
 * and the GitHub provider's: the offending variable and the parameter that
 * produces it are public fields, and the remedy points at the `override` block —
 * the one place either of these can be repaired.
 */
export class VercelNameError extends PenvError {
  override readonly name = "VercelNameError";
  readonly reason: VercelNameReason;
  readonly variable: string;
  /** The dotted parameter id generating this variable. */
  readonly parameters: readonly string[];

  constructor(
    reason: VercelNameReason,
    variable: string,
    parameters: readonly string[],
    message: string,
    remedy: string,
  ) {
    super("VERCEL_NAME", message, remedy);
    this.reason = reason;
    this.variable = variable;
    this.parameters = parameters;
  }
}

/** Why penv will not write to a Vercel target. */
export type VercelTargetReason = "unmapped" | "invalid" | "conflict";

/**
 * The environment could not be placed on a Vercel target. Which target an
 * environment deploys to is `environments.<env>.target`, defaulting to the
 * environment's own name and never inferred past that: penv guessing between
 * production, preview, and development is penv choosing which deployment reads a
 * secret.
 */
export class VercelTargetError extends PenvError {
  override readonly name = "VercelTargetError";
  readonly reason: VercelTargetReason;
  readonly environment: string | undefined;

  constructor(reason: VercelTargetReason, message: string, remedy: string, environment?: string) {
    super("VERCEL_TARGET", message, remedy);
    this.reason = reason;
    this.environment = environment;
  }
}

/** Why penv could not use the Vercel project. Never fallen back from — see the RFC's provider decision. */
export type VercelUnavailableReason =
  | "no-token"
  | "not-authenticated"
  | "forbidden"
  | "project-not-found"
  | "rate-limited"
  | "request-failed";

/**
 * The project could not be reached or refused an operation. penv never falls back
 * to a weaker path, so it names which of "no token", "the token was refused",
 * "the project is not there", "rate-limited", or "the request failed" is true and
 * stops.
 */
export class VercelUnavailableError extends PenvError {
  override readonly name = "VercelUnavailableError";
  readonly reason: VercelUnavailableReason;
  /** Seconds to wait, when Vercel said how long. Only ever set for `rate-limited`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    reason: VercelUnavailableReason,
    message: string,
    remedy: string,
    retryAfterSeconds?: number,
  ) {
    super("VERCEL_UNAVAILABLE", message, remedy);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
