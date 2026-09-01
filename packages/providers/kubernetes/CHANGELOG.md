# @penvhq/provider-kubernetes

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

### Minor Changes

- 972a177: Add the AWS SSM Parameter Store and Kubernetes Secrets providers — v0.6, generalizing the portability proof from Vault's single adapter to three, with no change to the v0.5 provider contract.

  - **`@penvhq/provider-ssm`** — a `RetainingProvider`. Reads always decrypt (a `SecureString` read without `WithDecryption` returns ciphertext as the value); every value is stored behind a one-byte sentinel so an empty penv value satisfies SSM's non-empty `Value` rule while round-tripping byte-exactly; `readPrevious` reads `GetParameterHistory`; meta is a sibling parameter at its own name.
  - **`@penvhq/provider-kubernetes`** — a plain `Provider` that **declares retention absent** (Kubernetes Secrets keep no history, so `retainsPrevious` narrows it to `false` and a `dual-valid` rotation refuses it up front). penv's arbitrary-depth namespace flattens into one Secret's flat data keys via a reversible, collision-free escape — every byte outside the key alphabet `[A-Za-z0-9.-]` becomes `_` plus its two-hex UTF-8 byte — settling the flattening collision hazard for any name, including those with spaces or non-ASCII. The cluster namespace is configurable (`providers.*.path` is `<namespace>/<secret>`), defaulting to the current `kubectl` context.

  Both pass the `@penvhq/provider-contract` suite unchanged, and both register as `providers.*.type` — `ssm`, `kubernetes` — in the CLI. Each reaches its backend only through the backend's own CLI (`aws`, `kubectl`), so penv holds no cloud credential of its own; the contract proofs run against injected in-memory fakes.

### Patch Changes

- @penvhq/core@0.3.0
