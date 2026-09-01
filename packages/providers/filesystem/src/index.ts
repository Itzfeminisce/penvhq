/**
 * The filesystem provider — the reference implementation of the `@penvhq/core`
 * provider contract.
 *
 * The contract suite lives in `./contract.js` and is deliberately not re-exported
 * here: it imports vitest at module scope, so pulling it into the package entry
 * would drag a test runner into every consumer's runtime. Providers import it
 * directly from their test files.
 */

export type { FilesystemProviderOptions } from "./filesystem.js";
export { createFilesystemProvider, FilesystemProvider } from "./filesystem.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    /**
     * The local records tree. It is rooted at the project, so it declares no
     * fields at all — which is what makes the bare package-specifier shorthand
     * legal for it: `development: "@penvhq/provider-filesystem"`.
     */
    // biome-ignore lint/complexity/noBannedTypes: no fields is the declaration.
    "@penvhq/provider-filesystem": {};
  }
}
