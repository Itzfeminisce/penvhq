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
