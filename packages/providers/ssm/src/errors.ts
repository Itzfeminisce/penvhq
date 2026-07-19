/**
 * The SSM adapter's own errors, extending penv's base so they print with a remedy
 * and carry a stable code exactly as core's do. They live here rather than in core
 * because they encode AWS's plumbing — the `aws` CLI, an IAM permission, a missing
 * region — which is someone else's product, not penv's. Core stays
 * provider-agnostic; the backend's rules live with the adapter, as the Vault
 * adapter and the GitHub provider keep theirs.
 */

import { PenvError } from "@penvhq/core";

/** Why penv could not use SSM. Never fallen back from — the RFC's provider decision. */
export type SsmUnavailableReason = "not-installed" | "not-authenticated" | "command-failed";

/**
 * SSM could not be reached or refused an operation. penv holds no AWS credential
 * of its own — the `aws` CLI's profile, `AWS_REGION`, and role are its to keep —
 * and never falls back to a weaker path, so it names which of "not installed",
 * "not authenticated", or "the command failed" is true and stops.
 */
export class SsmUnavailableError extends PenvError {
  override readonly name = "SsmUnavailableError";
  readonly reason: SsmUnavailableReason;

  constructor(reason: SsmUnavailableReason, message: string, remedy: string) {
    super("SSM_UNAVAILABLE", message, remedy);
    this.reason = reason;
  }
}
