/**
 * The Kubernetes adapter's own errors, extending penv's base so they print with a
 * remedy and carry a stable code exactly as core's do. They encode `kubectl`'s
 * plumbing — a missing binary, a context with no access — which is someone else's
 * product, not penv's, so they live with the adapter as Vault's and SSM's do.
 */

import { PenvError } from "@penvhq/core";

/** Why penv could not use the cluster. Never fallen back from — the RFC's provider decision. */
export type KubernetesUnavailableReason = "not-installed" | "not-authenticated" | "command-failed";

/**
 * The cluster could not be reached or refused an operation. penv holds no
 * kubeconfig of its own — the current `kubectl` context and its credentials are
 * its to keep — and never falls back to a weaker path, so it names which of "not
 * installed", "not authenticated", or "the command failed" is true and stops.
 */
export class KubernetesUnavailableError extends PenvError {
  override readonly name = "KubernetesUnavailableError";
  readonly reason: KubernetesUnavailableReason;

  constructor(reason: KubernetesUnavailableReason, message: string, remedy: string) {
    super("KUBERNETES_UNAVAILABLE", message, remedy);
    this.reason = reason;
  }
}
