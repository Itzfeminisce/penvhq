/**
 * The mock provider — a registered, retaining provider for rehearsing a
 * `dual-valid` rotation locally.
 *
 * The filesystem cannot stand in for this rehearsal because it keeps no history:
 * it overwrites a value in place and has no previous version to hand back. The
 * mock retains an ordered list of versions per address, so it satisfies
 * {@link RetainingProvider} and lets a rotation's grace window be exercised
 * end-to-end without a live backend.
 *
 * The contract suite lives in `@penvhq/provider-contract` and is imported only
 * from this package's test files, never re-exported here — it pulls in vitest at
 * module scope, which no consumer's runtime should carry.
 */

export type { MockProviderOptions } from "./mock.js";
export { createMockProvider, MockProvider } from "./mock.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    /**
     * The rehearsal store: a JSON file beside the tree. It places itself, so it
     * takes no `location`.
     */
    // biome-ignore lint/complexity/noBannedTypes: no fields is the declaration.
    "@penvhq/provider-mock": {};
  }
}
