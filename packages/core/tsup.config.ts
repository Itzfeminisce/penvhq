import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // `import.meta.url` in the CJS output: core resolves jiti lazily through
  // `createRequire`, and both builds need a base path for it.
  shims: true,
  external: ["zod"],
});
