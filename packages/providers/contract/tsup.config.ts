import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // The suite imports vitest at module scope; it is the consuming test runner's,
  // never bundled. This package is test-only and enters no runtime bundle.
  external: ["vitest"],
});
