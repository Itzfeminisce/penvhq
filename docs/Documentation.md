# penv documentation

Configuration that shares a data model with your production secret manager — so the local↔production translation stops being where secrets drift.

This is the reference for **penv as designed**: the complete system, every capability, nothing hidden. It describes what penv *is*. For what is available in which release, see the [roadmap](./Roadmap.md) — availability lives there and only there. For why penv is shaped this way, see [RFC-0001](./RFC.md).

> **Is penv for you?** penv is for teams already running (or about to run) a real secret manager who hand-maintain the translation between local `.env` and that provider. If you are a solo developer happy with `.env.example` and t3-env, penv is not aimed at you — those tools are faster for that job, and penv does not try to beat them at it. This is a permanent property of the design, not a gap.

---

## Contents

1. [Install](#install)
2. [Quickstart](#quickstart)
3. [How typing works](#how-typing-works)
4. [Concepts](#concepts)
5. [The parameter tree](#the-parameter-tree)
6. [Value resolution](#value-resolution)
7. [Meta files](#meta-files)
8. [Schema and types](#schema-and-types)
9. [Runtime API](#runtime-api)
10. [Configuration reference](#configuration-reference)
11. [Providers](#providers)
12. [Encryption](#encryption)
13. [Rotation](#rotation)
14. [`penv doctor`](#penv-doctor)
15. [CLI reference](#cli-reference)
16. [Migrating and leaving](#migrating-and-leaving)
17. [Design tradeoffs](#design-tradeoffs)

---

## Install

```bash
npm install penv        # or bun add penv / pnpm add penv
```

## Quickstart

If you already have a `.env`, adopting penv is one command:

```
$ penv import .env

✓ Found 34 variables
✓ Created .penv/
✓ Generated .penv/env.ts       (schema + loader — yours to edit)
✓ Generated penv.config.ts
✓ Added @env path alias to tsconfig.json
✓ Updated .gitignore
✓ Created .env.backup
✓ Validated configuration

Done. .penv/ is now your source of truth.
```

Then read configuration anywhere your code runs on a server, fully typed:

```ts
import { env } from "@env";

env.databaseUrl;          // string
env.app.jwtSecret;        // string
```

Generate a flat `.env` for deploy targets that expect one, any time:

```bash
penv generate
```

## Where penv sits next to a framework

A browser has no filesystem, and penv reads files. Frameworks bridge that gap by **substituting text at build time**: Next replaces the literal `process.env.NEXT_PUBLIC_API_URL` in your source with a string before it ships, and Vite does the same for `import.meta.env.VITE_*`. That substitution is why every tool in this space — penv included — asks you to write those reads out longhand: a build step can only replace text it can see.

So the division is:

- **Server code** — route handlers, server components, scripts, `next.config.ts` — reads `import { env } from "@env"`. This is penv's blessed path, and it is where secrets live.
- **Client code** reads whatever its framework inlines. penv feeds that in one line:

```ts
// next.config.ts
import "penv/config";       // loads .penv/ into process.env before the build reads it
```

Next then inlines `NEXT_PUBLIC_*` from `.penv/` exactly as it would from a `.env`. Your parameter tree is the source of truth for both halves; only the delivery differs. `penv generate` is the other route, and the one deploy targets that read a `.env` file already expect.

The framework's prefix is the boundary, and the framework enforces it: nothing without `NEXT_PUBLIC_` reaches a browser. penv's job there is to catch the case the framework cannot — a parameter your meta calls a secret whose *name* makes the framework publish it. Declare `publicPrefixes` and `penv doctor` reports it as a failure.

## How typing works

There is no magic and nothing is read from disk at compile time. The types come from your Zod schema, extracted with `z.infer`, and the loader is declared to return that inferred type. Here is the entire mechanism.

`penv init` scaffolds one file — `.penv/env.ts` — which you own and edit:

```ts
// .penv/env.ts
import { z } from "zod";
import { load } from "penv";

// The shape. Import this (or z.infer<typeof schema>) when you only need the
// type — tests, tooling — so you don't trigger config loading.
export const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({ host: z.string(), password: z.string().optional() }),
  // ...
});

// The loaded, validated values for the current environment. Import this in app
// code. Importing it loads configuration and throws (naming the parameter and
// environment) if anything required is missing or invalid.
export const env = load(schema);
```

`load` is generic:

```ts
function load<T extends z.ZodType>(schema: T): z.infer<T>;
```

Because `load` returns `z.infer<T>`, `env` is typed as exactly the shape of *your* schema, with autocomplete on every nested namespace. `z.infer` is evaluated entirely at compile time from the schema's structure — `z.url()` becomes `string`, `.optional()` becomes `| undefined`, nesting becomes nesting.

The `@env` alias is written into your `tsconfig.json` by `penv init` so the import is stable at any file depth:

```jsonc
{ "compilerOptions": { "paths": { "@env": [".penv/env.ts"] } } }
```

Two properties follow from this design, and both are intentional:

- **The type is only true because the value is validated at runtime.** `load` parses the loaded values against the same schema before returning them and throws on mismatch. Compile-time inference and runtime validation come from one schema, so the type you code against and the value you receive cannot diverge.
- **`env.ts` is yours, never regenerated.** penv scaffolds it once. It is a real file where the schema is visible and the loader call is explicit — not codegen that could drift from your intent. penv generates the *alias*, not the file.

## Concepts

**Parameters are first-class resources.** Each parameter is its own file with its own lifecycle, access boundary, and rotation path — not a line inside a shared file.

**The tree mirrors your provider.** A penv path like `redis/password` and a Vault path like `secret/production/redis/password` are two serializations of the same logical record `(environment, path, name)`. Because the shapes match, changing provider is a configuration change, not an application rewrite.

**One schema, everywhere.** A single schema in `.penv/env.ts` drives runtime validation *and* TypeScript inference. There is deliberately no per-environment schema — forking schemas per environment reintroduces the drift penv exists to remove.

**penv owns the translation, and makes it visible.** The mapping from a penv record to a provider path is explicit configuration, not magic. penv's value is that this translation is defined once, validated, and legible.

## The parameter tree

```
project-root/
├── package.json
├── penv.config.ts          # environments, providers, name overrides
├── tsconfig.json           # contains the @env alias
└── .penv/
    ├── env.ts              # schema + loader (import { env } from "@env")
    │
    ├── database-url                    # unscoped default value
    ├── database-url.production.enc     # production override, encrypted
    ├── database-url.json               # per-parameter meta
    │
    ├── app/
    │   ├── jwt-secret.development
    │   ├── jwt-secret.production.enc
    │   └── jwt-secret.json
    │
    └── redis/
        ├── host.production
        ├── password.production.enc
        └── password.json
```

Each value file holds exactly one value. Each parameter has at most one meta file.

### Filename grammar

Value files use the same precedence convention you already know from `.env.local` / `.env.production` / `.env`, expressed one parameter at a time:

```
<namespace>/<name>                    value — unscoped default
<namespace>/<name>.<env>              value — environment-specific
<namespace>/<name>.local              value — personal override (gitignored)
<namespace>/<name>.<env>.local        value — personal override for one environment (gitignored)
```

The scope segments read in the same order as the dotenv filenames they mirror: `<name>.production.local` is `.env.production.local`. The environment always precedes `local` — `<name>.local.production` is an error, not a synonym.

Any value file may be encrypted by appending `.enc` as the terminal marker, at any scope:

```
<namespace>/<name>.enc
<namespace>/<name>.<env>.enc
<namespace>/<name>.local.enc
<namespace>/<name>.<env>.local.enc
```

`.enc` is always last; the scope segments always precede it. `<name>.enc.production` is an error, not a synonym. Meta files are always plaintext and are never encrypted.

Meta files carry one supported extension per parameter:

```
<namespace>/<name>.json         # also .toml or .yml
```

### Reserved names

Filenames are split on `.`, so every declared environment name plus `enc`, `json`, `toml`, `yml`, and `local` are reserved tokens. A parameter or environment whose name collides with a reserved token is a `penv validate` error, never a silent misparse. This is why `local` cannot itself be an environment name: `.local` already means "personal override, on this machine only" at every scope, and an environment called `local` would make `<name>.local` ambiguous. Personal overrides are the mechanism that covers that ground. Pick one meta format per project and stay consistent — mixing formats is flagged by `penv doctor`.

## Value resolution

penv resolves each parameter using the same precedence order frameworks like Next.js and Vite use for `.env` files, applied per parameter. Highest precedence first:

```
<name>.<env>.local  personal override, for one environment only — gitignored
<name>.local        personal override, every environment — gitignored
<name>.<env>        the environment-specific value
<name>              the unscoped default
```

These are the four levels you already know, one parameter at a time: they are `.env.[mode].local`, `.env.local`, `.env.[mode]`, and `.env` respectively. If you understand why `.env.development.local` beats `.env.local` beats `.env.development` beats `.env`, you understand penv's value resolution — that correspondence is the point, so penv keeps all four rather than a subset.

Most-specific scope wins. This is flat override, not merging — a value file holds one opaque value, and a more specific scope *replaces* a less specific one wholesale. `.enc` is orthogonal: it describes how a value is stored, not its precedence, so an encrypted value competes for precedence exactly as its plaintext equivalent would.

**Both `.local` scopes are skipped in the `test` environment**, so tests are reproducible and never pick up a developer's personal overrides — matching the convention frameworks already use.

**Fallback is never silent.** Any parameter resolving via the unscoped default for a real environment is reported by `penv doctor`, so a production value quietly coming from a shared default cannot hide. Ask penv which file wins at any time:

```bash
penv get database-url --env production --explain
# → resolves to .penv/database-url.production.enc
```

## Meta files

A meta file carries lifecycle and policy for one parameter across all environments. It holds no value.

```json
{
  "description": "Signs and verifies user session JWTs",
  "owner": "auth-team",
  "rotationPolicy": "90d",
  "environments": {
    "production": { "required": true, "rotationPolicy": "30d", "owner": "infra-team" },
    "staging": { "required": true }
  }
}
```

**Meta merges hierarchically, base then environment, shallow.** An environment block overrides the base object per top-level key and inherits every key it does not declare. In the example, production's effective meta is `description` inherited from base, `owner` and `rotationPolicy` overridden by the production block. This is flat, per-key override — nested objects are replaced wholesale, not deep-merged, so the effective meta for any environment is computed by reading exactly two objects: the base and that environment. `.local` does not participate in meta merging; personal overrides are a value concern, and policy is a property of the shared parameter.

Absence of an environment key means "optional by default" — there is no need to restate every environment.

## Schema and types

One schema, defined in `.penv/env.ts` (see [How typing works](#how-typing-works)):

```ts
export const schema = z.object({
  databaseUrl: z.url(),
  jwtSecret: z.string().min(32),
  redis: z.object({
    host: z.string(),
    password: z.string().optional(),
  }),
});
```

`penv validate` loads the target environment's parameters, builds the config object, checks it against the schema, prints diagnostics, and exits non-zero on failure. A passing `penv validate` means the schema is *internally consistent* — it does not mean the schema is *correct*. Correctness is your review, especially after an inferred import, where the generated schema is a draft: single-sample inference cannot know that a boolean seen as `true` must also accept `1`/`0`.

Per-environment schema forking is an anti-pattern: it silently reintroduces the drift penv exists to prevent. There is one schema.

### Name mapping

A deterministic default transform connects the three representations of a name, so the common case needs no configuration:

```
redis/password   (file path)
  → redis.password   (schema key / runtime access)
  → REDIS_PASSWORD   (generated .env)
```

Override individual names in `penv.config.ts` when a deploy target expects something else. Overrides are collision-checked — two parameters mapping to the same generated variable fail `penv validate`, so the round-trip never silently loses a value.

## Runtime API

```ts
import { env } from "@env";       // blessed path — typed, validated, resolved for NODE_ENV

env.databaseUrl;
env.app.jwtSecret;
```

Importing `env` loads configuration eagerly and validates it, so invalid configuration fails at startup with a clear, parameter-named error — not later at first use. A required parameter that is missing or invalid throws then, naming the parameter and environment, so there is no separate assertion step to call at the point of use. Code that only needs the *type* imports `schema` (or `z.infer<typeof schema>`) instead, which does not trigger loading.

A `process.env`-populating compatibility form exists for adopting penv without changing existing code:

```ts
import "penv/config";              // populates process.env, dotenv-shaped
```

Like dotenv, this form must run before any module reads `process.env`. The typed `import { env } from "@env"` surface is the recommended path and has no ordering hazard.

## Configuration reference

`penv.config.ts` lives at the project root, next to `package.json`.

```ts
import { defineConfig } from "penv";

export default defineConfig({
  environments: ["development", "staging", "production"],

  providers: {
    development: { type: "filesystem" },
    staging:     { type: "vault",   path: "secret/staging" },
    production:  { type: "aws-ssm", path: "/prod/app" },
  },

  keys: {
    staging:    { source: "keychain", id: "staging" },
    production: { source: "env",      id: "prod" },
  },

  schemaFile: "src/env.ts",
  publicPrefixes: ["NEXT_PUBLIC_"],

  names: {
    "database-url": "DATABASE_URL",
  },
});
```

**What `penv init` writes here, and what it refuses to.** `init` reads your `package.json`, recognises your framework, and *proposes* — a schema next to your source, your framework's public prefix. You confirm, and what lands in this file is the decision, not the detection: there is no `framework` key, because a config that stored an identity would let penv reinterpret your project later. It records what you chose, so nothing shifts under you.

It will not invent `environments`. penv cannot observe your deployment topology — no `package.json` says whether you have a staging tier — so `init` asks, and an unanswered `init` writes an empty list and tells you so. An environment penv guessed is one that accepts writes for a tier that does not exist.

| Field | Meaning |
|---|---|
| `environments` | Whitelist of valid environment names. The only source of truth for what counts as an environment; segments are matched against this list, never inferred — including by `penv init`, which asks rather than inventing them. |
| `providers` | Per-environment backend. |
| `providers.*.path` | The provider-side base path penv maps records onto. This explicit mapping is the translation penv owns on your behalf. |
| `schemaFile` | Where the module exporting the schema lives, relative to this config. Defaults to `.penv/env.ts`; `src/env.ts` is where most framework projects put it. The file is yours either way — penv scaffolds it once and never regenerates it. |
| `publicPrefixes` | The variable prefixes your framework inlines into its client bundle — `["NEXT_PUBLIC_"]`, `["VITE_"]`. penv does not enforce them; the framework already does. Declaring them is what lets `doctor` catch a secret whose name makes the framework publish it. |
| `keys` | Per-environment encryption key source. An environment with no entry has no key source, which is not the same as having no key: penv reports that it was never told where to look, rather than that the key is missing. |
| `keys.*.source` | `env` (read from `PENV_KEY_<ID>`, which is where a deploy exports the unwrapped KMS-derived key) or `keychain` (the OS keychain). A source penv does not recognise is an error, never a fallback to one it does. |
| `keys.*.id` | Names the key. It is written into every value file sealed under it, so it outlives any one machine — and cannot contain `:`. |
| `names` | Overrides the default name transform for generated `.env` output. Collision-checked. |

## Providers

The filesystem is one provider among several. Switching a provider is a config change — application code does not change:

```ts
staging: { type: "filesystem" }
// →
staging: { type: "vault", path: "secret/staging" }
```

penv maps its record `(production, redis, password)` onto the provider's path (for Vault, `secret/production/redis/password`) using the `path` you declare. The mapping is explicit rather than inferred, so what penv sends where is always legible. The `env.stripe.secretKey` line in your code is identical whether that value came from a local file, Vault, or SSM.

### A provider is where the source of truth lives, not where the runtime reads

This is the load-bearing distinction, and everything else about providers follows from it.

A provider is the system of record for an environment's values. It is not something your application talks to at boot. `penv pull` materialises the parameter tree from the provider, and the runtime reads that tree:

```
vault:secret/production/redis/password
        │
        │  penv pull          ← penv talks to the provider
        ▼
.penv/redis/password.production
        │
        │  import { env } from "@env"    ← your app talks to the tree
        ▼
env.redis.password
```

The two halves are deliberately separate. Reading is always local, always synchronous, and identical for every provider — which is precisely what makes `load` able to return `z.infer<T>` rather than a promise, and what makes changing provider a configuration change rather than an application rewrite. Nothing in the resolution path branches on provider type, so there is no code path that Vault takes and the filesystem does not.

This is also how these providers are consumed in practice: the Vault Agent Injector writes files, the Secrets Store CSI driver mounts them, and External Secrets Operator syncs into Kubernetes Secrets. penv's tree is the same shape those tools already produce. `penv pull` is penv's own version of that step, for deploys that do not already have one.

The consequence, stated rather than hidden: a deploy must pull before it starts, or mount a tree something else has already materialised. penv does not fetch secrets for you at import time, and a tree that was never pulled resolves to whatever is on disk — which is what `penv doctor`'s drift check is for.

Supported providers: Filesystem, HashiCorp Vault, AWS SSM Parameter Store, Kubernetes Secrets, Azure Key Vault, Google Secret Manager, Cloudflare Secrets. All satisfy one provider contract; the filesystem provider is the reference implementation of that contract.

## Encryption

Each parameter encrypts independently — the `.enc` terminal marker denotes an encrypted value file at any scope, so rotating one secret never means re-encrypting unrelated ones.

Whether a parameter *must* be encrypted is a **policy** declared in its meta, and the on-disk `.enc` marker is validated against that policy. The filename is not the sole authority on what is secret, which is what lets `penv doctor` catch a secret parameter that has a committed *plaintext* value file for some environment.

Encryption keys are provider-backed: the OS keychain locally, and KMS-derived keys in CI and production. Keys are never stored repo-adjacent. Each environment declares where its key lives:

```ts
export default defineConfig({
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
  keys: { production: { source: "env", id: "prod" } },
});
```

`penv key create --env production` mints a key of the right shape and prints it; penv stores no copy, because the only places it could put one are the places a key must never be. Anything sealed under a key is unreadable without it.

**Which command seals what.** `penv set` reads the policy and seals when it says to, so there is no `--encrypt` flag — a flag would make the command line the authority on what is secret, which is the inversion this section's second paragraph forbids. `penv encrypt` and `penv decrypt` exist for the two moments the policy cannot handle on its own: adopting a tree that already has plaintext values when `secret: true` is added, and re-sealing a value file after a rename or a change of scope. `penv decrypt` refuses a parameter meta declares secret — penv does not ship a command whose purpose is to fail its own check.

**A sealed value is bound to the file it lives in.** Copying `db-password.production.enc` over `db-password.enc` does not promote a production secret to the default every environment falls back to; it produces a file that will not open, even with the right key. This is why a value file that moves scope must be re-sealed at its new address.

**"penv cannot read this" is never reported as "this is not set".** They are opposite situations with opposite remedies — one wants `penv set`, the other wants your key — and answering the first with the second would tell you to overwrite a secret you still have. `penv get` names the file and the reason; `doctor` reports it as an encryption failure; `validate` reports it as itself rather than as a schema violation.

Note one consequence of encrypting the unscoped default (`<name>.enc`): because the unscoped default doubles as the local-dev value, a developer must hold the decrypt key to run locally. Encrypting per-environment values (`<name>.production.enc`) while leaving the default plaintext avoids this; choose the scope of encryption accordingly.

## Rotation

penv distinguishes two rotation modes, which are distinct mechanisms and are never conflated:

**`dual-valid`** — old and new values are both accepted during a `gracePeriod`. For JWT secrets, API keys, webhook secrets, where outstanding tokens and in-flight requests still carry the old value.

```
active → rotating (current + previous both valid) → active (previous retired after grace)
```

**`atomic-cutover`** — no simultaneous validity at the app layer; an immediate flip. For database passwords and Redis auth. Any real overlap belongs at the infrastructure layer (e.g. RDS-managed credential overlap), not in penv.

### Where rotation state lives

The local value file is *always the current value*. `penv set` overwrites it and pushes to the provider; the provider keeps the previous value for the grace window, because the provider is the only place a previous value is read. Rotation phase lives in meta, never in filenames — so the value tree never changes shape mid-rotation and the single schema stays intact. There is deliberately no `.current`/`.previous` value-filename suffix.

Because dual validity is a property of a live system, filesystem-backed environments (typically `development`) cannot exercise true dual-valid rotation; rehearse rotation flows locally with a mock provider.

### Rotation meta fields

```json
{
  "rotationPolicy": "90d",
  "environments": {
    "production": {
      "required": true,
      "rotationMode": "dual-valid",
      "rotationStrategy": "generated",
      "gracePeriod": "24h",
      "rotationState": "active",
      "lastRotated": "2026-07-01T00:00:00Z",
      "rotatingSince": null
    }
  }
}
```

| Field | Meaning |
|---|---|
| `rotationPolicy` | How often the secret should rotate. |
| `rotationMode` | `dual-valid` or `atomic-cutover`. |
| `rotationStrategy` | `generated` (penv creates the new value) or `external` (supplied by a human/system). |
| `gracePeriod` | For `dual-valid`: how long both values stay accepted. |
| `lastRotated` | Timestamp of the last *completed* rotation. |
| `rotatingSince` | Timestamp of the current `active → rotating` transition. A distinct clock from `lastRotated`. |
| `rotationState` | `active` \| `rotating` \| `retired`. |

`penv doctor` checks two independent conditions: **overdue** (`now - lastRotated > rotationPolicy`) and **stuck** (`now - rotatingSince > stuckThreshold`, for `dual-valid` only). They use different clocks on purpose — `lastRotated` cannot tell you how long a rotation has been stuck in flight, which is why `rotatingSince` exists. `atomic-cutover` has no rotating window at the penv layer and is never flagged as stuck.

Access control (who may read a production secret) is proxied through provider-native ACLs (Vault policies, IAM). penv does not reimplement what providers already do well.

## `penv doctor`

Point `doctor` at your local config and a live provider; it produces one report of everything that has drifted:

```
$ penv doctor

✓ Schema valid
⚠ Missing parameter         redis.password      required for production, absent
⚠ Declared, no value        app.api-key         declared in .penv/env.ts, no value for production
⚠ Weak secret               app.jwt-secret      18 chars, schema requires ≥32
⚠ Unused parameter          LEGACY_API_KEY      present, not in schema
⚠ Drifted from provider     stripe.secret-key   local ≠ vault:secret/production
⚠ Unscoped fallback in use  api-url             production resolving to default
⚠ Plaintext secret          db-password.staging value file is not encrypted
⚠ Undecryptable value       redis/password.production.enc PENV_KEY_PROD is not set
⚠ Secret exposed to browser NEXT_PUBLIC_STRIPE_KEY meta declares this a secret, and the prefix makes it public
✓ Provider                  vault
  penv set redis/password --env production
  penv set app/api-key --env production
```

**The browser check is the one nothing else can make.** To your framework, `NEXT_PUBLIC_` *is* the intent — it inlines the value into every page and cannot know you consider it a secret. Your app's own env module cannot know either. penv holds the policy and the name at once, which is the only vantage point from which the contradiction is visible. It needs `publicPrefixes` declared; without it penv says it could not check, rather than reporting a clean run it never made.

Every warning names the parameter and the concrete problem. The full `.penv/` tree is the payoff for teams who want to act on what doctor finds — not a precondition for reading the report.

**Schema↔tree drift, both directions.** `Declared, no value` and `Unused parameter` are the two halves of one distance: what `.penv/env.ts` declares that the tree has no value for, and what the tree holds that the schema never declares. `penv watch` reports the same two, live, while you edit. Where a value would close the gap, the `penv set` lines are collected below the report to paste.

Reporting is all it does. penv will not materialise a value file from a declaration, because a declaration has no value — inventing one is how a placeholder reaches production silently, which is the failure penv exists to delete. `penv set` stays the only thing that writes a value.

`doctor`'s cross-provider drift check needs to know how local names map to provider paths; that correspondence comes from `penv.config.ts`.

## CLI reference

| Command | Purpose |
|---|---|
| `penv init` | Initialize a project (`.penv/`, `env.ts`, config, `@env` alias, gitignore). |
| `penv import <file>` | Import an existing dotenv file; it becomes the source of truth. The filename names the scope the values are written at (`.env.production` → `<name>.production`); `--env` names it for a file that doesn't, and contradicting the filename is an error. |
| `penv generate` | Write a standard `.env` artifact for deploy targets. |
| `penv pull` | Materialise the parameter tree for an environment from its provider. Supports `--env`. |
| `penv get <key>` | Read a parameter. Supports `--env` and `--explain`. |
| `penv set <key>` | Update a parameter and push to the active provider. |
| `penv remove <key>` | Delete a parameter. |
| `penv list` | List parameters. |
| `penv encrypt` / `penv decrypt` | Encrypt / decrypt one parameter's value file at one scope. Both need `--env`. |
| `penv key create` | Generate a key for an environment. penv prints it and stores nothing. |
| `penv validate` | Validate configuration against the schema; non-zero on failure. |
| `penv doctor` | Report drift, missing, unused, weak, fallback, plaintext-secret, encryption, and rotation issues. |

`penv generate` writes plaintext, so it refuses an encrypted value unless you pass `--allow-decrypt`, and says how many secrets it unsealed when you do. The leaving guarantee below is why the flag exists rather than a refusal; the flag is why it is never a surprise.

## Migrating and leaving

**Adopting** is `penv import .env`. After it runs, `.penv/` is your source of truth and `.env` is generated. Editing the generated `.env` by hand and expecting penv to absorb the change is not supported — edit in `.penv/` and regenerate. This one-directional flow is deliberate: two-way sync would recreate the very drift penv removes.

**What import carries across.** Every variable's key and value round-trips exactly. A comment sitting directly above a variable is a description of it, so it becomes that parameter's `description` in meta, and `generate` re-emits it as a comment — annotations survive in both directions. A comment attached to nothing in particular — a file header, or one separated from the next variable by a blank line — has no parameter to belong to; `import` reports how many it dropped rather than discarding them silently. Ordering is normalized: `generate` emits parameters in a deterministic sorted order rather than the source file's sequence, which makes generated output stable and diffable across machines.

**Committing safely.** `penv init` and `penv import` write a `.gitignore` so value files are ignored and only structure, `env.ts`, meta, and config are committed. A committed plaintext secret is a `penv doctor` failure, not a soft warning.

**Leaving.** `penv generate` produces a working `.env` at any time, so you are never locked behind a proprietary store. Encrypted values are part of that guarantee rather than an exception to it: `penv generate --allow-decrypt` unseals them into the artifact, because a store you cannot leave with your own secrets is the thing penv exists not to be. The flag is there because unsealing a secret should be a moment you chose, not a side effect of a command you ran for another reason — and `generate` says how many it unsealed. Your `.penv/env.ts` is an ordinary Zod schema you own; the schema and its inferred types port to plain tooling without penv.

## Design tradeoffs

These are permanent properties of penv, stated plainly because they are part of what penv *is* — not gaps that a future release closes.

- **More files than a flat `.env`.** A `.penv/` tree with many parameters is harder to eyeball in one glance than a single file. This cost buys per-parameter access control and independent rotation, which a flat file structurally cannot offer.
- **Migration restructures your source of truth.** penv is not an additive layer; after import, `.penv/` is primary and `.env` is generated.
- **It does not beat t3-env on local dev speed.** That is a different job, well solved by tools that do less. penv competes on sharing a data model with production, not on raw onboarding speed.
- **An encrypted unscoped default requires the decrypt key for local dev.** See [Encryption](#encryption).
- **Access control is delegated, not reimplemented.** penv relies on provider-native ACLs rather than building its own permission system.

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.