---
"@penvhq/cli": patch
"@penvhq/penv": patch
---

`penv init` now writes Bun's `bunfig.toml` for you when injection is enabled, not just the preload file. The preload script is inert until `bunfig.toml` registers it, so penv scaffolds both — the `preload` array and its `[test]` mirror — under the same rule as every seam: it writes a fresh `bunfig.toml`, but never overwrites one you already own (it prints where to add the entry instead).
