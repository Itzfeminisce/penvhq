import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/config.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  external: ["zod"],
});
