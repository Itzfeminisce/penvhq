---
"@penvhq/core": minor
"@penvhq/runtime": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

**Breaking:** the embedded snapshot is removed. `penv.snapshot.ts` is no longer generated, read, or checked.

`penv snapshot` is gone, and so are the `snapshot` and `source` options on `load()`, the `PenvSnapshot` and `LoadSource` types, and the `doctor` checks `snapshot-stale` and `bundle-invisible-plaintext`. `load()` resolves from `penv.config.ts` and the `.penv/` tree, and nothing else: a project with no config file fails by name instead of falling back. `penv init` scaffolds an `env.ts` that calls `load(schema)`.

A committed `penv.snapshot.ts` left over from 0.8 is an inert file — nothing reads it, so delete it and drop its `import` from your `env.ts`. Deployments that resolved from the snapshot need a build step that materializes configuration for the target instead.
