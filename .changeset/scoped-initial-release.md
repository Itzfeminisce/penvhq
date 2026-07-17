---
"@penvhq/cli": minor
---

First public release of the `@penvhq/*` packages: `@penvhq/penv` (the batteries-included package users install — carries the `penv` bin and re-exports `load`/`defineConfig`), plus `@penvhq/core`, `@penvhq/runtime`, `@penvhq/cli`, `@penvhq/provider-filesystem`, `@penvhq/provider-contract`, and `@penvhq/sink-github`.

The `@penv` org and the unscoped `penv` name are both taken on npm, so everything publishes under `@penvhq`. The tool name, the `penv` command, `.penv/`, and `penv.config` are unchanged — only the npm namespace moves. `penv init` scaffolds imports from `@penvhq/penv`. The whole set is a fixed version group, so this one changeset bumps them together.
