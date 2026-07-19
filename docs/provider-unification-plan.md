# Provider unification plan — everything is a provider (v0.7)

> **Status: active.** This is the working plan for the provider-unification milestone,
> decided 2026-07-19. It supersedes two RFC decisions — *A sink is a destination, not a
> provider* and *A sink is declared in `sinks`* — and the RFC is amended in the same
> change that adds this file, so the two documents never argue with each other. The
> [RFC](./RFC.md) owns *why* the new shapes are what they are; this file owns *how*
> they land, and in what order.

**One framing to carry through.** The sink was a correct observation wearing the wrong
interface. GitHub Actions Secrets genuinely cannot return a value, and that fact does
not go away because the config key does. What the deliberation found is that the
*user* never needed the vocabulary — a user has stores, and wants `push` and `pull` to
work against all of them. So the distinction moves from the config (a `sinks` key the
user must learn) into the contract (a capability the provider declares and penv reads).
The friction is deleted; the honesty is kept.

---

## The settled surface

Every item below was deliberated and approved on 2026-07-19.

1. **`sinks` is deleted.** One config key, `providers`. `@penvhq/sink-github` becomes
   `@penvhq/provider-github`. `penv push` and `penv pull` work against every provider.

2. **`providers.<env>.type` is the provider package's fully-qualified name** —
   `"@penvhq/provider-vault"`, `"@penvhq/provider-github"`, `"@acme/penv-provider-x"`.
   The name *is* the import specifier: no convention mapping, no `module` override
   field (it is deleted), third-party packages need no special casing. "Built-in"
   shrinks to "pre-installed": `@penvhq/provider-filesystem` (the local tree) and
   `@penvhq/provider-mock` ship with the CLI; Vault, SSM, Kubernetes, and GitHub are
   installed by the projects that use them.

3. **Provider config is fully typed, by declaration merging.** `@penvhq/core` declares
   an empty `ProviderConfigMap`; each provider package augments it under its own
   package name. `defineConfig` validates each `providers.<env>` entry against the
   augmented map: a known `type` gets exact field checking (unknown fields refused),
   an unknown `type` falls back to the base shape. The compile-time union is exactly
   the set of installed providers — the type error and the runtime `UNKNOWN_PROVIDER`
   error give the same remedy: install the package.

4. **`location` replaces `path` and `repo`** — one field name on every provider for
   "the place inside the provider that penv maps the tree onto." The *format* is the
   provider's own (Vault KV base path, GitHub `owner/repo`, Kubernetes
   `namespace/secretName`, SSM path prefix) and each provider's augmentation documents
   its format; the *name* never changes between providers.

5. **One provider per environment.** `pull` reads it, `push` writes it. Migrating a
   store is: point the config at the old provider, `pull`, point it at the new one,
   `push`. No arrays, no roles, no second key.

6. **One-shot push override.** `penv push -e production --destination
   @penvhq/provider-github --location acme/api` pushes to a provider the config does
   not name, without persisting anything — the declared provider stays the system of
   record. Flags: `--destination` / `--dest` / `-d`, `--location` / `-l`.

7. **What a store cannot do is a declared capability.** The provider contract gains a
   `capabilities` declaration with two axes:
   - `holds: "records" | "projection"` — whether `write` receives penv records
     verbatim (opaque envelope strings at every scope, meta as a sibling record) or a
     resolved projection (generated variable names, both `.local` scopes skipped,
     plaintext for the destination to re-seal). Vault/SSM/Kubernetes/filesystem hold
     records; GitHub holds a projection.
   - `readsValues: boolean` — whether stored values can be read back. GitHub's API
     returns names and timestamps, never values, so it declares `false`.

   Absent capabilities mean records-and-readable, so every existing provider is
   unchanged. The behavioural contract suite runs against record-holding providers
   exactly as before — **no suite edits**; a projection provider is a different
   declared kind with its own, smaller suite, not a loosened contract.

8. **Pull from a value-withholding provider materialises what it honestly can.** Names
   and meta come down; values stay absent locally; `penv validate` reports which
   parameters still need values; the user fills them and can push anywhere. A pull
   that cannot fetch values says so — it never fakes emptiness as freshness.

9. **Create-if-missing, prompted.** A push whose target does not exist (a GitHub
   environment not yet created) surfaces a typed `MISSING_TARGET` error; the CLI —
   never the provider, which stays non-interactive — prompts to create it and calls
   the provider's optional `ensureTarget(environment)`. `--yes` pre-approves for CI;
   non-interactive without `--yes` fails with the exact remedy spelled out.

