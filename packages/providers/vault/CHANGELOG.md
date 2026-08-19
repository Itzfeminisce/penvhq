# @penvhq/provider-vault

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

### Patch Changes

- @penvhq/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [31171e9]
  - @penvhq/core@0.2.0
