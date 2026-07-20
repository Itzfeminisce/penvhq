---
"@penvhq/runtime": minor
"@penvhq/penv": minor
---

`load(schema, { inject: true })` — the blessed ambient surface (v0.8, part one).

A third-party SDK that reads `process.env.ITS_EXACT_NAME` at module load now finds a validated value with no per-SDK bridge code. Passing `{ inject: true }` to `load` writes the validated environment onto `process.env` after the schema has accepted it, so an SDK never sees a half-configured surface.

- **Exclusive over the schema.** Every parameter the schema declares is penv's to own ambiently: written (under its generated, `override`-bent variable, as the raw string the SDK re-parses) when it has a value — a tree value or a schema `.default()` — and deleted when it has none, so a stray ambient `WORKOS_API_HOSTNAME` cannot steer an SDK behind `@env`'s back.
- **Off by default.** No import, no mirror: a consumer who never asked for `process.env` writes gets none. The schemaless `import "@penvhq/penv/config"` compat entry stays for adoption-before-a-schema.
- New exports from `penv`/`@penvhq/runtime`: `inject`, `declaredRefs`, and the `InjectResult` type.

The per-framework `penv init` seams (scaffolding `import "@env"` into `instrumentation.ts`, a Nitro plugin, `hooks.server.ts`, `node --import`) and `doctor`'s `ambient-shadow` check are the follow-ups.
