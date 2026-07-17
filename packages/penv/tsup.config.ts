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
 *
 * `readline/promises` is a node builtin and is named anyway, because the upstream
 * build strips the `node:` prefix from every builtin it emits and esbuild's
 * builtin list does not carry the subpath ones — so the bare specifier arrives
 * here looking like a package nobody installed, and the bundle fails to build.
 * The tests do not catch it: vitest resolves the source, where the prefix is
 * still there. Any other builtin subpath — `fs/promises`, `stream/promises` —
 * will need the same line.
 *
 * `@napi-rs/keyring` is external and a real dependency of this package: it is a
 * native binding with per-platform binaries that cannot be bundled, and the CLI
 * `require`s it lazily at runtime, so it must resolve from this package's own
 * `node_modules`. It ships only with `npx penv`, never with `import { load }`.
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
  // `@penvhq/runtime` — a package the consumer never installs — so the JS works
  // and the types dangle.
  dts: { resolve: [/^@penvhq\//] },
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["zod", "jiti", "@napi-rs/keyring", "readline/promises", "node:readline/promises"],
  noExternal: [/^@penvhq\//],
});
