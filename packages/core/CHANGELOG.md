# @penvhq/core

## 0.14.0

### Minor Changes

- fca6bbb: The workspace scan reaches `@penvhq/core`, and the Vercel declaration stops
  claiming a check it cannot make.

  **`penv upgrade` moves a workspace package's own `@penvhq/core`.** The scan that
  correctly found a second `@penvhq/penv` below the root looked for `@penvhq/core`
  only in the root it was writing to. A repository with two members declaring
  `^0.8.0` came out of a 0.13.0 upgrade holding two copies of the interfaces every
  committed provider declaration augments, five minor versions apart, under one
  engine pin. Every `package.json` that declares either package now moves — in the
  block that package chose, in its own step, under the same one consent — and the
  diff names each file, so a member that would not typecheck against the newer core
  is a decline away.

  **The Vercel declaration's header no longer overclaims.** It said that writing
  the real shape out is what stops "a misspelled target **and** a target keyed by
  an environment that does not exist". The first half is true; the second could
  never be, because `ProviderConfigMap["@penvhq/provider-vercel"]` is a fixed
  interface with no access to the `environments` the config declares, and widening
  the provider contract so one provider could see them is not a trade penv makes.
  The provider refuses the key at construction instead, naming the offending key
  and the environments the project declares, and the header says that. `penv add`
  copies this declaration verbatim, so an already-adopted project gets the
  corrected header the next time it adds the provider.

  **An unknown field in a provider entry says which field and whose config.** The
  whole diagnostic was `Type 'number' is not assignable to type 'never'` — the
  right line and column, and nothing about why, beside a targets error in the same
  file that lists all three legal values. The excess key now maps to a type whose
  single member is the sentence, which TypeScript prints:
  `"retries is not a field @penvhq/provider-vercel declares"`.

  **Two honesty bugs in `penv upgrade`'s output.** The consent diff rendered the
  `@penvhq/core` step as though it were creating a `devDependencies` block, into
  root manifests that already had one with fourteen entries — the one
  nesting-shorthand line in an otherwise literal `-`/`+` diff, and so the one a
  reader would go and check by hand. An existing block now shows as the context it
  is. And the closing `✓` lines confirmed both `@penvhq/penv` declarations and the
  manifest pin while never mentioning `@penvhq/core`, the one change the previous
  release introduced. They now name every package that landed, per file.

## 0.13.0

## 0.12.0

### Minor Changes

- ca2fa13: Published provider extensions install and load.

  Every official provider now publishes self-contained: `@penvhq/core` and the zod
  it reaches for are bundled into the tarball rather than declared as dependencies.
  Nothing on the install path resolves a dependency — `penv add` unpacks one
  tarball into `$PENV_HOME` and stops — so a provider that shipped a bare
  `import "@penvhq/core"` died on its first line, and no published extension could
  be loaded at all.

  `penv install` now imports every extension it installs, the same check `penv add`
  runs, so a store that will not load fails at install time with the file and the
  cause instead of at the first provider operation days later.

  A refusal thrown by an extension is built from that extension's own copy of the
  error classes, so `instanceof PenvError` is false for all of it. Core gains
  `isPenvErrorLike`, and the CLI's renderer asks it: a provider's refusal now
  prints as the same two-line block as the engine's, without the stack frames it
  used to dump underneath.

  `@penvhq/provider-vercel`, `-github`, `-vault`, `-ssm` and `-kubernetes` each ship
  a `penv.types` declaration, so the file `penv add` commits carries the provider's
  real config shape — a misspelled Vercel target, or a key the provider never
  reads, is now a compile error in `penv.config.ts` instead of a push-time failure.

## 0.11.0

### Minor Changes

- 8786e21: `penv upgrade [version]` moves the engine pin and the runtime dependency together

  Moving the pinned engine used to mean hand-editing `.penv/state/manifest.json` — a version _and_ an 88-character integrity hash fetched from the registry by hand — on the one file whose whole purpose is that its bytes are verified. `penv upgrade` is that edit, made by penv: it resolves the release (no version means `latest`), takes the integrity from the registry's `dist.integrity`, installs the engine into `$PENV_HOME`, and moves the project's `@penvhq/penv` to the same exact version through the detected package manager. Both file changes are shown before either happens and one answer covers both, so a decline leaves the manifest and `package.json` untouched. `--yes` answers in advance; an unattended run needs it _and_ an explicit version. Extensions keep their own pins.

  The engine publishes its dependency-install plan at `@penvhq/cli/install`, so `init` and `upgrade` write that `@penvhq/penv` line through one implementation rather than two.

## 0.10.0

### Patch Changes

