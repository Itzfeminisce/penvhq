/**
 * The adapter's own errors, extending penv's base so they print with a remedy and
 * carry a stable code exactly as core's do. They live here rather than in core
 * because they encode Vault's grammar and Vault's plumbing — the KV version of a
 * mount, the `vault` CLI — which are someone else's product, not penv's. Core
 * stays provider-agnostic; the backend's rules live with the adapter, the way the
 * GitHub sink keeps its own `gh` errors beside it.
 */

import { PenvError } from "@penvhq/core";

/** Why penv could not use the Vault mount. Never fallen back from — see the RFC's provider decision. */
export type VaultUnavailableReason = "not-installed" | "not-authenticated" | "command-failed";

/**
 * The mount could not be reached or refused an operation. penv holds no Vault
 * credential of its own — `VAULT_ADDR`/`VAULT_TOKEN` are the CLI's to keep — and
 * never falls back to a weaker path, so it names which of "not installed", "not
 * authenticated", or "the command failed" is true and stops.
 */
export class VaultUnavailableError extends PenvError {
  override readonly name = "VaultUnavailableError";
  readonly reason: VaultUnavailableReason;

  constructor(reason: VaultUnavailableReason, message: string, remedy: string) {
    super("VAULT_UNAVAILABLE", message, remedy);
    this.reason = reason;
  }
}

/**
 * A mount whose KV engine is not version 2. KV v1 overwrites with no history —
 * "any update will overwrite the original value and not recoverable" — so a v1
 * mount is an adapter that silently cannot rotate. Refused at first use rather
 * than mid-rotation, on the same rule the encryption check follows: a capability
 * penv cannot honour is a loud refusal up front, never a quiet degradation.
 */
export class VaultKvVersionError extends PenvError {
  override readonly name = "VaultKvVersionError";
  readonly mount: string;
  readonly version: number;

  constructor(mount: string, version: number) {
    super(
      "VAULT_KV_VERSION",
      `The Vault mount \`${mount}\` is KV version ${version}, not 2`,
      "penv requires a KV v2 mount because v1 keeps no version history, so a rotation could never " +
        "read the value it is replacing. Enable versioning on this mount (`vault kv enable-versioning " +
        `${mount}\`) or point \`providers.*.mount\` at a v2 mount.`,
    );
    this.mount = mount;
    this.version = version;
  }
}
