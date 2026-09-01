---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
"@penvhq/launcher": minor
"@penvhq/runtime": minor
"@penvhq/provider-filesystem": minor
"@penvhq/provider-mock": minor
"@penvhq/provider-vault": minor
"@penvhq/provider-ssm": minor
"@penvhq/provider-kubernetes": minor
"@penvhq/provider-github": minor
"@penvhq/provider-vercel": minor
"@penvhq/provider-contract": minor
---

One `environments` record holds each environment's whole declaration, and every
provider gets its own vocabulary back.

**Three top-level structures become one.** `environments: string[]`, `providers`,
and `keys` all described the same thing — what an environment *is* — from three
places, so reading one environment meant reading three. They merge into
`environments: Record<string, string | EnvironmentEntry>`, whose entry names the
provider that holds the environment, the fields that provider declares, and the
`keySource` that seals it. The record's keys are still the whitelist: a key is a
declaration, not an inference, so nothing about how an environment name is
recognised has moved. An environment whose provider needs no fields is written as
the package name alone — `development: "@penvhq/provider-filesystem"`.

**`location` is deleted, and each provider takes its own field names.** One generic
address field meant five stores answering to penv's word instead of their own:
`location` for what Vercel calls a project, for what Vault and SSM call a path, for
a `namespace/secretName` pair Kubernetes keeps as two separate facts. Entries now
read like the store's own documentation — Vercel's `project` and `teamId`, Vault's
and SSM's `path`, Kubernetes' `secret` and `namespace`, GitHub's `repository` —
typed by each package's committed declaration, so a field a provider does not
declare is a compile error rather than a silently ignored key. `type` becomes
`provider` for the same reason: the value was always a package name.

**Vercel's `targets` record becomes a singular `target`, defaulting to the
environment's own name.** A per-environment entry only ever mapped one environment,
so `targets: { production: "production" }` restated its own key back at itself. A
`production` environment now needs nothing; a `staging` environment declares
`target: "preview"`, because Vercel has no staging target and a guess between
production and preview is a guess about which deployment reads the secret. An
environment that is neither a Vercel target nor carrying an explicit one is refused
at construction, naming both remedies.

**Keys move into the entry they belong to, byte-compatibly.** `keys.<env>` becomes
`keySource`, and its id defaults to the environment's name — so `keySource: "env"`
on `production` is exactly the old `{ source: "env", id: "production" }`, seals
under the same `PENV_KEY_PRODUCTION`, and stamps artifacts with the same
`env:production` identifier. A config migrated one-for-one produces identical
artifact bytes. The object form is still there for a rotation that gives the key a
name of its own. Nothing about key resolution changed: an unrecognised or
unavailable source still refuses rather than falling back.

**One migration error teaches the whole move, and there is no compat shim.** A
config whose `environments` is an array, or that carries a top-level `providers` or
`keys` key, fails at load with `CONFIG_ENVIRONMENTS_MERGED` before anything else is
reported, because every other complaint would be a consequence of the same one
fact. The message names each move — `type` to `provider`, `location` to the field
the provider declares, `targets` to `target`, `keys.<env>` to `keySource` — and
prints the old entry beside its rewrite, so the fix is a copy rather than a
reading. Every remedy string that used to teach the old shape teaches the new one.

**`penv push --destination` and `--location` are gone.** They let a push land
somewhere the config never declared, which is a seam of exactly the kind penv
exists to close, and with provider-specific field names there is no generic slot
left for a place. A push goes to the provider its environment's entry declares, and
`NO_DESTINATION` teaches the config edit — the same edit ongoing use needs anyway.

The provider contract is untouched. Field names are config surface; `capabilities`,
`holds`, `readsValues`, and the shared contract suite are the same for every
provider as they were.
