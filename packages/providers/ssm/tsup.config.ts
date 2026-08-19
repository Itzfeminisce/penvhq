import { defineConfig } from "tsup";

/**
 * Published self-contained.
 *
 * `penv add` unpacks this one tarball into `$PENV_HOME/extensions/` and installs
 * nothing else — there is no `node_modules` beside it and never will be — so
 * `@penvhq/core` and the zod it reaches for are bundled in rather than declared
 * as dependencies a resolver would have to satisfy. The engine's jiti caveat
 * does not apply: no provider evaluates a TypeScript config.
 *
 * A project that installs this package normally is unaffected; bundling is about
 * the store, which is the one place with no resolver at all.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // `noExternal` governs the JS bundle only, so the declaration bundler needs
  // telling separately — otherwise index.d.ts re-exports from `@penvhq/core`,
  // which is no longer a dependency of this package.
  dts: { resolve: [/^@penvhq\//] },
  clean: true,
  sourcemap: true,
  target: "node20",
  // core resolves jiti lazily through `createRequire(import.meta.url)`; the CJS
  // output needs a base path for it even though no provider ever gets there.
  shims: true,
  noExternal: [/^@penvhq\//, "zod"],
});
