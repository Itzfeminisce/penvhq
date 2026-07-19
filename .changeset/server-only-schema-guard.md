---
"@penvhq/core": patch
"@penvhq/cli": patch
---

A schema guarded with `import "server-only"` no longer stops the CLI from reading it.

Next.js apps guard `.penv/env.ts` with `server-only` so the loaded config can never
reach a client bundle — but that package's default export throws outside a React
Server bundle, so `penv validate` / `penv fill` / `penv doctor` (which evaluate the
schema module in plain Node) failed with "This module cannot be imported from a
Client Component module" before ever seeing the `schema` export.

penv's module loader now resolves `server-only` the way a React Server environment
would: it probes the user's own installed `server-only` under the `react-server`
resolution condition — the package's empty, no-throw variant — and pins the import
there. Projects that don't depend on `server-only` resolve exactly as before, and
the config loader (`penv.config.ts`) and the schema loader now share one loading
path so both evaluate user modules identically.
