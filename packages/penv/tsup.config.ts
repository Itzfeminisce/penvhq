import { defineConfig } from "tsup";

/**
 * `penv` is the one package users install, and it carries two surfaces with very
 * different weight budgets: `import { load } from "penv"` ships into the app, and
 * `npx penv` does not.
 *
 * The workspace packages are bundled in rather than declared as dependencies, so
 * the CLI's weight lands in this tarball and never in a consuming app's
 * dependency graph. `zod` stays external — it is the user's own peer.
 *
 * `jiti` stays external because it is CommonJS: bundling it into the ESM output
 * leaves esbuild's `__require` shim to service its `require("os")`, and that shim
 * throws. Node resolves it as CJS natively when it is a real dependency.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    config: "src/config.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  // `noExternal` governs the JS bundle only, so the declaration bundler needs
  // telling separately. Without `resolve`, index.d.ts re-exports from
  // `@penv/runtime` — a package the consumer never installs — so the JS works
  // and the types dangle.
  dts: { resolve: [/^@penv\//] },
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["zod", "jiti"],
  noExternal: [/^@penv\//],
});
