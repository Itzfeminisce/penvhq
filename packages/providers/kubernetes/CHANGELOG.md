# @penvhq/provider-kubernetes

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
