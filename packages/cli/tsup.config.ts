import { createRequire } from "node:module";
import { defineConfig } from "tsup";

/**
 * Two builds, because the engine has two consumers with opposite needs.
 *
 * `index` is the library: workspace packages and a launcher that installed the
 * engine from npm import it, and its dependencies are theirs to resolve.
 *
 * `install` is its own entry so the launcher can reach the dependency plan
 * without loading the command surface. `penv init` and `penv upgrade` write the
 * same `@penvhq/penv` line, and one of them is the launcher's — a second copy of
 * "which package manager, which diff, which spawn" is the drift penv opposes.
 *
 * `bin` is what the launcher spawns. The launcher extracts an npm tarball into
 * `$PENV_HOME/engines/<name>/<version>/` and runs it there — with no
 * `node_modules` of any kind — so every JavaScript dependency is bundled in.
 * It is CommonJS on purpose: jiti and its babel transform are CJS, and bundling
 * CJS into ESM leaves esbuild's `__require` shim to service their
 * `require("node:os")`, which throws. CJS inside CJS is Node's own `require`.
 *
 * `@napi-rs/keyring` is the one exception: a native binding has per-platform
 * binaries and cannot be bundled at all. The tarball engine therefore starts,
 * inits, pulls and runs without it, and only a keychain key source refuses —
 * see `src/keychain.ts`.
 */

const shared = {
  clean: false,
  sourcemap: true,
  target: "node20",
} as const;

/**
 * jiti published two builds, and only one of them can be bundled: `lib/jiti.mjs`
 * loads its babel transform through `createRequire(import.meta.url)`, a path no
 * bundler can follow, while `lib/jiti.cjs` requires it by literal. Asking Node
 * what `require("jiti")` resolves to picks the second without naming an internal
 * file path, so the answer keeps working when jiti moves one.
 */
const JITI_CJS = createRequire(import.meta.url).resolve("jiti");

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts", install: "src/install.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    external: ["zod", "@napi-rs/keyring"],
  },
  {
    ...shared,
    entry: { bin: "src/bin.ts" },
    format: ["cjs"],
    dts: false,
    // `engineVersion()` reads `../package.json` off `import.meta.url`, which the
    // CJS output only has because of this.
    shims: true,
    external: ["@napi-rs/keyring"],
    noExternal: [/^@penvhq\//, "citty", "jiti", "zod"],
    esbuildOptions(options) {
      options.alias = { ...options.alias, jiti: JITI_CJS };
    },
  },
]);
