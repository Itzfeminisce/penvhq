---
"@penvhq/core": patch
"@penvhq/runtime": patch
"@penvhq/cli": patch
---

`penv fill` now sees the gap it exists to close in a project with no values yet.

The scaffolded `.penv/env.ts` ends in an eager `export const env = load(schema)`.
Evaluated by the CLI against an empty tree, that load threw — and a module that
throws exports nothing, so the `schema` export was unreachable, the drift was
unmeasurable, and `penv fill` answered "Nothing to fill: every declared parameter
has a value" in exactly the state it was built for.

The CLI now pins a schema-harvest flag (alongside the existing `PENV_ENV` pin)
for the one import that reads the schema, and `load()` defers under it: the
module evaluates, the schema is reachable, and `fill` prompts for every
declared-but-missing parameter. The deferred value still performs the real load —
same parameter-named error and all — on first property access, and application
imports of `@env` never see the flag, so runtime loading stays eager and
fail-fast. No change to the scaffolded module shape is needed.
