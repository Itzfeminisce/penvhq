# @penvhq/cli

## 0.7.0

### Patch Changes

- b630532: `penv init` now writes Bun's `bunfig.toml` for you when injection is enabled, not just the preload file. The preload script is inert until `bunfig.toml` registers it, so penv scaffolds both — the `preload` array and its `[test]` mirror — under the same rule as every seam: it writes a fresh `bunfig.toml`, but never overwrites one you already own (it prints where to add the entry instead).
- Updated dependencies [ab9a971]
  - @penvhq/runtime@0.7.0
  - @penvhq/core@0.7.0
  - @penvhq/provider-filesystem@0.7.0
  - @penvhq/provider-mock@0.7.0

## 0.6.0

### Minor Changes

- 596c71a: `penv init` sets up process.env injection for your framework (v0.8, part two).

  When you opt in — `init` asks, default No — penv writes `load(schema, { inject: true })` and places the one line that runs it before your app code, in the file your framework guarantees runs first:

  - **Next.js** → `instrumentation.ts` with a guarded `register()` (the `NEXT_RUNTIME === "nodejs"` guard is mandatory — Next calls `register` on Edge, where penv can't read the filesystem)
  - **SvelteKit** → `src/hooks.server.ts` (with a note to register the alias in `kit.alias`)
  - **Nuxt/Nitro** → `server/plugins/0.penv.ts` (the `0.` prefix keeps it first)
  - **Bun** → `.penv/preload.ts` (with the `bunfig.toml` registration as a note)
  - **TanStack Start, Astro, plain Node/Express/Fastify** → the exact verified instruction is printed (no file penv can safely own)
  - **Vite SPA** → nothing: no server reads process.env, and init says so

  penv scaffolds a fresh seam file but never edits a hook you already own — an existing file becomes a printed instruction instead. Each framework's hook was verified against its current documentation. Injection stays off by default: no opt-in, no seam, no change.

  `detect` now also recognizes SvelteKit, Nuxt, and Bun.

### Patch Changes

- Updated dependencies [5291754]
  - @penvhq/runtime@0.6.0
  - @penvhq/core@0.6.0
  - @penvhq/provider-filesystem@0.6.0
  - @penvhq/provider-mock@0.6.0

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

### Patch Changes

- Updated dependencies [c10576f]
- Updated dependencies [df5cf15]
- Updated dependencies [b94fd7a]
  - @penvhq/core@0.5.0
  - @penvhq/provider-filesystem@0.5.0
  - @penvhq/provider-mock@0.5.0
  - @penvhq/runtime@0.5.0

## 0.4.0

### Minor Changes

- 606297a: A modern terminal experience across every command, and `penv fill` learns about optional parameters.

  `fill` now asks for `.optional()` and `.default()` parameters too, after the required gaps, tagged `optional` with the schema's default shown when penv can read it — `? log-level · production · optional, Enter keeps "info" ›`. An answer writes an override through `penv set` as ever; Enter keeps what the schema declared, reported as "left to the schema's defaults" rather than skipped. Piped input no longer loses answers that arrive before the first prompt (`printf 'value\n' | penv fill` used to crash with `ERR_USE_AFTER_CLOSE`): early lines are buffered in order, and end-of-input cleanly skips whatever was not answered.

  Verdicts are colored at the glyph — green ✓ pass, yellow ⚠ warning, red ✗ failure, dim ? could-not-look — details and asides read dimmed, and every remedy is a cyan-arrowed tip in one shape the whole CLI shares. `doctor` and `validate` close with a counted, colored summary line; `list` gains column headers, a colored scope column, and an `encrypted` marker; `get --explain` highlights the winning file and dims the losers; interactive prompts (`fill`, `init`) wear one styled `?` shape. Errors print a red ✗ with the remedy as a tip. Color honors `NO_COLOR` and `FORCE_COLOR` and switches off automatically when output is piped, so scripts, CI logs, and tests see the exact plain bytes they always did.

### Patch Changes

- @penvhq/core@0.4.0
- @penvhq/provider-filesystem@0.4.0
- @penvhq/provider-kubernetes@0.4.0
- @penvhq/provider-mock@0.4.0
- @penvhq/provider-ssm@0.4.0
- @penvhq/provider-vault@0.4.0
- @penvhq/runtime@0.4.0
- @penvhq/sink-github@0.4.0

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
  - @penvhq/runtime@0.3.2
  - @penvhq/provider-filesystem@0.3.2
  - @penvhq/provider-kubernetes@0.3.2
  - @penvhq/provider-mock@0.3.2
  - @penvhq/provider-ssm@0.3.2
  - @penvhq/provider-vault@0.3.2
  - @penvhq/sink-github@0.3.2

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

- Updated dependencies [e20f411]
  - @penvhq/core@0.3.1
  - @penvhq/provider-filesystem@0.3.1
  - @penvhq/provider-kubernetes@0.3.1
  - @penvhq/provider-mock@0.3.1
  - @penvhq/provider-ssm@0.3.1
  - @penvhq/provider-vault@0.3.1
  - @penvhq/runtime@0.3.1
  - @penvhq/sink-github@0.3.1

## 0.3.0

### Minor Changes

- f02a21a: Add `penv fill` and guard the write path against non-canonical parameter keys.

  `penv fill` prompts for each declared parameter the tree has no value for, deriving the value-file name from the schema so you never translate a camelCase schema key to its kebab file yourself. On the write path, `penv set` and the `penv mv` destination now refuse a non-canonical key and point you at the canonical lower-case hyphenated name.

- 972a177: Add the AWS SSM Parameter Store and Kubernetes Secrets providers — v0.6, generalizing the portability proof from Vault's single adapter to three, with no change to the v0.5 provider contract.

  - **`@penvhq/provider-ssm`** — a `RetainingProvider`. Reads always decrypt (a `SecureString` read without `WithDecryption` returns ciphertext as the value); every value is stored behind a one-byte sentinel so an empty penv value satisfies SSM's non-empty `Value` rule while round-tripping byte-exactly; `readPrevious` reads `GetParameterHistory`; meta is a sibling parameter at its own name.
  - **`@penvhq/provider-kubernetes`** — a plain `Provider` that **declares retention absent** (Kubernetes Secrets keep no history, so `retainsPrevious` narrows it to `false` and a `dual-valid` rotation refuses it up front). penv's arbitrary-depth namespace flattens into one Secret's flat data keys via a reversible, collision-free escape — every byte outside the key alphabet `[A-Za-z0-9.-]` becomes `_` plus its two-hex UTF-8 byte — settling the flattening collision hazard for any name, including those with spaces or non-ASCII. The cluster namespace is configurable (`providers.*.path` is `<namespace>/<secret>`), defaulting to the current `kubectl` context.

  Both pass the `@penvhq/provider-contract` suite unchanged, and both register as `providers.*.type` — `ssm`, `kubernetes` — in the CLI. Each reaches its backend only through the backend's own CLI (`aws`, `kubectl`), so penv holds no cloud credential of its own; the contract proofs run against injected in-memory fakes.

### Patch Changes

- Updated dependencies [972a177]
  - @penvhq/provider-ssm@0.3.0
  - @penvhq/provider-kubernetes@0.3.0
  - @penvhq/core@0.3.0
  - @penvhq/provider-filesystem@0.3.0
  - @penvhq/provider-mock@0.3.0
  - @penvhq/provider-vault@0.3.0
  - @penvhq/runtime@0.3.0
  - @penvhq/sink-github@0.3.0

## 0.2.0

### Minor Changes

- 31171e9: Resolve an unregistered `providers.*.type` as a convention-loaded provider plugin.

  A `type` with no built-in entry (`filesystem`, `vault`, `mock`) is now loaded from the package `@penvhq/provider-<type>` — or the package a new optional `providers.*.module` field names — and validated against the `Provider` contract before it is trusted. This is the same shape ESLint uses for `eslint-plugin-<name>`: penv stays generic, and a private or third-party backend plugs in by being installed, with no change to penv itself.

  The open-time guarantee is unchanged. A provider that is neither built in nor installed still fails at `openProject`, now with an `npm i @penvhq/provider-<type>` hint. The check is a synchronous package-resolution probe that runs no plugin code, so `openProject` stays synchronous; the plugin's module is imported only when an environment's source of truth is actually built (`penv pull`, cross-provider `doctor`, `rotate`). The built-in providers and the static registry are untouched.

### Patch Changes

- Updated dependencies [31171e9]
  - @penvhq/core@0.2.0
  - @penvhq/provider-filesystem@0.2.0
  - @penvhq/provider-mock@0.2.0
  - @penvhq/provider-vault@0.2.0
  - @penvhq/runtime@0.2.0
  - @penvhq/sink-github@0.2.0

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

- 71c081e: First public release of the `@penvhq/*` packages: `@penvhq/penv` (the batteries-included package users install — carries the `penv` bin and re-exports `load`/`defineConfig`), plus `@penvhq/core`, `@penvhq/runtime`, `@penvhq/cli`, `@penvhq/provider-filesystem`, `@penvhq/provider-contract`, and `@penvhq/sink-github`.

  The `@penv` org and the unscoped `penv` name are both taken on npm, so everything publishes under `@penvhq`. The tool name, the `penv` command, `.penv/`, and `penv.config` are unchanged — only the npm namespace moves. `penv init` scaffolds imports from `@penvhq/penv`. The whole set is a fixed version group, so this one changeset bumps them together.

### Patch Changes

- Updated dependencies [094bd3a]
  - @penvhq/provider-filesystem@0.1.0
  - @penvhq/runtime@0.1.0
  - @penvhq/core@0.1.0
  - @penvhq/sink-github@0.1.0
