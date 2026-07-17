import { defineConfig } from "vitest/config";

/**
 * The artifact suite packs and installs the real tarball, so it deliberately does
 * NOT alias `@penvhq/*` to source the way the default config does — aliasing would
 * defeat the entire point of the test.
 */
export default defineConfig({
  test: {
    include: ["packages/**/*.smoke.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // npm install and tsc are heavy; running these in parallel thrashes.
    fileParallelism: false,
  },
});
