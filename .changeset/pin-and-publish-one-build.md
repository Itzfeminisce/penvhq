---
"@penvhq/launcher": patch
"@penvhq/cli": patch
---

The 0.9.1 launcher pinned engine bytes npm does not hold — the release rebuilt between packing and
publishing, and the release's own verification caught it. Pack and publish now share one build:
the embed step packs the engine, rewrites the pin, rebuilds only the launcher, and publish uploads
the dist it packed.
