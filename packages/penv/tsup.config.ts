import { defineConfig } from "tsup";

/**
 * `penv` is the one package users install, and it carries two surfaces with very
 * different weight budgets: `import { load } from "penv"` ships into the app, and
 * `npx penv` does not.
 *
 * The workspace packages are bundled in rather than declared as dependencies, so
 * the CLI's weight lands in this tarball and never in a consuming app's
 * dependency graph. `zod` stays external — it is the user's own peer.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    config: "src/config.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["zod"],
  noExternal: [/^@penv\//],
});
