/**
 * The shared, provider-agnostic contract suite and its in-memory fixture.
 *
 * This package is test-only: `contract.ts` imports vitest at module scope, so no
 * runtime bundle may depend on it. A provider imports {@link runProviderContractSuite}
 * from here in its `*.test.ts` files — never from its own package entry — and the
 * v0.6 SSM and Kubernetes adapters will reuse it unchanged, which is why it lives
 * here rather than beside any one provider.
 */

export { runProviderContractSuite } from "./contract.js";
export { createInMemoryProvider, InMemoryProvider } from "./memory.js";
