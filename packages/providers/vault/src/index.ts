/**
 * The HashiCorp Vault KV v2 provider — the milestone proof that a provider is
 * portable: an environment flips from `filesystem` to `vault` with zero
 * application edits.
 *
 * The contract suite is not re-exported here: it imports vitest at module scope,
 * so it lives in `@penvhq/provider-contract` and is consumed only from this
 * package's test files. The in-memory KV v2 fake likewise stays in the tests — it
 * is a fixture, not shipped surface.
 */

export type { VaultUnavailableReason } from "./errors.js";
export { VaultKvVersionError, VaultUnavailableError } from "./errors.js";
export { penvProviderFactory } from "./factory.js";
export type { DefaultVaultTransportOptions, VaultRunner } from "./transport.js";
export { defaultVaultRunner, defaultVaultTransport, VaultInvocationError } from "./transport.js";
export type { VaultProviderOptions, VaultTransport } from "./vault.js";
export { createVaultProvider, VaultProvider } from "./vault.js";
