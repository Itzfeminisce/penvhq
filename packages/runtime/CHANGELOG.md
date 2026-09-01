# @penvhq/runtime

## 0.16.1

### Patch Changes

- @penvhq/core@0.16.1
- @penvhq/provider-filesystem@0.16.1

## 0.16.0

### Patch Changes

- @penvhq/core@0.16.0
- @penvhq/provider-filesystem@0.16.0

## 0.15.0

### Minor Changes

- eb93f50: One `environments` record holds each environment's whole declaration, and every
  provider gets its own vocabulary back.

  **Three top-level structures become one.** `environments: string[]`, `providers`,
  and `keys` all described the same thing — what an environment _is_ — from three
  places, so reading one environment meant reading three. They merge into
  `environments: Record<string, string | EnvironmentEntry>`, whose entry names the
  provider that holds the environment, the fields that provider declares, and the
  `keySource` that seals it. The record's keys are still the whitelist: a key is a
  declaration, not an inference, so nothing about how an environment name is
  recognised has moved. An environment whose provider needs no fields is written as
  the package name alone — `development: "@penvhq/provider-filesystem"`.

  **`location` is deleted, and each provider takes its own field names.** One generic
  address field meant five stores answering to penv's word instead of their own:
  `location` for what Vercel calls a project, for what Vault and SSM call a path, for
  a `namespace/secretName` pair Kubernetes keeps as two separate facts. Entries now
  read like the store's own documentation — Vercel's `project` and `teamId`, Vault's
  and SSM's `path`, Kubernetes' `secret` and `namespace`, GitHub's `repository` —
  typed by each package's committed declaration, so a field a provider does not
  declare is a compile error rather than a silently ignored key. `type` becomes
  `provider` for the same reason: the value was always a package name.

  **Vercel's `targets` record becomes a singular `target`, defaulting to the
  environment's own name.** A per-environment entry only ever mapped one environment,
  so `targets: { production: "production" }` restated its own key back at itself. A
  `production` environment now needs nothing; a `staging` environment declares
  `target: "preview"`, because Vercel has no staging target and a guess between
  production and preview is a guess about which deployment reads the secret. An
  environment that is neither a Vercel target nor carrying an explicit one is refused
  at construction, naming both remedies.

  **Keys move into the entry they belong to, byte-compatibly.** `keys.<env>` becomes
  `keySource`, and its id defaults to the environment's name — so `keySource: "env"`
  on `production` is exactly the old `{ source: "env", id: "production" }`, seals
  under the same `PENV_KEY_PRODUCTION`, and stamps artifacts with the same
  `env:production` identifier. A config migrated one-for-one produces identical
  artifact bytes. The object form is still there for a rotation that gives the key a
  name of its own. Nothing about key resolution changed: an unrecognised or
  unavailable source still refuses rather than falling back.

  **One migration error teaches the whole move, and there is no compat shim.** A
  config whose `environments` is an array, or that carries a top-level `providers` or
  `keys` key, fails at load with `CONFIG_ENVIRONMENTS_MERGED` before anything else is
  reported, because every other complaint would be a consequence of the same one
  fact. The message names each move — `type` to `provider`, `location` to the field
  the provider declares, `targets` to `target`, `keys.<env>` to `keySource` — and
  prints the old entry beside its rewrite, so the fix is a copy rather than a
  reading. Every remedy string that used to teach the old shape teaches the new one.

  **`penv push --destination` and `--location` are gone.** They let a push land
  somewhere the config never declared, which is a seam of exactly the kind penv
  exists to close, and with provider-specific field names there is no generic slot
  left for a place. A push goes to the provider its environment's entry declares, and
  `NO_DESTINATION` teaches the config edit — the same edit ongoing use needs anyway.

  The provider contract is untouched. Field names are config surface; `capabilities`,
  `holds`, `readsValues`, and the shared contract suite are the same for every
  provider as they were.

### Patch Changes

- Updated dependencies [eb93f50]
  - @penvhq/core@0.15.0
  - @penvhq/provider-filesystem@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [fca6bbb]
  - @penvhq/core@0.14.0
  - @penvhq/provider-filesystem@0.14.0

## 0.13.0

### Patch Changes

- @penvhq/core@0.13.0
- @penvhq/provider-filesystem@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [ca2fa13]
  - @penvhq/core@0.12.0
  - @penvhq/provider-filesystem@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [8786e21]
  - @penvhq/core@0.11.0
  - @penvhq/provider-filesystem@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [1aa9a87]
  - @penvhq/core@0.10.0
  - @penvhq/provider-filesystem@0.10.0

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

- Updated dependencies [5815a93]
  - @penvhq/core@0.9.5
  - @penvhq/provider-filesystem@0.9.5

## 0.9.4

### Patch Changes

- @penvhq/core@0.9.4
- @penvhq/provider-filesystem@0.9.4

## 0.9.3

### Patch Changes

- @penvhq/core@0.9.3
- @penvhq/provider-filesystem@0.9.3

## 0.9.2

### Patch Changes

- @penvhq/core@0.9.2
- @penvhq/provider-filesystem@0.9.2

## 0.9.1

### Patch Changes

- @penvhq/core@0.9.1
- @penvhq/provider-filesystem@0.9.1

## 0.9.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [7ad42ba]
- Updated dependencies [d36fbf4]
- Updated dependencies [0a1601d]
- Updated dependencies [6917016]
  - @penvhq/core@0.9.0
  - @penvhq/provider-filesystem@0.9.0

## 0.8.0

### Minor Changes

- fb0a49f: Add a committed `penv.snapshot.ts` so `load()` resolves in a bundled or serverless runtime.

  A compiled bundle — a Next.js middleware chunk, a Vercel `/var/task` function — has no `penv.config.ts` and no `.penv/` tree to walk to, so `load()` threw `No penv.config.ts found…`. `penv snapshot` now generates a committed data module at the project root that embeds the evaluated config and every committed sealed (`.enc`) value, and wires your `env.ts` to pass it to `load()`. On disk, file discovery still comes first and a live edit wins; only in a bundle does `load()` fall back to the snapshot, decrypting under the same `PENV_KEY_*`.

  The snapshot embeds sealed records only — never plaintext, at any scope, nor `.local` values — so the committed ciphertext in `penv.snapshot.ts` is the same ciphertext a git clone already carries (the `.enc` value files are gitignored, so the snapshot is where a bundle reads them). `penv doctor snapshot-stale` guards the pair, and the mutating commands refresh it automatically. `penv doctor bundle-invisible-plaintext` flags a team-scope plaintext value a bundle cannot see: seal it to ship it. New projects scaffold the snapshot and a pre-wired `env.ts` from `penv init`.

### Patch Changes

- Updated dependencies [fb0a49f]
- Updated dependencies
  - @penvhq/core@0.8.0
  - @penvhq/provider-filesystem@0.8.0

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
