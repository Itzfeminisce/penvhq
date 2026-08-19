---
"@penvhq/provider-kubernetes": minor
"@penvhq/provider-vercel": minor
"@penvhq/provider-github": minor
"@penvhq/provider-vault": minor
"@penvhq/provider-ssm": minor
"@penvhq/launcher": minor
"@penvhq/core": minor
"@penvhq/cli": patch
---

Published provider extensions install and load.

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
