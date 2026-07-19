# @penvhq/provider-filesystem

## 0.3.2

### Patch Changes

- Updated dependencies [37008df]
  - @penvhq/core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [e20f411]
  - @penvhq/core@0.3.1

## 0.3.0

### Patch Changes

- @penvhq/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [31171e9]
  - @penvhq/core@0.2.0

## 0.1.0

### Minor Changes

- 094bd3a: Filesystem core, schema and types — roadmap v0.1 and v0.2.

  v0.1 retires the risk that the many-files storage model is unworkable day to day: the
  filesystem provider, the filename grammar with reserved-token validation (`.enc` reserved
  from day one, though encrypt/decrypt lands at v0.3), the value cascade
  (`<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`, flat override, both
  `.local` levels skipped in `test`, loud fallback surfacing) — the four levels Next.js and
  Vite use, matched so that an ordinary `.env.development.local` has somewhere to go —
  `init`/`import`/`generate`/`get`/`set`/`remove`/`list`, the runtime loader with its
  `process.env` compatibility path, and `.gitignore` automation.

  `penv import` reads the scope out of the source filename, and `--env` names it for a file
  whose name carries none. Both exist for one reason: flattening a scoped file to the
  unscoped default is not a lossy import, it is a scope-widening leak — the value becomes
  what every _other_ environment reads.

  v0.2 retires the risk that "type-safe" and "validated" are claims penv cannot back:
  `.penv/env.ts` scaffolding with the `@env` alias, the generic
  `load<T extends z.ZodType>(schema: T): z.infer<T>`, `penv validate`, `.json` meta with
  shallow base→env merge, the deterministic name transform with collision detection, and
  draft schema generation on import.

### Patch Changes

- Updated dependencies [094bd3a]
  - @penvhq/core@0.1.0
