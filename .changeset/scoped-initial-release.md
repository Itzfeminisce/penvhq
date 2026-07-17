---
"@penvhq/cli": minor
---

First public release of the scoped `@penvhq/*` packages (`@penvhq/core`, `@penvhq/runtime`, `@penvhq/cli`, `@penvhq/provider-filesystem`, `@penvhq/provider-contract`, `@penvhq/sink-github`).

The `@penv` org and the unscoped `penv` name are both taken on npm, so packages publish under `@penvhq`. The umbrella `penv` stays private/unpublished; the CLI ships from `@penvhq/cli` (which now provides the `penv` bin) and the runtime from `@penvhq/runtime`. The whole set is a fixed version group, so this one changeset bumps them together.
