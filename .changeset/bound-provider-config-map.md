---
"@penvhq/penv": minor
"@penvhq/launcher": minor
---

Committed provider declarations now bind.

**`@penvhq/penv` takes `@penvhq/core` as a real dependency.** A project still
declares one penv package; the graph below it is the resolver's business. This is
the whole of the fix, and it is a type-identity fix: `@penvhq/penv` bundled the
declaration types, so its `dist/index.d.ts` carried its own inlined copy of
`interface ProviderConfigMap` and imported nothing from `@penvhq/core`. Every
provider declaration `penv add` commits augments the map in module
`"@penvhq/core"` — so two interfaces shared a name, and the augmentation landed
on the one `defineConfig` never consulted.

The last release's claim that a misspelled Vercel target is a compile error was
false in the published artifact: `targets: { production: "producton" }` compiled
clean under `--strict`, an undeclared field on a provider entry compiled clean,
and no diagnostic pointed at the dead augmentation. It is true now.
`@penvhq/penv`'s declarations import the config types from `@penvhq/core`, and
core's runtime is external in both outputs rather than a second copy in the
bundle. Everything else `@penvhq/penv` uses is still bundled in.

The artifact smoke suite grew the three-way proof that would have caught it
before publishing: a packed `@penvhq/penv` and `@penvhq/core` installed into a
scratch project, and `tsc --noEmit --strict` over a `penv.config.ts` plus a
committed-style declaration — the well-typed config compiles, the typo fails, and
an undeclared field fails, which is what separates "bound" from "the map is still
empty".

**`penv add` no longer advises wiring up a provider the config already names.**
The unattended line printed *Add `type: "@penvhq/provider-vercel"` to an
environment in penv.config.ts* into repositories whose `production` had declared
exactly that for releases. It now names the environments already pointed and
advises only about the rest, or says nothing when there is nothing to advise.
