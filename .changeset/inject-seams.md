---
"@penvhq/cli": minor
"@penvhq/penv": minor
---

`penv init` sets up process.env injection for your framework (v0.8, part two).

When you opt in — `init` asks, default No — penv writes `load(schema, { inject: true })` and places the one line that runs it before your app code, in the file your framework guarantees runs first:

- **Next.js** → `instrumentation.ts` with a guarded `register()` (the `NEXT_RUNTIME === "nodejs"` guard is mandatory — Next calls `register` on Edge, where penv can't read the filesystem)
- **SvelteKit** → `src/hooks.server.ts` (with a note to register the alias in `kit.alias`)
- **Nuxt/Nitro** → `server/plugins/0.penv.ts` (the `0.` prefix keeps it first)
- **Bun** → `.penv/preload.ts` (with the `bunfig.toml` registration as a note)
- **TanStack Start, Astro, plain Node/Express/Fastify** → the exact verified instruction is printed (no file penv can safely own)
- **Vite SPA** → nothing: no server reads process.env, and init says so

penv scaffolds a fresh seam file but never edits a hook you already own — an existing file becomes a printed instruction instead. Each framework's hook was verified against its current documentation. Injection stays off by default: no opt-in, no seam, no change.

`detect` now also recognizes SvelteKit, Nuxt, and Bun.
