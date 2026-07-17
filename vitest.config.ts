import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not dist, so `pnpm test` needs no prior build.
    alias: {
      "@penv/core": src("core"),
      "@penv/runtime": src("runtime"),
      "@penv/provider-filesystem": src("providers/filesystem"),
      "@penv/provider-contract": src("providers/contract"),
      "@penv/sink-github": src("sinks/github"),
      "@penv/cli": src("cli"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**", "**/*.smoke.test.ts"],
    typecheck: {
      enabled: true,
      include: ["packages/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});
