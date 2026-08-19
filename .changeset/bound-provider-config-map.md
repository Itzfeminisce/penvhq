---
"@penvhq/penv": minor
"@penvhq/launcher": minor
"@penvhq/cli": minor
---

Committed provider declarations now bind.

**`penv init` and `penv upgrade` declare `@penvhq/core` as a devDependency.**
This is the half without which nothing else works. `penv add` commits a
`declare module "@penvhq/core"` block, and TypeScript resolves that specifier
from the project's own files — so under pnpm's strict layout, where a transitive
dependency is not at the project root, the specifier resolves to nothing. An
augmentation whose module cannot be found is not an error: it silently degrades
to an *ambient* declaration, and no diagnostic anywhere says so. It is `dev`
because that is the whole of what it is — a type-only augmentation target that no
application code imports, so the one runtime dependency is still one. It joins
the plan under the same one consent, and a project that already declares it at
any version is left alone. An upgrade carries it into a project adopted before
it, which is the migration for every repository holding declarations today.

**`@penvhq/penv` takes `@penvhq/core` as a real dependency**, so the map it
holds config against is the one every provider is told to augment. It bundled
the declaration types, so its `dist/index.d.ts` carried its own inlined copy of
`interface ProviderConfigMap` and imported nothing from `@penvhq/core`: two
interfaces shared a name, and the augmentation landed on the one `defineConfig`
never consulted.

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
