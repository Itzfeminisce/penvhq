---
"penv": minor
---

**New:** adopting a project now leaves the manifest that makes it a project.

After `penv init` or `penv migrate` succeeds in a directory that has none, the launcher writes `.penv/state/manifest.json` pinning the exact engine that just ran — its version and the npm integrity of its tarball, which the launcher carries from release time because adoption never touches the network. Extensions start empty; `penv add` fills them in. A manifest that is already there is never rewritten, and a command that failed, or that only previewed, leaves nothing behind.

`penv migrate` now runs outside a project, which is where a project on the old layout is: the manifest is the marker, and that is the file it did not have yet.
