# @penvhq/sink-github

## 0.16.0

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

## 0.14.0

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

### Patch Changes

- Updated dependencies [8786e21]
  - @penvhq/core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [1aa9a87]
  - @penvhq/core@0.10.0

## 0.9.5

### Patch Changes

- Updated dependencies [5815a93]
  - @penvhq/core@0.9.5

## 0.9.4

### Patch Changes

- @penvhq/core@0.9.4

## 0.9.3

### Patch Changes

- @penvhq/core@0.9.3

## 0.9.2

### Patch Changes

- @penvhq/core@0.9.2

## 0.9.1

### Patch Changes

- @penvhq/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [7ad42ba]
- Updated dependencies [d36fbf4]
- Updated dependencies [0a1601d]
- Updated dependencies [6917016]
  - @penvhq/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [fb0a49f]
- Updated dependencies
  - @penvhq/core@0.8.0

## 0.7.0

### Patch Changes

- @penvhq/core@0.7.0

## 0.6.0

### Patch Changes

- @penvhq/core@0.6.0

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

### Patch Changes

- Updated dependencies [c10576f]
- Updated dependencies [df5cf15]
- Updated dependencies [b94fd7a]
  - @penvhq/core@0.5.0

## 0.4.0

### Patch Changes

- @penvhq/core@0.4.0

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

### Patch Changes

- Updated dependencies [094bd3a]
  - @penvhq/core@0.1.0
