/**
 * The injection seams — where `penv init` places `import "@env"` so it runs
 * before any app code, per framework.
 *
 * When a project opts into injection (`load(schema, { inject: true })`), the SDK
 * that reads `process.env` directly only finds the values if the injection ran
 * first. Every framework ships a hook it *guarantees* runs before app code; this
 * module knows, per framework, which hook that is and exactly what belongs in it.
 * The specifics here were verified against each framework's current documentation
 * — the ordering guarantee, the filename rules, the runtime guards — not written
 * from memory, because a seam that runs a beat too late is a seam that does
 * nothing.
 *
 * Three shapes of seam:
 *
 * - **scaffold** — the framework has a clean pre-app file penv can write. penv
 *   creates it *only when it does not already exist*; an existing hook is the
 *   user's, so penv prints where to add the line instead of editing it in place.
 * - **instruct** — no file penv can safely own (plain Node has no framework hook;
 *   TanStack's entry is version-shaped; Astro has no universal hook). penv prints
 *   the exact, verified line and where it goes.
 * - **none** — no server runtime reads `process.env` at all (a pure client SPA),
 *   so injection does not apply and penv says so.
 *
 * The import specifier is the project's own alias — `@env` where a bundler
 * resolves it (Next, SvelteKit, Nuxt, Bun-with-tsconfig), `#env` where Node
 * resolves it natively (plain Node). That choice is the project's, made at init;
 * the seam only carries it through.
 */

/** What init knows when it builds a seam: the project's alias, layout, and schema module. */
export interface SeamContext {
  /** The import specifier the project resolves the schema module by — `@env` or `#env`. */
  readonly alias: string;
  /** `"src/"` when the project keeps modules under `src/`, else `""`. */
  readonly srcDir: string;
  /** The schema module path, relative to the project root, POSIX — e.g. `.penv/env.ts` or `src/env.ts`. */
  readonly schemaFile: string;
}

/** A seam penv can write to a file, created only when the file is absent. */
export interface ScaffoldSeam {
  readonly kind: "scaffold";
  /** The file to create, relative to the project root, POSIX. */
  readonly file: string;
  /** Exactly what penv writes into a fresh file — the framework-explaining comment and the import. */
  readonly content: string;
  /**
   * What penv prints when the file already exists (penv will not edit a hook the
   * user owns) — where to add the line, verbatim.
   */
  readonly ifPresent: string;
  /** Extra one-line notes penv surfaces after scaffolding — an alias-wiring caveat, say. */
  readonly notes: readonly string[];
}

/** A seam penv cannot own; it prints the exact instruction instead. */
export interface InstructSeam {
  readonly kind: "instruct";
  readonly instruction: string;
}

/** No server runtime reads `process.env`; injection does not apply. */
export interface NoSeam {
  readonly kind: "none";
  readonly reason: string;
}

export type Seam = ScaffoldSeam | InstructSeam | NoSeam;

/** Builds a framework's seam for one project's alias and layout. */
export type SeamFor = (context: SeamContext) => Seam;

function nextjs({ alias, srcDir }: SeamContext): Seam {
  return {
    kind: "scaffold",
    file: `${srcDir}instrumentation.ts`,
    content:
      "// This is instrumentation.ts, Next.js's own startup hook — Next runs it once,\n" +
      "// before any of your app code, on every server boot. penv put one line here so\n" +
      "// your config is in process.env before the first library reads it. The filename\n" +
      "// is Next's requirement (it only finds `instrumentation.ts`), so keep it as-is.\n" +
      "export async function register() {\n" +
      "  // Next also calls register on the Edge runtime, where penv cannot read the\n" +
      "  // filesystem — so inject runs on the Node runtime only.\n" +
      '  if (process.env.NEXT_RUNTIME === "nodejs") {\n' +
      `    await import("${alias}");\n` +
      "  }\n" +
      "}\n",
    ifPresent:
      `Add to your existing \`${srcDir}instrumentation.ts\`, inside \`register()\` and first:\n` +
      `  if (process.env.NEXT_RUNTIME === "nodejs") { await import("${alias}"); }`,
    notes: [],
  };
}

function sveltekit({ alias }: SeamContext): Seam {
  return {
    kind: "scaffold",
    // SvelteKit's hooks module is always under `src/`, whatever the schema path.
    file: "src/hooks.server.ts",
    content:
      "// This is hooks.server.ts, SvelteKit's server-startup module — it loads before\n" +
      "// your routes handle a request. penv put this import first so your config is in\n" +
      "// process.env before any library reads it. Keep it the first line; the name and\n" +
      "// location are SvelteKit's, not penv's.\n" +
      `import "${alias}";\n`,
    ifPresent: `Add \`import "${alias}";\` as the FIRST line of src/hooks.server.ts, above every other import.`,
    notes: [
      `SvelteKit resolves app aliases through \`kit.alias\` — make sure \`${alias}\` is registered in svelte.config.js, not only tsconfig.`,
    ],
  };
}

