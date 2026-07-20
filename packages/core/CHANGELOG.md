# @penvhq/core

## 0.6.0

## 0.5.0

### Minor Changes

- c10576f: Everything is a provider (v0.7, part two — breaking): sinks are unified into providers, and push/pull work against every store.

  - The `sinks` config key is removed; a config still carrying one is refused with the exact rewrite. `@penvhq/sink-github` is now `@penvhq/provider-github`, declared like any provider: `providers: { production: { type: "@penvhq/provider-github", location: "acme/api" } }`.
  - What a store can do is a declared capability on the contract, not a separate concept: `holds: "records" | "projection"` and `readsValues`. Vault/SSM/Kubernetes/filesystem are unchanged record-holders and still pass the same contract suite; GitHub declares a projection that withholds values and satisfies the new `ProjectionProvider` contract.
  - `penv push` targets the environment's declared provider: a record-holder receives the tree mirrored verbatim (sealed values cross byte-for-byte, no key needed); a projection-holder receives the resolved projection exactly as before (`.local` skipped, names judged first, all or nothing, `--allow-decrypt` for sealed values). `--destination`/`--dest`/`-d` with `--location`/`-l` pushes once to a provider the config does not name, persisting nothing.
  - A missing destination environment is created on approval: the push prompts, `--yes` pre-approves for CI, and a refusal names the remedy (`MISSING_TARGET`).
  - `penv pull` from a value-withholding provider materialises what the store honestly has — secret names as flat parameters with meta stubs, values left absent — and `penv validate` names every gap. Pull names, fill values, push anywhere: that loop is the migration path between stores.
  - `penv doctor`'s sink checks are now capability-driven (`projection-*` findings): names exact, hand-edits caught by timestamp, values permanently `unknown` — against the environment's provider, no second config key.
  - Whitelisted environments work as bare flags: `penv pull --production`. Real flags always win (`doctor` warns when an environment name shadows one), two environment flags are a hard error, and `--env` stays canonical.

- df5cf15: The `names` config block is renamed to `override`, with schema-typed keys (breaking).

  - `names` becomes `override` — the block overrides the generated variable for a parameter, and the honest name says so. One override bends the name for every consumer at once: `penv generate`, `penv push`, and (at v0.8) the ambient `process.env` mirror. A config still carrying `names` is refused with `CONFIG_NAMES_RENAMED` naming the one-line rewrite; the entries are unchanged.
  - **Typed keys.** The scaffolded `.penv/env.ts` now registers the schema's inferred shape on core's `PenvSchemaShape` (a type-only `declare module`, erased at runtime), and `override`'s keys narrow to the parameter ids the schema declares — camelCase kebab-cased, mirroring the runtime transform. A typo'd id (`workos/redirect-url` for `redirect-uri`) is a compile error instead of an override that silently never applies. A project that doesn't register a shape keeps plain `string` keys, and the exported `OverrideKeysOf<T>` transform lets one opt in by hand.

  Migration: rename the `names` block to `override` in `penv.config.ts` — entries unchanged — and re-run `penv init` (or add the `declare module` block by hand) to get typed keys. `penv validate` names the rewrite.

- b94fd7a: Provider types become fully-qualified package names, typed by the packages themselves (v0.7, part one — breaking).

  - `providers.<env>.type` is now the provider package's name — `"@penvhq/provider-vault"`, not `"vault"` — and the name is the import specifier: penv resolves it from your project's `node_modules`. A legacy short name is refused with the exact rewrite; the `module` override field is gone, because with package names as types there is nothing left to override.
  - `location` replaces `path`: one field on every provider for "the place inside the provider penv maps the tree onto", with the format documented per provider (Vault KV base path, SSM path prefix, Kubernetes `namespace/secretName`).
  - Provider config is typed by declaration merging: each provider package augments core's `ProviderConfigMap`, so `defineConfig` checks a known `type`'s fields exactly and an unknown `type` keeps the open base shape.
  - The CLI now pre-installs only `@penvhq/provider-filesystem` and `@penvhq/provider-mock`. Vault, SSM, and Kubernetes are installed by the projects that use them (`npm i -D @penvhq/provider-vault`), which drops their dependency weight from every project that doesn't. Each externalised package exports the `penvProviderFactory` entry point the CLI resolves.
  - Provider instances report their package name as `type`, so reports, config, and errors speak one vocabulary.

  Migration: in `penv.config.ts`, rewrite each provider `type` to its package name, rename `path` to `location`, and install the provider packages your config declares. `penv validate` names every rewrite.

## 0.4.0

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
