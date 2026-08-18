---
"@penvhq/launcher": patch
"@penvhq/cli": patch
---

The launcher's engine pin is taken from the registry, not predicted. Tarball bytes proved
non-reproducible across packers and machines — 0.9.1 and 0.9.2 both pinned bytes npm does not
hold, and the release's own verification refused them. The release now publishes the engine
first, reads back the integrity npm recorded, and only then builds and publishes the launcher,
so the pin is true by construction.