- 1aa9a87: The engine now reads `$PENV_HOME`, so an extension `penv add` installed is one a command can use.

  `penv add <package>` installed the extension into `$PENV_HOME` and pinned it in the manifest, and the engine then resolved providers only from the project's `node_modules` — so the shipped flow ended at `UNKNOWN_PROVIDER`. An extension is now found in one documented order: the local-extension list, then the project's own `node_modules`, then `$PENV_HOME` at the version the manifest pins. A pinned extension missing from the store refuses naming `penv install`.

  Three refusals that were harder to act on than they had to be:

  - `penv add` imports the package once before it records anything, so a provider whose `exports` point at TypeScript source is refused at add time instead of failing days later from an unrelated command.
  - A provider that resolves and will not import now reports what it threw and the file it tried, rather than discarding both.
  - `penv --help` lists `install` and `add`, and `penv add --help` and `penv install --help` print usage instead of being refused.

## 0.9.5

### Patch Changes

- 5815a93: Five things a real 0.9.4 adoption found, and one documentation line that was still wrong.

  `PENV_DELIVERY` was load-bearing for platform delivery and appeared nowhere in the
  documentation. It is the parameter-to-variable map `penv run` writes, and the bridge cannot
  work the names out for itself because `override` bends them — so a project with an `override`
  deploying to a platform that starts the process itself had every value present and heard
  "missing required parameter". The managed-serverless section now sets it out as part of the
  platform setup, with the command that captures the contract from penv rather than by hand.
  The refusal moved with it: a process carrying `PENV_ENV` without `PENV_DELIVERY` is an
  environment something other than `penv run` delivered, and it now names the variable penv
  actually read and asks for the map, instead of recommending a command the platform will
  never run.

  `penv run` left `PENV_HOME` in the application's child. The launcher sets it for the engine,
  the engine's child inherited it, and PRD §4 says penv removes its internal control variables
  before the application starts. It is stripped now. `PENV_ENV`, `PENV_DELIVERY` and `PENV_RUN`
  stay, deliberately — each has a reader downstream — and the documentation says which reader,
  rather than claiming everything internal is taken out. One consequence worth knowing: a penv
  command run from inside an application started by `penv run` resolves `$PENV_HOME` afresh
  rather than inheriting the parent's.

  The refusal an application developer is most likely to meet arrived as a raw Node stack dump,
  because nobody catches it. A `PenvError` now renders itself: its `stack` opens with the
  message and the remedy behind the same arrow every command prints, and carries the caller's
  frames instead of penv's path down to the throw.

  A repository that develops a provider could not use it. Extensions resolved only through
  `penv add`, which needs a published release, so a workspace package named in `penv.config.ts`
  made every command refuse — including development-scope ones. `penv add --local <package>`
  is the path with no release behind it: it resolves the package from the project's own
  `node_modules`, writes the same type-only declaration, and records the name in
  `.penv/state/local-extensions.json` — committed, names only. The manifest is not opened,
  because it pins bytes and a package being written in this checkout has none to pin. Nothing
  about the arrangement is silent: `penv doctor` reports every local extension with the `?`
  verdict, CI refuses one and names `penv add <package>`, and the flags that describe a release
  are refused rather than ignored.

  `penv doctor` reported all green over a tree whose meta declared no secrecy at all.
  Encryption is policy-driven, so with no policy the encryption checks passed vacuously — over
  plaintext values holding real credentials. A parameter whose meta declares secrecy neither
  way is now the `?` verdict, summarized once, naming the meta file that answers it. A project
  that has declared either way for everything stays green.

  The RFC still called the launcher a small executable that only finds an engine. It carries
  one; the same correction the Install section already had.

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

## 0.9.0

### Minor Changes

- 7ad42ba: `penv init` is a complete dotenv cutover.

  It lists the dotenv files it found, preselects the development cascade, and adopts the ones you choose — all of them or none. Selecting an environment-scoped file is what declares that environment; `.env` alone declares nothing, so init asks which environment those values are for rather than inventing one. The draft schema it writes is the weakest shape every adopted environment satisfies: a field all of them carry starts required, a field missing from any starts optional, and requiredness is never inferred per environment. When the development cascade is adopted, `defaultEnvironment: "development"` is written down, so the daily command is `penv run -- pnpm dev`.

  Everything is preflighted before anything moves: the selection, the environments it declares, every framework-discoverable file in those cascades, every variable name, the generated variable each maps to, the draft, and the dependency install. A failed preflight changes nothing and never claims a partial migration. The runtime dependency is installed at the engine's exact version with the project's own package manager, and only after the exact `package.json` and lockfile change is shown; a declined or failed install performs no cutover. init then imports, validates every adopted environment, and only then moves the prior dotenv files into one ignored bundle under `.penv/state/rollback/dotenv/`, recorded in `.penv/state/cutover.json`.

  `penv init undo` restores those files under their exact names. `penv cleanup` is the new command that closes the migration, removing the bundle and its cutover state and nothing else. A second migration refuses while a bundle is unresolved. After a cutover, `penv run` refuses a framework-active `.env`, `.env.local`, `.env.<environment>` or `.env.<environment>.local` that reappears, so a later edit cannot quietly recreate a second source of configuration; `.env.example` and its documentation siblings are excluded.

  init never edits `package.json` scripts — it ends by showing the `penv run --` line to type — and it creates no keys, seals nothing, builds no artifact and authenticates with no provider.

  `@penvhq/penv` no longer declares a `penv` bin. It is the typed runtime surface an adopted project depends on; the global `penv` is the launcher's.

