---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/provider-filesystem": minor
"@penvhq/provider-vault": minor
"@penvhq/provider-ssm": minor
"@penvhq/provider-kubernetes": minor
"@penvhq/provider-mock": minor
"@penvhq/penv": minor
---

Provider types become fully-qualified package names, typed by the packages themselves (v0.7, part one — breaking).

- `providers.<env>.type` is now the provider package's name — `"@penvhq/provider-vault"`, not `"vault"` — and the name is the import specifier: penv resolves it from your project's `node_modules`. A legacy short name is refused with the exact rewrite; the `module` override field is gone, because with package names as types there is nothing left to override.
- `location` replaces `path`: one field on every provider for "the place inside the provider penv maps the tree onto", with the format documented per provider (Vault KV base path, SSM path prefix, Kubernetes `namespace/secretName`).
- Provider config is typed by declaration merging: each provider package augments core's `ProviderConfigMap`, so `defineConfig` checks a known `type`'s fields exactly and an unknown `type` keeps the open base shape.
- The CLI now pre-installs only `@penvhq/provider-filesystem` and `@penvhq/provider-mock`. Vault, SSM, and Kubernetes are installed by the projects that use them (`npm i -D @penvhq/provider-vault`), which drops their dependency weight from every project that doesn't. Each externalised package exports the `penvProviderFactory` entry point the CLI resolves.
- Provider instances report their package name as `type`, so reports, config, and errors speak one vocabulary.

Migration: in `penv.config.ts`, rewrite each provider `type` to its package name, rename `path` to `location`, and install the provider packages your config declares. `penv validate` names every rewrite.
