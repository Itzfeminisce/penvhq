---
"@penv/provider-filesystem": minor
"@penv/runtime": minor
"@penv/core": minor
"@penv/cli": minor
"penv": minor
---

Filesystem core, schema and types — roadmap v0.1 and v0.2.

v0.1 retires the risk that the many-files storage model is unworkable day to day: the
filesystem provider, the filename grammar with reserved-token validation (`.enc` reserved
from day one, though encrypt/decrypt lands at v0.3), the value cascade
(`<name>.local` > `<name>.<env>` > `<name>`, flat override, `.local` skipped in `test`,
loud fallback surfacing), `init`/`import`/`generate`/`get`/`set`/`remove`/`list`, the
runtime loader with its `process.env` compatibility path, and `.gitignore` automation.

v0.2 retires the risk that "type-safe" and "validated" are claims penv cannot back:
`.penv/env.ts` scaffolding with the `@env` alias, the generic
`load<T extends z.ZodType>(schema: T): z.infer<T>`, `penv validate`, `.json` meta with
shallow base→env merge, the deterministic name transform with collision detection, and
draft schema generation on import.