- d36fbf4: **Breaking:** the embedded snapshot is removed. `penv.snapshot.ts` is no longer generated, read, or checked.

  `penv snapshot` is gone, and so are the `snapshot` and `source` options on `load()`, the `PenvSnapshot` and `LoadSource` types, and the `doctor` checks `snapshot-stale` and `bundle-invisible-plaintext`. `load()` resolves from `penv.config.ts` and the `.penv/` tree, and nothing else: a project with no config file fails by name instead of falling back. `penv init` scaffolds an `env.ts` that calls `load(schema)`.

  A committed `penv.snapshot.ts` left over from 0.8 is an inert file — nothing reads it, so delete it and drop its `import` from your `env.ts`. Deployments that resolved from the snapshot need a build step that materializes configuration for the target instead.

- 0a1601d: `penv run -- <command>` is how an adopted project starts.

  It resolves the parameter tree, checks it against your schema, builds a child environment penv owns, and starts the exact command after `--` — argument boundaries, pipes, `pre*`/`post*` hooks, exit code and signals all stay the child's. `--source` defaults to `project`, so the daily command is `penv run -- pnpm dev`; `snapshot` names the sealed artifact and is always spelled out. A run contacts no provider: what is already materialised locally is the whole input, and `--watch` is the one opt-in mode allowed to sync, where a failed pull or a failed check leaves the running child exactly where it was.

  The child environment is penv's: every schema-declared parameter is written under its generated name, or deleted when the schema excuses it and nothing resolved, so a stale export cannot stand in for a value penv resolved to nothing. Unrelated variables are untouched; penv's keys, the declared providers' credentials, and its own control variables never reach the child. An outer `penv run` meeting an in-script one is refused, naming both.

  `penv.config.ts` takes a new `defaultEnvironment`, checked against the environment whitelist, that `run`, `pull`, `push`, `set` and every other environment-taking command fall back to when `--env` is absent. It is a declared decision, never inference — CI still names `--env`. With neither the flag nor the key, the refusal names both.

  Two refusals are new, and both name one next command: an application started outside `penv run` is told the missing parameter and the `penv run --` line to start it with, and an environment whose provider holds values nothing has pulled yet is told `Run: penv pull`.

- 6917016: **Breaking:** the parameter tree moves to `.penv/state/records/`, and penv reads only that layout.

  `.penv/state/` is where penv keeps what it manages — the records, the committed `.gitignore` that draws the safety boundary, and the manifest and extension declarations that follow. `.penv/env.ts` stays yours, at the same path. Records keep their names, so the filename grammar, the cascade, meta and the AAD that binds a ciphertext to its address are all unchanged.

  Run `penv migrate` to convert an existing project: it previews the move, converts on approval, and leaves `penv.schema.ts`, `penv.config.ts` and `.penv/env.ts` byte-identical. Running it twice is a no-op that says so. Until you run it, every command — and `load()` — refuses by name rather than reading an empty tree.

  `ProviderFactoryContext.root` is now the project root rather than the `.penv/` directory, so a provider package that derives paths from it should re-derive them.

## 0.8.0

### Minor Changes

- fb0a49f: Add a committed `penv.snapshot.ts` so `load()` resolves in a bundled or serverless runtime.

  A compiled bundle — a Next.js middleware chunk, a Vercel `/var/task` function — has no `penv.config.ts` and no `.penv/` tree to walk to, so `load()` threw `No penv.config.ts found…`. `penv snapshot` now generates a committed data module at the project root that embeds the evaluated config and every committed sealed (`.enc`) value, and wires your `env.ts` to pass it to `load()`. On disk, file discovery still comes first and a live edit wins; only in a bundle does `load()` fall back to the snapshot, decrypting under the same `PENV_KEY_*`.

  The snapshot embeds sealed records only — never plaintext, at any scope, nor `.local` values — so the committed ciphertext in `penv.snapshot.ts` is the same ciphertext a git clone already carries (the `.enc` value files are gitignored, so the snapshot is where a bundle reads them). `penv doctor snapshot-stale` guards the pair, and the mutating commands refresh it automatically. `penv doctor bundle-invisible-plaintext` flags a team-scope plaintext value a bundle cannot see: seal it to ship it. New projects scaffold the snapshot and a pre-wired `env.ts` from `penv init`.

- The one-schema standard: `penv.schema.ts` is the single shape module every consumer imports.

  The schema shape lives at the project root, importable without side effects; `.penv/env.ts` stays the thin loader that re-exports it and calls `load()`. A code module dropped into `.penv/` that is not the file `schemaFile` names is reported as a stray code module (`STRAY_CODE_FILE`) rather than misparsed as a value file, and `validate`/`watch` enforce the split.

## 0.7.0

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
