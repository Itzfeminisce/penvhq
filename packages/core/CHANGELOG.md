# @penvhq/core

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

## 0.3.1

### Patch Changes

- e20f411: A schema guarded with `import "server-only"` no longer stops the CLI from reading it.

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

## 0.3.0

## 0.2.0

### Minor Changes

- 31171e9: Resolve an unregistered `providers.*.type` as a convention-loaded provider plugin.

  A `type` with no built-in entry (`filesystem`, `vault`, `mock`) is now loaded from the package `@penvhq/provider-<type>` — or the package a new optional `providers.*.module` field names — and validated against the `Provider` contract before it is trusted. This is the same shape ESLint uses for `eslint-plugin-<name>`: penv stays generic, and a private or third-party backend plugs in by being installed, with no change to penv itself.

  The open-time guarantee is unchanged. A provider that is neither built in nor installed still fails at `openProject`, now with an `npm i @penvhq/provider-<type>` hint. The check is a synchronous package-resolution probe that runs no plugin code, so `openProject` stays synchronous; the plugin's module is imported only when an environment's source of truth is actually built (`penv pull`, cross-provider `doctor`, `rotate`). The built-in providers and the static registry are untouched.

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