10. **Environment shorthand flags.** Any whitelisted environment works as a bare flag:
    `penv pull --production`. Three rules keep it safe: real flags always win (a
    colliding environment name loses the shorthand and `doctor` warns); passing two
    environment flags is a hard error, never first-wins; `--env` remains the
    canonical, always-working form. Shorthands are resolved after parse against the
    loaded config's whitelist, so config can never rebind a real flag.

---

## Build order

Two PRs, both breaking, released together as **0.5.0** on npm (the roadmap milestone
is v0.7; npm versions and roadmap milestones have never been the same series).

### PR A — the provider surface: fully-qualified ids, typed config, install-what-you-use

No behaviour of push/pull/sinks changes here; this PR rebuilds the ground the
unification stands on.

1. **Core types.** `ProviderConfigMap` (empty, augmentable) + `BaseProviderConfig`
   (`type`, optional `location`, open fields for third-party providers). `path` and
   `module` are deleted from `ProviderConfig`. `defineConfig` gains the generic
   validation that gives known types exact checking and unknown types the base shape.
2. **Config validation.** `providers.<env>.type` must be a package specifier
   (scoped or bare, as npm defines them); the error for a short name (`"vault"`)
   names the fix (`"@penvhq/provider-vault"`).
3. **Registry.** The built-in map keys become package names and shrink to
   `@penvhq/provider-filesystem` + `@penvhq/provider-mock`. Everything else resolves
   by importing `type` from the project's own `node_modules` — the plugin path that
   already exists, minus the convention mapping. The CLI's dependencies on
   `@penvhq/provider-vault`, `-ssm`, `-kubernetes` are removed.
4. **Provider packages.** Each externalised provider gains the plugin entry point
   (`penvProviderFactory`), takes over its own option mapping from the registry
   (the Kubernetes `namespace/name` split, the Vault/SSM `location` default), and
   ships its `ProviderConfigMap` augmentation.
5. **Docs.** `provider-contract.md`'s `ProviderConfig` section and
   `Documentation.md`'s config reference updated to the new surface.

**Gate.** Flipping an environment between `@penvhq/provider-filesystem` and an
installed `@penvhq/provider-vault` still requires zero application edits; a config
naming an uninstalled provider is refused at open time with the install command; a
known provider's config rejects unknown fields at compile time; the contract suite
passes for every provider package unchanged.

### PR B — the unification: sinks die, push/pull go universal

1. **Contract.** `capabilities` on `Provider` (absent = records + readable);
   optional `ensureTarget(environment)`; typed `MISSING_TARGET` error.
2. **`@penvhq/provider-github`** replaces `@penvhq/sink-github`: same `gh`-backed
   transport, same name grammar and pre-push checks, now shaped as a provider
   declaring `{ holds: "projection", readsValues: false }`. Its projection suite
   covers what the contract suite cannot ask of it.
3. **`push`** works against every provider: records mirrored verbatim to a
   record-holding provider; the resolved projection (exactly today's sink semantics,
   `--allow-decrypt` included) to a projection-holding one. `--destination`/`--location`
   for the one-shot override. `ensureTarget` prompting, `--yes`.
4. **`pull`** works against every provider: values from a readable provider (today's
   behaviour); names + meta, values left absent, from a value-withholding one, with
   `validate` closing the loop.
5. **`sinks` deleted end to end** — core `SinkConfig`/`sinks.ts`, config parsing,
   `doctor`'s sink section re-expressed over capabilities (the unknown-verdict
   machinery survives unchanged: it was always about what cannot be read, and
   `readsValues: false` is that fact's new spelling).
6. **Environment shorthand flags**, post-parse, with the three rules and the
   `doctor` collision warning.
7. **Docs.** `Documentation.md`'s Sinks chapter rewritten as provider capabilities;
   command reference updated for the new flags.

**Gate.** A project whose config declares `@penvhq/provider-github` can `push` (with
environment auto-created behind a prompt), `pull` names and meta, `validate` its way
to a filled tree, and `push` that tree to a freshly-declared
`@penvhq/provider-vault` — the full migration loop — with `doctor` reporting honestly
at every step: exact against Vault, name-level and `unknown` against GitHub.

---

## What this plan deliberately does not do

- **It does not soften the contract for the providers that can read.** The
  seven-method suite is untouched and still gates every record-holding provider. The
  RFC's old rejection — "widening the contract makes read optional for everyone" — is
  answered, not overruled: read is not optional, it is *absent by declaration* on a
  kind of provider that never claims the portability thesis.
- **It does not touch the runtime.** `load` stays synchronous, disk-backed, and
  provider-blind. Nothing here adds a network read to boot.
- **It does not add multi-provider environments.** One provider per environment was
  chosen over arrays; if the recurring vault-truth-plus-github-CI shape hurts in
  practice, the one-shot `--destination` push is the pressure valve, and arrays are a
  future deliberation, not a hedge shipped now.
