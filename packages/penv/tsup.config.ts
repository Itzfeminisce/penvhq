import { defineConfig } from "tsup";

/**
 * `@penvhq/penv` is the one runtime dependency an adopted project takes (PRD §3):
 * the typed `@env` surface and the validation helpers, and nothing else. The
 * command line is the launcher's `penv` and the engine behind it, so nothing
 * here is a CLI distribution.
 *
 * The workspace packages are bundled in rather than declared as dependencies, so
 * a consumer resolves one tarball rather than a graph of `workspace:*`. `zod`
 * stays external — it is the user's own peer.
 *
 * `jiti` stays external because it is CommonJS: bundling it into the ESM output
 * leaves esbuild's `__require` shim to service its `require("os")`, and that shim
 * throws. Node resolves it as CJS natively when it is a real dependency.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    config: "src/config.ts",
  },
  format: ["esm", "cjs"],
  // `noExternal` governs the JS bundle only, so the declaration bundler needs
  // telling separately. Without `resolve`, index.d.ts re-exports from
  // `@penvhq/runtime` — a package the consumer never installs — so the JS works
  // and the types dangle.
  dts: { resolve: [/^@penvhq\//] },
  clean: true,
  sourcemap: true,
  target: "node20",
  // `import.meta.url` in the CJS output: the config loader resolves jiti lazily
  // through `createRequire`, and both builds need a base path for it.
  shims: true,
  external: ["zod", "jiti"],
  noExternal: [/^@penvhq\//],
});
