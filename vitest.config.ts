import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

const module = (path: string) => fileURLToPath(new URL(`./packages/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, not dist, so `pnpm test` needs no prior build.
    alias: {
      "@penvhq/core": src("core"),
      "@penvhq/runtime": src("runtime"),
      "@penvhq/provider-filesystem": src("providers/filesystem"),
      "@penvhq/provider-mock": src("providers/mock"),
      "@penvhq/provider-vault": src("providers/vault"),
      "@penvhq/provider-contract": src("providers/contract"),
      "@penvhq/provider-github": src("providers/github"),
      "@penvhq/provider-vercel": src("providers/vercel"),
      // Subpaths lead: an alias key also matches everything under it, so
      // `@penvhq/cli` would swallow `@penvhq/cli/install` from above it.
      "@penvhq/cli/install": module("cli/src/install.ts"),
      "@penvhq/cli": src("cli"),
      penv: src("launcher"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    /**
     * The assertions here are timing-free, but a good many tests evaluate a
     * user's `penv.config.ts` or schema through jiti — a real transpile — and
     * some start real child processes. Under a full parallel run those measure
     * the machine rather than the code, and the 5s default failed a different
     * innocent test on each run. This is the knob for that, not a licence for a
     * test that waits on a clock.
     */
    testTimeout: 20_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**", "**/*.smoke.test.ts"],
    typecheck: {
      enabled: true,
      include: ["packages/**/*.test-d.ts"],
      tsconfig: "./tsconfig.test.json",
    },
  },
});
