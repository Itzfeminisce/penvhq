# @penvhq/penv

## 0.6.0

### Minor Changes

- 5291754: `load(schema, { inject: true })` — the blessed ambient surface (v0.8, part one).

  A third-party SDK that reads `process.env.ITS_EXACT_NAME` at module load now finds a validated value with no per-SDK bridge code. Passing `{ inject: true }` to `load` writes the validated environment onto `process.env` after the schema has accepted it, so an SDK never sees a half-configured surface.

  - **Exclusive over the schema.** Every parameter the schema declares is penv's to own ambiently: written (under its generated, `override`-bent variable, as the raw string the SDK re-parses) when it has a value — a tree value or a schema `.default()` — and deleted when it has none, so a stray ambient `WORKOS_API_HOSTNAME` cannot steer an SDK behind `@env`'s back.
  - **Off by default.** No import, no mirror: a consumer who never asked for `process.env` writes gets none. The schemaless `import "@penvhq/penv/config"` compat entry stays for adoption-before-a-schema.
  - New exports from `penv`/`@penvhq/runtime`: `inject`, `declaredRefs`, and the `InjectResult` type.

  The per-framework `penv init` seams (scaffolding `import "@env"` into `instrumentation.ts`, a Nitro plugin, `hooks.server.ts`, `node --import`) and `doctor`'s `ambient-shadow` check are the follow-ups.

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

## 0.3.1

## 0.3.0

## 0.2.0

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
