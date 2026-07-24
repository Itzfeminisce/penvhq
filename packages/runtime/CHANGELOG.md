# @penvhq/runtime

## 0.7.0

### Minor Changes

- ab9a971: `load(schema, { inject })` now accepts an allowlist as well as a boolean. Pass an
  array of parameter ids to inject only those into `process.env`, leaving every
  other declared parameter untouched — never written, never deleted. Use it when
  the schema also holds secrets that must not reach `process.env` (database URLs,
  cloud credentials), while a subset (WorkOS keys, a public redirect) must:

  ```ts
  export const env = load(schema, {
    inject: ["workos/api-key", "workos/client-id", "workos/redirect-uri"],
  });
  ```

  The allowlist is typed to the schema's own parameter ids at the `load` call
  site — the ids autocomplete and a typo is a compile error. `inject: true` still
  injects the whole schema. Off by default.

### Patch Changes

- @penvhq/core@0.7.0
- @penvhq/provider-filesystem@0.7.0

## 0.6.0

### Minor Changes

- 5291754: `load(schema, { inject: true })` — the blessed ambient surface (v0.8, part one).

  A third-party SDK that reads `process.env.ITS_EXACT_NAME` at module load now finds a validated value with no per-SDK bridge code. Passing `{ inject: true }` to `load` writes the validated environment onto `process.env` after the schema has accepted it, so an SDK never sees a half-configured surface.

  - **Exclusive over the schema.** Every parameter the schema declares is penv's to own ambiently: written (under its generated, `override`-bent variable, as the raw string the SDK re-parses) when it has a value — a tree value or a schema `.default()` — and deleted when it has none, so a stray ambient `WORKOS_API_HOSTNAME` cannot steer an SDK behind `@env`'s back.
  - **Off by default.** No import, no mirror: a consumer who never asked for `process.env` writes gets none. The schemaless `import "@penvhq/penv/config"` compat entry stays for adoption-before-a-schema.
  - New exports from `penv`/`@penvhq/runtime`: `inject`, `declaredRefs`, and the `InjectResult` type.

  The per-framework `penv init` seams (scaffolding `import "@env"` into `instrumentation.ts`, a Nitro plugin, `hooks.server.ts`, `node --import`) and `doctor`'s `ambient-shadow` check are the follow-ups.

### Patch Changes

- @penvhq/core@0.6.0
- @penvhq/provider-filesystem@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [c10576f]
- Updated dependencies [df5cf15]
- Updated dependencies [b94fd7a]
  - @penvhq/core@0.5.0
  - @penvhq/provider-filesystem@0.5.0

## 0.4.0

### Patch Changes

- @penvhq/core@0.4.0
- @penvhq/provider-filesystem@0.4.0

## 0.3.2

### Patch Changes

- 37008df: `penv fill` now sees the gap it exists to close in a project with no values yet.

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

- Updated dependencies [37008df]
  - @penvhq/core@0.3.2
  - @penvhq/provider-filesystem@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [e20f411]
  - @penvhq/core@0.3.1
  - @penvhq/provider-filesystem@0.3.1

## 0.3.0

### Patch Changes

- @penvhq/core@0.3.0
- @penvhq/provider-filesystem@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [31171e9]
  - @penvhq/core@0.2.0
  - @penvhq/provider-filesystem@0.2.0

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
  - @penvhq/provider-filesystem@0.1.0
  - @penvhq/core@0.1.0
