---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/launcher": minor
"@penvhq/provider-vercel": minor
---

The workspace scan reaches `@penvhq/core`, and the Vercel declaration stops
claiming a check it cannot make.

**`penv upgrade` moves a workspace package's own `@penvhq/core`.** The scan that
correctly found a second `@penvhq/penv` below the root looked for `@penvhq/core`
only in the root it was writing to. A repository with two members declaring
`^0.8.0` came out of a 0.13.0 upgrade holding two copies of the interfaces every
committed provider declaration augments, five minor versions apart, under one
engine pin. Every `package.json` that declares either package now moves — in the
block that package chose, in its own step, under the same one consent — and the
diff names each file, so a member that would not typecheck against the newer core
is a decline away.

**The Vercel declaration's header no longer overclaims.** It said that writing
the real shape out is what stops "a misspelled target **and** a target keyed by
an environment that does not exist". The first half is true; the second could
never be, because `ProviderConfigMap["@penvhq/provider-vercel"]` is a fixed
interface with no access to the `environments` the config declares, and widening
the provider contract so one provider could see them is not a trade penv makes.
The provider refuses the key at construction instead, naming the offending key
and the environments the project declares, and the header says that. `penv add`
copies this declaration verbatim, so an already-adopted project gets the
corrected header the next time it adds the provider.

**An unknown field in a provider entry says which field and whose config.** The
whole diagnostic was `Type 'number' is not assignable to type 'never'` — the
right line and column, and nothing about why, beside a targets error in the same
file that lists all three legal values. The excess key now maps to a type whose
single member is the sentence, which TypeScript prints:
`"retries is not a field @penvhq/provider-vercel declares"`.

**Two honesty bugs in `penv upgrade`'s output.** The consent diff rendered the
`@penvhq/core` step as though it were creating a `devDependencies` block, into
root manifests that already had one with fourteen entries — the one
nesting-shorthand line in an otherwise literal `-`/`+` diff, and so the one a
reader would go and check by hand. An existing block now shows as the context it
is. And the closing `✓` lines confirmed both `@penvhq/penv` declarations and the
manifest pin while never mentioning `@penvhq/core`, the one change the previous
release introduced. They now name every package that landed, per file.