function nuxt({ alias }: SeamContext): Seam {
  return {
    kind: "scaffold",
    // The `0.` prefix is load-bearing: Nitro sorts plugin filenames as strings,
    // so it must sort first to run before any other plugin reads process.env.
    file: "server/plugins/0.penv.ts",
    content:
      "// This is a Nitro server plugin (Nuxt's server layer runs it once at startup,\n" +
      "// before any middleware or request handler). penv put the import here so your\n" +
      "// config is in process.env before a library reads it. The `0.` prefix keeps this\n" +
      "// plugin first — Nitro sorts plugin filenames as text — so don't rename it.\n" +
      `import "${alias}";\n` +
      "\n" +
      "// Nitro requires every plugin file to default-export a function; the injection\n" +
      "// above already ran at import, so this body is intentionally empty.\n" +
      "export default defineNitroPlugin(() => {});\n",
    ifPresent: `Create server/plugins/0.penv.ts with \`import "${alias}";\` and \`export default defineNitroPlugin(() => {});\`.`,
    notes: [
      `Wire \`${alias}\` for the Nitro (server) build so it never leaks into the client bundle.`,
    ],
  };
}

function bun({ alias }: SeamContext): Seam {
  return {
    kind: "scaffold",
    file: ".penv/preload.ts",
    content:
      "// Bun evaluates this file before your entry point, because it is listed under\n" +
      "// `preload` in bunfig.toml (see the note penv printed). Running it injects your\n" +
      "// config into process.env before any library reads it.\n" +
      `import "${alias}";\n`,
    ifPresent: `Keep .penv/preload.ts as \`import "${alias}";\`.`,
    notes: [
      'Register it in bunfig.toml so Bun runs it: `preload = ["./.penv/preload.ts"]` (and the same under `[test]`).',
      `\`${alias}\` must be a tsconfig \`paths\` alias for Bun to resolve it.`,
    ],
  };
}

function node({ alias, schemaFile }: SeamContext): Seam {
  // Plain Node owns no pre-app file, and `@env` (a tsconfig alias) does not
  // resolve at raw-Node runtime — so steer to `#env` (a package.json imports
  // alias Node resolves itself), or the built schema module by path when the
  // project is on `@env`. The path is the schema module's own location (`.penv/`
  // is at the repo root, never under `src/`), with `.ts` swapped for the emitted
  // `.js`.
  const builtSchema = `./${schemaFile.replace(/\.ts$/, ".js")}`;
  const runtimeSpecifier = alias.startsWith("#") ? alias : builtSchema;
  return {
    kind: "instruct",
    instruction:
      "Plain Node / Express / Fastify have no framework hook that runs before your\n" +
      "code, so place the injection yourself, one of two ways (both run first):\n" +
      `  • Preload at launch — add to your start script:  node --import "${runtimeSpecifier}" your-entry.js\n` +
      `  • Or make it the FIRST line of your entry file:   import "${runtimeSpecifier}";\n` +
      (alias.startsWith("#")
        ? ""
        : `Note: \`${alias}\` is a tsconfig alias that Node does not resolve at runtime — the paths above point at the built schema module instead.\n`),
  };
}

function tanstack({ alias, srcDir }: SeamContext): Seam {
  // TanStack Start's server entry carries version-shaped boilerplate, so penv
  // prints the line rather than scaffold boilerplate that could drift.
  return {
    kind: "instruct",
    instruction:
      `Add \`import "${alias}";\` as the FIRST line of ${srcDir}server.ts (TanStack Start's\n` +
      "server entry), above the `@tanstack/react-start/server-entry` import — nothing may\n" +
      "import before it. If you have no server.ts yet, create it from TanStack's server-entry\n" +
      "template and put that import first.",
  };
}

function astro({ alias }: SeamContext): Seam {
  return {
    kind: "instruct",
    instruction:
      "Astro has no single pre-app hook. Add a small integration to astro.config that\n" +
      "injects the import into every SSR page, then cover the routes it cannot reach:\n" +
      "  • In astro.config integrations, add:\n" +
      '      { name: "penv", hooks: { "astro:config:setup": ({ injectScript }) =>\n' +
      `          injectScript("page-ssr", 'import "${alias}";') } }\n` +
      `  • Also add \`import "${alias}";\` as the first line of src/middleware.ts and of any\n` +
      "    endpoint route (src/pages/*.ts) that imports a library reading process.env.\n" +
      "Injection only applies under a server (on-demand) adapter, not a static build.",
  };
}

function viteSpa(_context: SeamContext): Seam {
  return {
    kind: "none",
    reason:
      "This is a client-only app — nothing reads process.env at runtime, so injection " +
      "does not apply. Read client config through import.meta.env (only VITE_-prefixed " +
      "vars, which ship to the browser and must not hold secrets). If you add a server " +
      "later, place the injection there.",
  };
}

/**
 * The seam for a framework, keyed by the name {@link import("./detect.js").Detected}
 * carries. A framework penv recognises but has no seam entry for falls back to the
 * plain-Node instruction, which works for any runtime.
 */
const SEAMS: Readonly<Record<string, SeamFor>> = {
  "Next.js": nextjs,
  SvelteKit: sveltekit,
  Nuxt: nuxt,
  Bun: bun,
  "TanStack Start": tanstack,
  Astro: astro,
  Vite: viteSpa,
};

/**
 * The seam for a detected framework, or the universal plain-Node instruction when
 * penv has no framework-specific one — that instruction runs before app code on
 * any runtime, so it is a correct fallback rather than a guess.
 */
export function seamFor(framework: string | undefined, context: SeamContext): Seam {
  const build = framework === undefined ? node : (SEAMS[framework] ?? node);
  return build(context);
}
