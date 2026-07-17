import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not dist, so `pnpm test` needs no prior build.
    alias: {
      "@penvhq/core": src("core"),
      "@penvhq/runtime": src("runtime"),
      "@penvhq/provider-filesystem": src("providers/filesystem"),
      "@penvhq/provider-contract": src("providers/contract"),
      "@penvhq/sink-github": src("sinks/github"),
      "@penvhq/cli": src("cli"),
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
