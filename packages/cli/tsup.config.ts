import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // @napi-rs/keyring is a native binding with per-platform binaries — it must be
  // required at runtime, never bundled.
  external: ["zod", "@napi-rs/keyring"],
});
