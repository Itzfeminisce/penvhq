import { defineConfig } from "tsup";

/**
 * The engine is a dependency, not a bundled module: the launcher spawns it as a
 * child process, so it has to arrive as a real package with its own `bin`.
 */
export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["zod", "@penvhq/core", "@penvhq/cli"],
});
