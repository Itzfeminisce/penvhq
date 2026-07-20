---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

The `names` config block is renamed to `override`, with schema-typed keys (breaking).

- `names` becomes `override` — the block overrides the generated variable for a parameter, and the honest name says so. One override bends the name for every consumer at once: `penv generate`, `penv push`, and (at v0.8) the ambient `process.env` mirror. A config still carrying `names` is refused with `CONFIG_NAMES_RENAMED` naming the one-line rewrite; the entries are unchanged.
- **Typed keys.** The scaffolded `.penv/env.ts` now registers the schema's inferred shape on core's `PenvSchemaShape` (a type-only `declare module`, erased at runtime), and `override`'s keys narrow to the parameter ids the schema declares — camelCase kebab-cased, mirroring the runtime transform. A typo'd id (`workos/redirect-url` for `redirect-uri`) is a compile error instead of an override that silently never applies. A project that doesn't register a shape keeps plain `string` keys, and the exported `OverrideKeysOf<T>` transform lets one opt in by hand.

Migration: rename the `names` block to `override` in `penv.config.ts` — entries unchanged — and re-run `penv init` (or add the `declare module` block by hand) to get typed keys. `penv validate` names the rewrite.
