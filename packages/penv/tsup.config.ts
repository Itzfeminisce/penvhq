import { defineConfig } from "tsup";

/**
 * `@penvhq/penv` is the one runtime dependency an adopted project *declares*
 * (PRD §3): the typed `@env` surface and the validation helpers, and nothing
 * else. The command line is the launcher's `penv` and the engine behind it, so
 * nothing here is a CLI distribution.
 *
 * `@penvhq/core` is the one exception to bundling, and it is a type-identity
 * exception. Every provider declaration — the one `penv add` commits into the
 * project — augments `ProviderConfigMap` in module `"@penvhq/core"`, so
 * `defineConfig` has to hold a config against *that* interface and no other. A
 * bundled copy is a second interface with the same name: the augmentation
 * merges into core's, `defineConfig` reads the inlined one, and a misspelled
 * provider field compiles clean. So core stays external in both outputs — the
 * declaration bundler through `resolve`, the JS through `external` — and is a
 * real dependency of this package. A consumer still installs one package; the
 * graph below it is the resolver's business.
 *
 * Every other workspace package is still bundled in: nothing outside this
 * tarball ever names them, so their type identity is not shared with anything.
 *
 * `zod` stays external — it is the user's own peer. `jiti` stays external
 * because it is CommonJS: bundling it into the ESM output leaves esbuild's
 * `__require` shim to service its `require("os")`, and that shim throws. Node
 * resolves it as CJS natively when it is a real dependency.
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
  // and the types dangle. `@penvhq/core` is excluded from both lists together:
  // the import that survives into index.d.ts is what binds the augmentation.
  dts: { resolve: [/^@penvhq\/(?!core$)/] },
  clean: true,
  sourcemap: true,
  target: "node20",
  // `import.meta.url` in the CJS output: the config loader resolves jiti lazily
  // through `createRequire`, and both builds need a base path for it.
  shims: true,
  external: ["zod", "jiti", "@penvhq/core"],
  noExternal: [/^@penvhq\/(?!core$)/],
});
