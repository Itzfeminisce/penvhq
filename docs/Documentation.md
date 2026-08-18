# penv documentation

Configuration that shares a data model with your production secret manager — so the local↔production translation stops being where secrets drift.

This is the reference for **penv as designed**: the complete system, every capability, nothing hidden. It describes what penv *is*. For what is available in which release, see the [roadmap](./Roadmap.md) — availability lives there and only there. For why penv is shaped this way, see [RFC-0001](./RFC.md).

> **Is penv for you?** penv is for teams already running (or about to run) a real secret manager who hand-maintain the translation between local `.env` and that provider. If you are a solo developer happy with `.env.example` and t3-env, penv is not aimed at you — those tools are faster for that job, and penv does not try to beat them at it. This is a permanent property of the design, not a gap.

---

## Contents

1. [Install](#install)
2. [Quickstart](#quickstart)
3. [Running your app](#running-your-app)
4. [How typing works](#how-typing-works)
5. [Concepts](#concepts)
6. [The parameter tree](#the-parameter-tree)
7. [Value resolution](#value-resolution)
8. [Meta files](#meta-files)
9. [Schema and types](#schema-and-types)
10. [Runtime API](#runtime-api)
11. [Deployment](#deployment)
12. [Configuration reference](#configuration-reference)
13. [Providers](#providers)
14. [Provider extensions](#provider-extensions)
15. [Projection providers](#projection-providers-github-actions-secrets)
16. [Encryption](#encryption)
17. [Rotation](#rotation)
18. [`penv doctor`](#penv-doctor)
19. [CLI reference](#cli-reference)
20. [Migrating and leaving](#migrating-and-leaving)
21. [Design tradeoffs](#design-tradeoffs)

---

## Install

penv is two programs, and you install exactly one of them yourself:

```bash
npm install -g @penvhq/launcher
```

That is the **launcher** — stable, and not the thing that runs your project. It carries a current **engine** of its own, which is what `penv init` runs: adoption happens before any project has pinned anything, so that one engine has to come with the install. Inside a project the launcher reads `.penv/state/manifest.json`, the committed file naming the exact engine and provider extensions the project pins, finds them in `$PENV_HOME`, verifies their integrity, and hands your command over. So CI runs the penv your repository pins, a newer launcher on your laptop changes nothing about your project, and `penv upgrade` is what moves the pin — together with the project's runtime dependency, never one without the other.

Your project gains exactly one penv dependency, written by `penv init`:

```json
{ "dependencies": { "@penvhq/penv": "<the version the manifest pins>" } }
```

That package is the typed `@env` surface and its validation helpers, and it is the only penv your application bundles. The engine your project pins and every provider extension live in `$PENV_HOME`, installed there by the launcher and never entering `package.json` — so a project that talks to Vault does not ship Vault's SDK to production.

There is one version to know: `penv --version` prints one line — the engine your project pins when you are inside a project.

## Quickstart

Adopting penv is one conversational command. It shows you what it found, asks what to adopt, and moves nothing until everything it needs has passed:

```
$ penv init

Found dotenv files. Which should penv adopt?

  [x] .env                      shared default
  [x] .env.local                local override
  [x] .env.development          development
  [x] .env.development.local    development-local
  [ ] .env.production           production

✓ Declared environment       development
✓ Generated penv.schema.ts   (draft schema — review it, it's yours)
✓ Generated .penv/env.ts     (loads the shape — yours to edit)
✓ Generated penv.config.ts   defaultEnvironment: "development"
✓ Added @env path alias to tsconfig.json
✓ Installed @penvhq/penv
✓ Imported 34 parameters
✓ Validated development
✓ Moved 4 dotenv files       .penv/state/rollback/dotenv/   (penv init undo restores them)

Done. Start your app with penv:

  penv run -- pnpm dev
```

Selecting an environment-scoped file is what *declares* that environment — `.env` alone declares nothing, and penv never invents `production` from a filename. The cutover is all or nothing: if any part of the preflight fails, no file moves, nothing is imported, and penv does not claim a partial migration. Changed your mind? `penv init undo` puts the original dotenv files back under their exact names.

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

## Running your app

`penv run` is how an adopted project starts. It resolves the parameter tree, validates it against your schema, builds a child environment it owns, and starts the exact command after `--`:

```bash
penv run -- pnpm dev
```

That is the whole daily form. `--source` defaults to the local project tree, and `--env` falls back to the `defaultEnvironment` your config declares, so the two flags you would otherwise retype all day are decisions your repository already recorded. A pipeline names both explicitly — see [Deployment](#deployment) for the CI form — because a deploy that relies on a default is one config edit away from shipping the wrong environment. The other source, `snapshot`, is always named out loud; no run ever resolves from a place nobody chose.

**The command after `--` is yours, untouched.** penv starts it as an opaque child process: argument boundaries, pipes, redirects, shell syntax, `predev`/`postdev` lifecycle hooks, exit code, and signals all belong to the child. penv never parses, rewrites, or emulates any of it, which is why `penv run --` works identically in front of a package-manager script, `node index.js`, a Python entrypoint, or a compiled binary.

**Wrap outside the script, not inside it.** `penv run -- pnpm dev` runs your package manager under penv, so `predev` and `postdev` see penv's environment too. Writing the wrapper *inside* a `package.json` script is supported and entirely yours to author, with one difference to know: a script's `pre*` and `post*` hooks run outside the script body, so they start before penv's environment exists. An outer wrapper meeting an in-script one is refused, naming both invocations, rather than nesting two owned environments.

**The child environment is penv's, deliberately.** Every schema-declared parameter is written to the child under its generated name — or *deleted* from the child when it is optional and absent, so a stale variable in your shell cannot stand in for a value penv resolved to nothing. Unrelated variables like `PATH` are left alone. penv's own key variables, provider credentials, and internal control variables are stripped before your command starts.

**`penv run` never contacts a provider.** It reads what is already materialised locally — the project tree, or a sealed artifact — and a missing materialisation is a named failure with the `penv pull` line to run, not an invitation to fetch. A remote provider being down is not a reason your application cannot start. The one exception is opt-in and never production: `penv run --watch -- pnpm dev` refreshes from the configured provider, preserves your `.local` overrides, validates the complete next state, and only then restarts the child — a failed pull or a failed validation leaves your running child exactly where it was.

Starting an adopted app *without* `penv run` fails at the first read, naming the missing parameter and printing the `penv run` line to use. An application that starts without penv is an application reading configuration nothing validated.

## Where penv sits next to a framework

A browser has no filesystem, and penv reads files. Frameworks bridge that gap by **substituting text at build time**: Next replaces the literal `process.env.NEXT_PUBLIC_API_URL` in your source with a string before it ships, and Vite does the same for `import.meta.env.VITE_*`. That substitution is why every tool in this space — penv included — asks you to write those reads out longhand: a build step can only replace text it can see.

So the division is:

- **Server code** — route handlers, server components, scripts, `next.config.ts` — reads `import { env } from "@env"`. This is penv's blessed path, and it is where secrets live.
- **Client code** reads whatever its framework inlines. penv feeds that by starting the build under `penv run`:

```bash
penv run -- next build
```

The build runs inside penv's child environment, so Next inlines `NEXT_PUBLIC_*` from your parameter tree exactly as it would from a `.env`. Your tree is the source of truth for both halves; only the delivery differs. `penv generate` is the other route, and the one deploy targets that read a `.env` file already expect.

Two more consumers read the same tree with no browser in sight: a third-party SDK that reads `process.env` directly — WorkOS, Prisma, NextAuth — which finds its variables already present, because `penv run` wrote every declared parameter into the child environment under its generated name; and tooling that runs outside your application entirely — a `drizzle.config.ts`, a `playwright.config.ts`, a CI script — which starts under `penv run --` like everything else, imports the schema *shape*, and reads only the keys it needs out of the environment penv handed it. That is four kinds of code, one schema, four deliveries. [One schema, many consumers](#one-schema-many-consumers) is the full treatment, including why the shape has to be importable without loading anything.

The framework's prefix is the boundary, and the framework enforces it: nothing without `NEXT_PUBLIC_` reaches a browser. penv's job there is to catch the case the framework cannot — a parameter your meta calls a secret whose *name* makes the framework publish it. Declare `publicPrefixes` and `penv doctor` reports it as a failure.

## How typing works

There is no magic and nothing is read from disk at compile time. The types come from your Zod schema, extracted with `z.infer`, and the loader is declared to return that inferred type. Here is the entire mechanism.

`penv init` scaffolds two small modules you own and edit — the *shape*, and a thin *loader* that wraps it:

```ts
// penv.schema.ts — the shape, at the project root beside penv.config.ts
import { z } from "zod";

// The shape — the one definition every consumer derives from. Import this (or
// z.infer<typeof schema>) for types and tooling; importing it never loads
// configuration.
export const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({ host: z.string(), password: z.string().optional() }),
  // ...
});

// Registers the schema's shape with penv's types (erased at runtime). This is
// what makes override keys in penv.config.ts autocomplete from this schema.
declare module "@penvhq/core" {
  interface PenvSchemaShape {
    readonly shape: z.infer<typeof schema>;
  }
}
```

```ts
// .penv/env.ts — the loader, which the @env alias resolves to
import { load } from "@penvhq/penv";
import { schema } from "../penv.schema.js";

export { schema };

// The loaded, validated values for the current environment. Import this in app
// code. Importing it loads configuration and throws (naming the parameter and
// environment) if anything required is missing or invalid.
export const env = load(schema);
```

The split is deliberate, and its full payoff is [One schema, many consumers](#one-schema-many-consumers): `penv.schema.ts` is *side-effect free*, so a test, a `drizzle.config.ts`, or a CI script can import the one schema for its type — or `pick` a subset of it — without loading and validating a whole environment. `.penv/env.ts` is the one module your application calls `load()` through.

`load` is generic:

```ts
function load<T extends z.ZodType>(schema: T, options?: LoadOptionsFor<T>): z.infer<T>;
```

Because `load` returns `z.infer<T>`, `env` is typed as exactly the shape of *your* schema, with autocomplete on every nested namespace. `z.infer` is evaluated entirely at compile time from the schema's structure — `z.url()` becomes `string`, `.optional()` becomes `| undefined`, nesting becomes nesting.

The `@env` alias is written into your `tsconfig.json` by `penv init` so the import is stable at any file depth:

```jsonc
{ "compilerOptions": { "paths": { "@env": [".penv/env.ts"] } } }
```

Two properties follow from this design, and both are intentional:

- **The type is only true because the value is validated at runtime.** `load` parses the environment `penv run` handed this process against the same schema before returning it, and throws on mismatch. Compile-time inference and runtime validation come from one schema, so the type you code against and the value you receive cannot diverge.
- **`penv.schema.ts` and `.penv/env.ts` are yours, never regenerated.** penv scaffolds each once. They are real files where the schema is visible and the loader call is explicit — not codegen that could drift from your intent. penv generates the *alias*, not the files.

## Concepts

**Parameters are first-class resources.** Each parameter is its own file with its own lifecycle, access boundary, and rotation path — not a line inside a shared file.

**The tree mirrors your provider.** A penv path like `redis/password` and a Vault path like `secret/production/redis/password` are two serializations of the same logical record `(environment, path, name)`. Because the shapes match, changing provider is a configuration change, not an application rewrite.

**One schema, everywhere.** A single schema — its shape in `penv.schema.ts`, loaded through `.penv/env.ts` — drives runtime validation *and* TypeScript inference. There is deliberately no per-environment schema — forking schemas per environment reintroduces the drift penv exists to remove.

**penv owns the translation, and makes it visible.** The mapping from a penv record to a provider path is explicit configuration, not magic. penv's value is that this translation is defined once, validated, and legible.

**Every store your config names is a provider, and what each one can do is declared, not guessed.** Your application reads none of them — it reads the environment `penv run` resolved for it, from the local tree or a sealed artifact. A record-holding provider is a system of record penv can read back, so `doctor` compares both copies value by value. A provider that declares it *withholds values* — GitHub Actions Secrets, whose API returns names but never a value, by design — gets the honest subset: `doctor` compares names and push times and says plainly that it cannot compare values. One question separates the two kinds, and the provider itself answers it: **can penv read the value back out?**

## The parameter tree

A penv project has three ownership zones, and the layout makes them visible: your files at the root, the loader you own once it is scaffolded, and everything penv manages under `.penv/state/`.

```
project-root/
├── package.json
├── penv.config.ts          # yours — environments, providers, name overrides
├── penv.schema.ts          # yours — the schema shape (side-effect free; import for types/tooling)
├── tsconfig.json           # contains the @env alias
└── .penv/
    ├── env.ts              # yours after scaffolding — loads the shape (import { env } from "@env")
    └── state/              # penv-managed
        ├── manifest.json           # committed — the exact engine and extensions this project pins
        ├── .gitignore              # committed — the safety boundary for everything below
        ├── extensions/
        │   └── provider-vault.d.ts # committed — type-only, no adapter code
        └── records/
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

`state/` means current state penv manages, never secret history — provider history stays provider-owned. Its `.gitignore` is one committed file that draws the whole boundary: structure, meta, the manifest, and the generated extension declarations are committed, because each is a decision worth reviewing in a pull request; every plaintext value, and the temporary rollback bundle `penv init` writes, never are. During an adoption `state/` also holds `cutover.json` and `rollback/dotenv/`, which `penv init undo` reads and `penv cleanup` removes.

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
# → resolves to .penv/state/records/database-url.production.enc
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

One schema, defined in `penv.schema.ts` (see [How typing works](#how-typing-works)):

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

### One schema, many consumers

The schema is split across two files on purpose, and the split is what makes the "one schema" claim hold past your own app code.

- **`penv.schema.ts`** — the *shape*, at the project root beside `penv.config.ts`. A `z.object` and a type registration, and nothing that loads: importing it (or `z.infer<typeof schema>`) reads the definition without touching configuration. This is the one representation every consumer derives from.
- **`.penv/env.ts`** — the *loader*. It imports the shape, re-exports it, and calls `load()`. It is the module the `@env` alias resolves to, so `import { env } from "@env"` is unchanged.

The shape has to be importable *without side effects*, and that is not a nicety — it is what keeps the schema single. A consumer that only wants the schema's structure must not be forced to load and validate a whole environment to get it: a test wants the type, a database migration tool wants one URL, and neither should have to reach the definition through a load. Put the `z.object` in a module that also calls `load()` and every importer pays for the load — so a tool reaching for the schema hand-writes a *second* `z.object` over the same store instead. That second definition is the drift penv exists to delete, rebuilt inside your own tooling.

**Four kinds of code read your configuration, and each derives from the one schema by a single rule:**

| Consumer | Reads | The rule |
|---|---|---|
| Your app code | `import { env } from "@env"` | Import `env` — loaded, validated, resolved for the current environment. |
| Third-party SDKs reading `process.env` | the variables `penv run` writes into the child environment | Declare the parameter; penv delivers it under its generated name. Don't hand-map names — the schema is the pin list. Where a platform starts the process instead of penv, `load(schema, { inject: true })` writes the same surface from inside it. |
| Client bundles the framework inlines | `NEXT_PUBLIC_*` / `VITE_*` | Name the parameter so it generates the prefixed variable; declare `publicPrefixes` so `doctor` guards it. |
| Tooling evaluated outside the app | the same child environment, started with `penv run -- <tool>` | Import `schema` from `penv.schema.ts` and `load(schema.pick({ ... }))` the keys you need — never a second `z.object`. |

**The tooling rule, stated once so it is unmissable: a tooling config never declares a shape.** It imports `schema` from `penv.schema.ts` and calls `load(schema.pick({ ... }))`, so a rename or a type change in the one schema breaks the tooling config *at compile time* instead of silently diverging. A `drizzle.config.ts`, a `playwright.config.ts`, a `vitest` setup file, a CI script — each runs outside your application's runtime, and each used to reach for `process.env` or re-declare the two fields it cared about. Both are seams; `pick` closes them. The tool is started the way your app is, `penv run -- drizzle-kit migrate`, so what it validates is the same child environment penv resolved once:

```ts
// drizzle.config.ts — evaluated by drizzle-kit under `penv run -- drizzle-kit migrate`
import { defineConfig } from "drizzle-kit";
import { load } from "@penvhq/penv";
import { schema } from "./penv.schema.js";

// The one schema, narrowed — not a second z.object. Rename or retype
// `migrationDatabaseUrl` in penv.schema.ts and this line stops compiling,
// rather than reading a variable that no longer exists. `.required()` lifts the
// schema's `.optional()` here, where migrations cannot run without the URL: the
// picked field is `string`, and `load` throws (naming the parameter) if it is
// absent — the same schema, tolerant in the app and strict in the tool.
const env = load(schema.pick({ migrationDatabaseUrl: true }).required());

export default defineConfig({
  schema: "./src/db/schema.ts",
  dbCredentials: { url: env.migrationDatabaseUrl },
});
```

**A tooling-only parameter is still declared in the one schema.** `migrationDatabaseUrl` above is the database *owner* URL — the privileged credential migrations run under, which the running application must never hold. It is consumed only by tooling and never set in a deployed app environment, but it is declared in `penv.schema.ts` as `.optional()`, because that is what puts it inside the one schema every command already knows:

```ts
export const schema = z.object({
  databaseUrl: z.url(),               // the app's least-privileged connection
  // The database owner URL, used only by migrations. Declared here — so `penv
  // fill`, `penv set`, and `penv doctor` all know it — but `.optional()`, so the
  // app's own load(schema) never requires it, and it is never set in a deployed
  // app environment.
  migrationDatabaseUrl: z.url().optional(),
});
```

Declaring it optional is the whole trick: `fill`, `set`, and `doctor` see one schema and prompt for, write, and diagnose the migration URL like any other parameter, while `load(schema)` in the running app tolerates its absence. Leave it *out* of the schema and it becomes a tooling-only key invisible to penv — the loose value the split exists to prevent.

**Where the shape lives.** `penv.schema.ts` sits at the project root, beside `penv.config.ts`, and that is where `penv init` scaffolds it; it is the recommended location and the shape stays there regardless of anything else. The loader, `.penv/env.ts`, is what `schemaFile` names, and it may move to wherever your framework keeps such modules — `src/env.ts` is common. A `.ts`/`.js` file that lands inside the records tree is diagnosed as a stray code module rather than misread as a value file: code and values do not share a directory, and one that appears there is a mistake worth naming.

### Name mapping

A deterministic default transform connects the three representations of a name, so the common case needs no configuration:

```
redis/password   (file path)
  → redis.password   (schema key / runtime access)
  → REDIS_PASSWORD   (generated .env)
```

Override individual names in `penv.config.ts` when a deploy target expects something else. Overrides are collision-checked — two parameters mapping to the same generated variable fail `penv validate`, so the round-trip never silently loses a value.

### Canonical parameter names

Value files are lower-case and hyphenated. A camelCase schema key like `databaseUrl` maps to the file `database-url` and the generated variable `DATABASE_URL` — the file name is the canonical form, and the schema key and env var are the two ends of the transform above. `penv set` and the `penv mv` destination refuse a non-canonical key rather than write a file no other command would find, pointing you at the canonical lower-case hyphenated name. `penv fill` and `penv validate` derive these names from the schema for you, so the round-trip from a camelCase key never asks you to spell its kebab file yourself.

## Runtime API

```ts
import { env } from "@env";       // blessed path — typed, validated, the environment `penv run` resolved

env.databaseUrl;
env.app.jwtSecret;
```

Importing `env` loads configuration eagerly and validates it, so invalid configuration fails at startup with a clear, parameter-named error — not later at first use. A required parameter that is missing or invalid throws then, naming the parameter and environment, so there is no separate assertion step to call at the point of use. Code that only needs the *type* imports `schema` (or `z.infer<typeof schema>`) instead, which does not trigger loading.

**What the bridge validates is the environment penv handed it.** `penv run` has already resolved the cascade, applied your name mappings, and built the child environment before your process existed, so `.penv/env.ts` reads that environment and checks it against the schema. It does not reopen the parameter tree, does not read an artifact, and never calls a provider — one resolution, done once, in the parent. That is why the same `env.ts` works unchanged whether the values came from your local tree or from a sealed artifact in a container, and why a process that was not started by penv has nothing to validate and says so.

The eager export never gets between the CLI and your schema. `penv validate` / `fill` / `doctor` evaluate `.penv/env.ts` only to read its `schema` export, and while they do, `load()` defers instead of resolving — so in a fresh project with no values yet, the module's own `export const env = load(schema)` cannot throw the schema out of reach, and `penv fill` sees exactly the parameters it should prompt for. The deferral exists only inside that one CLI read; application imports of `@env` are eager and fail-fast, always.

The schema module may also guard itself with `import "server-only"` — the Next.js pattern for a module that must never reach a client bundle. The CLI resolves that import the way a React Server environment would (its empty, no-throw variant), so the guard protects your app without blinding penv's own tooling.

When a load does not do what you expect, `PENV_DEBUG=1` makes it say so on stderr: the environment it read, how many parameters the injected environment delivered, and the variable each one arrived under. Which value file won is `penv run`'s question rather than the bridge's — `penv get <key> --explain` answers that one.

A `process.env`-populating compatibility form exists for adopting penv without changing existing code:

```ts
import "@penvhq/penv/config";              // populates process.env, dotenv-shaped
```

Like dotenv, this form must run before any module reads `process.env`. It is also schemaless — it never sees your schema, so it can neither validate nor be exclusive over what it writes. The typed `import { env } from "@env"` surface is the recommended path, has no ordering hazard, and is the one that validates.

## Deployment

Production has one question the local loop does not: how do an environment's values reach a machine that has no parameter tree, no provider credentials, and possibly no network at start? penv answers it two ways, chosen by who owns the process.

### Containers and VMs: a sealed artifact

Your pipeline builds one artifact per environment and release, and the release starts from it:

```text
penv pull  →  penv validate  →  penv artifact build  →  package or mount the artifact
```

```bash
penv pull --env production
penv validate --env production
penv artifact build --env production --out build/production.artifact
```

The runtime consumes it by path, with `PENV_SNAPSHOT` naming the artifact and CI naming everything else — the fully-qualified form of the command the daily loop shortens:

```bash
PENV_SNAPSHOT=/run/secrets/production.artifact \
  penv run --env production --source snapshot -- node server.js
```

**What the artifact is.** Canonical data, not application source: the final resolved non-local winner for every parameter your schema declares for that environment, sealed where your policy encrypts, plus the environment name, the engine and format it is compatible with, a non-secret digest of the delivery mappings it carries, and the identifier of the key source that opens it.

**What it never contains.** Provider configuration, provider credentials, key material, plaintext for a sealed value, `.local` values of any scope, or the fallback records that lost the cascade. The artifact carries the answer, not the reasoning.

**Where it lives.** Outside your source tree and outside Git — it is release-specific, and it is data your pipeline hands to a machine, not a file your repository carries. `penv doctor` reports an artifact found inside the repository as a finding, because a committed artifact is a value store that outlives the release it was built for.

**What happens before your process starts.** `penv run --source snapshot` checks the artifact whole before it opens anything: its format against the one this engine reads, its own delivery mappings against the digest it declares for them, its engine version against the running engine, and its environment against the one you asked for — then decrypts in memory and builds the child environment. Each mismatch is its own refusal, naming what is wrong and what to do about it, before your command runs. The digest is the artifact checked against itself rather than against your schema — a release container has no schema to check — so what it catches is an artifact edited after it was built. No source files, no provider adapters, and no network are involved: the artifact plus its key is the entire input.

### Managed serverless: the platform's own store

Vercel, Cloudflare, and their peers own the parent process and build your application themselves, so nothing penv could put in `dist` is loaded by anything — and configuration is often needed at *build* time, before any penv process could run. The correct mechanism there is the platform's own encrypted environment store, written before the build:

```bash
penv push --env production          # to the platform's environment store, via its provider extension
```

The platform then supplies `process.env` exactly as it always has, and your typed bridge validates that environment on the way in. This is delivery, not a fallback: an artifact placed in a build output does not make a platform read it, so penv does not pretend one is the serverless answer.

## Configuration reference

`penv.config.ts` lives at the project root, next to `package.json`.

```ts
import { defineConfig } from "@penvhq/penv";

export default defineConfig({
  environments: ["development", "staging", "production"],
  defaultEnvironment: "development",

  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    staging:     { type: "@penvhq/provider-vault", location: "secret/staging" },
    production:  { type: "@penvhq/provider-ssm",   location: "/prod/app" },
  },

  keys: {
    staging:    { source: "keychain", id: "staging" },
    production: { source: "env",      id: "prod" },
  },

  schemaFile: "src/env.ts",
  publicPrefixes: ["NEXT_PUBLIC_"],

  override: {
    "database-url": "DATABASE_URL",
  },
});
```

**What `penv init` writes here, and what it refuses to.** `init` reads your `package.json`, recognises your framework, and *proposes* — a schema next to your source, your framework's public prefix. You confirm, and what lands in this file is the decision, not the detection: there is no `framework` key, because a config that stored an identity would let penv reinterpret your project later. It records what you chose, so nothing shifts under you.

**The alias is not a key here**, because it already lives in the file that resolves it. `@env` is a `tsconfig.json` `paths` entry — TypeScript understands it, a bundler resolves it, and plain `node dist/index.js` does not, since `paths` is erased by the compiler. `#env` is a `package.json` `imports` entry, which Node resolves natively. `init` offers `#env` to a project already carrying an `imports` block and `@env` otherwise, `--alias` overrides, and either way the answer is recorded where it functions rather than copied here.

It will not invent `environments`. penv cannot observe your deployment topology — no `package.json` says whether you have a staging tier — so `init` asks, and an unanswered `init` writes an empty list and tells you so. An environment penv guessed is one that accepts writes for a tier that does not exist.

| Field | Meaning |
|---|---|
| `environments` | Whitelist of valid environment names. The only source of truth for what counts as an environment; segments are matched against this list, never inferred — including by `penv init`, which asks rather than inventing them. |
| `defaultEnvironment` | The environment a command uses when `--env` is absent. It must be one of `environments` — a declared decision, never inference from `NODE_ENV`, a branch, or a filename. `init` proposes `development` when it adopted the development cascade. CI names `--env` anyway. |
| `providers` | Per-environment backend — where an environment's values live, and what `penv pull` reads from. |
| `providers.*.type` | The provider package's fully-qualified name — `@penvhq/provider-vault`. The name is what `penv add @penvhq/provider-vault` records in the manifest and installs into the launcher's cache — never into your `package.json`. The filesystem tree and the mock ship with the engine; every other provider, including any third-party one, is added this way. Each package brings its own config types along through a committed type-only declaration, so your editor checks the entry against the provider's own definition without the adapter ever being importable from your app. |
| `providers.*.location` | The place inside the provider that penv maps your tree onto. The format is the provider's own — a Vault KV base path, a Kubernetes `namespace/secretName`, an SSM path prefix — and its package documents it; the field name never changes between providers. This explicit mapping is the translation penv owns on your behalf. |
| `schemaFile` | Where the *loader* module — the one that calls `load()`, re-exports the schema, and the `@env` alias resolves to — lives, relative to this config. Defaults to `.penv/env.ts`; `src/env.ts` is where most framework projects put it. The schema *shape* lives separately in `penv.schema.ts` at the project root (see [One schema, many consumers](#one-schema-many-consumers)). Both files are yours — penv scaffolds each once and never regenerates it. |
| `publicPrefixes` | The variable prefixes your framework inlines into its client bundle — `["NEXT_PUBLIC_"]`, `["VITE_"]`. penv does not enforce them; the framework already does. Declaring them is what lets `doctor` catch a secret whose name makes the framework publish it. |
| `keys` | Per-environment encryption key source. An environment with no entry has no key source, which is not the same as having no key: penv reports that it was never told where to look, rather than that the key is missing. |
| `keys.*.source` | `env` (read from `PENV_KEY_<ID>`, which is where a deploy exports the unwrapped KMS-derived key) or `keychain` (the OS keychain). A source penv does not recognise is an error, never a fallback to one it does. |
| `keys.*.id` | Names the key. It is written into every value file sealed under it, so it outlives any one machine — and cannot contain `:`. |
| `override` | Overrides the generated variable for a parameter, when a consumer demands a name the default transform would not produce (`"workos/redirect-uri": "NEXT_PUBLIC_WORKOS_REDIRECT_URI"`). One override bends the name for every consumer — `generate`, `push`, the ambient mirror. Collision-checked. Keys autocomplete from your schema and a typo is a compile error, because the scaffolded `penv.schema.ts` registers the schema's shape (`declare module "@penvhq/core" { interface PenvSchemaShape { readonly shape: z.infer<typeof schema> } }`) — a type-only line penv writes for you; a project without it keeps plain string keys. |

## Providers

The filesystem is one provider among several. Switching a provider is a config change — application code does not change:

```ts
staging: { type: "@penvhq/provider-filesystem" }
// →
staging: { type: "@penvhq/provider-vault", location: "secret/staging" }
```

penv maps its record `(production, redis, password)` onto the provider-side place (for Vault, `secret/production/redis/password`) using the `location` you declare. The mapping is explicit rather than inferred, so what penv sends where is always legible. The `env.stripe.secretKey` line in your code is identical whether that value came from a local file, Vault, or SSM.

### A provider is where the source of truth lives, not where the runtime reads

This is the load-bearing distinction, and everything else about providers follows from it.

A provider is the system of record for an environment's values. It is not something your application talks to at boot. `penv pull` materialises the parameter tree from the provider, `penv run` resolves that tree, and your application reads what `run` handed it:

```
vault:secret/production/redis/password
        │
        │  penv pull                     ← penv talks to the provider
        ▼
.penv/state/records/redis/password.production
        │
        │  penv run -- <command>         ← penv resolves and validates, once
        ▼
the child environment your command starts in
        │
        │  import { env } from "@env"    ← your app talks to that environment
        ▼
env.redis.password
```

The two halves are deliberately separate. Reading is always local, always synchronous, and identical for every provider — which is precisely what makes `load` able to return `z.infer<T>` rather than a promise, and what makes changing provider a configuration change rather than an application rewrite. Nothing in the resolution path branches on provider type, so there is no code path that Vault takes and the filesystem does not.

This is also how these providers are consumed in practice: the Vault Agent Injector writes files, the Secrets Store CSI driver mounts them, and External Secrets Operator syncs into Kubernetes Secrets. penv's tree is the same shape those tools already produce. `penv pull` is penv's own version of that step, for deploys that do not already have one.

The consequence, stated rather than hidden: a deploy must materialise before it starts — a `penv pull` in the pipeline, a tree something else mounted, or the sealed artifact of [Deployment](#deployment). penv does not fetch secrets for you at start time, and a tree that was never pulled resolves to whatever is on disk — which is what `penv doctor`'s drift check is for.

Supported providers: Filesystem, HashiCorp Vault, AWS SSM Parameter Store, Kubernetes Secrets, and GitHub Actions Secrets. The filesystem tree and the rehearsal mock ship with the engine; every other provider arrives as an extension — `penv add @penvhq/provider-vault` — and the `type` in your config is that package's name. See [Provider extensions](#provider-extensions).

A provider declares its **capabilities**, and penv reads them rather than guessing. Two axes: what the store *holds* — penv records verbatim, or a resolved projection of them — and whether its values can be *read back*. Vault, SSM, and Kubernetes hold records and read back; they satisfy the full record contract, with the filesystem provider as its reference implementation. GitHub Actions Secrets holds a projection and withholds values — see [Projection providers](#projection-providers-github-actions-secrets) below.

**Not every provider retains a previous value, and that is declared rather than assumed.** Rotation's grace window reads the previous value back from the provider, which Vault (KV v2) and AWS SSM support natively and Kubernetes Secrets do not support at all — a Secret is a current-state object with no history to read. A provider therefore declares whether it retains. `dual-valid` rotation requires one that does; `atomic-cutover` does not; and `penv doctor` tells you which of those an environment can perform rather than letting you discover it mid-rotation. This is the same asymmetry the filesystem has always had, and Kubernetes sits on the same side of it.

## Provider extensions

A provider your config names is an **extension**: code the launcher owns, not a dependency of your application.

```bash
penv add @penvhq/provider-vault
```

`add` resolves the exact version, records it in `.penv/state/manifest.json` with its integrity hash, installs it into the launcher's cache, writes a committed type-only declaration under `.penv/state/extensions/`, and offers — never assumes — the one-line edit to `penv.config.ts` and whatever onboarding step the provider declares (`penv cloud login`, for instance). Your `package.json` is untouched.

**The blessed path asks nothing.** An official `@penvhq/`-scoped extension verifies its provenance silently and installs. The trust ceremony exists for strangers, and only strangers pay it:

| Extension | What `add` requires |
|---|---|
| Official (`@penvhq/*`) | Nothing. Provenance is verified, the manifest records version and integrity, and you are asked only about the config edit. |
| Public third-party | A seven-day minimum package age. Adding a younger one takes an explicit override, which commits a trust block naming the publisher, the exact integrity, the timestamp, and your reason in your own words. |
| Private or custom | An explicit trust acknowledgement, recorded the same way. The registry URL is committed; credentials never are — your `.npmrc` owns those. |

`add` takes two flags and no others: `--registry <https-url>` names a private registry, which is what puts a package in the private tier, and `--trust-young` is the override for the seven-day age gate. Pin a version with `penv add <package>@<version>`; without one, `add` takes what `latest` points at and records the exact version it resolved.

**What a provider declares about itself.** Two optional fields in the extension's own `package.json`, under a `penv` key. `penv.types` names a self-contained declaration file inside the package — `add` commits its text as the type declaration, so your config entry is checked against the provider's own definition; a provider that ships none gets the open base shape under its package name. `penv.onboard` names the engine command that finishes setup — `"cloud login"` becomes the `penv cloud login` that `add` offers to run. A declaration reaching for any module other than `@penvhq/core` is refused rather than committed: it would resolve to nothing in a repository where the adapter is not installed.

**Integrity is not trust, and penv does not confuse the two.** A hash proves the bytes you install are the bytes that were published; it says nothing about what that code does. So an extension is loaded only for an explicit provider operation — `pull`, `push`, `doctor` against a live store — and never because an application started. When it runs, it receives the credentials its own configuration declares, not the environment of whoever invoked it. The declaration it contributes to your repository is types only: no adapter code, no credentials, no values, no key material.

## Projection providers (GitHub Actions Secrets)

Every store your config names is a provider, and `penv push` and `penv pull` work against all of them. What differs is what each store can honestly do, and the store says so itself — a declared capability, not a config key you learn:

```
           .penv/state/records/  ← the working copy
                       │
        penv push      │      penv push / penv pull
   ┌───────────────────┴───────────────────┐
   ▼                                       ▼▲
GitHub Actions Secrets                   Vault
(holds a projection,               (holds records,
 never returns a value)             reads back exactly)
```

GitHub Actions Secrets declares both limits, because its API forces them: it creates, updates, deletes, and lists secret *names*, and no endpoint returns a value. That is not a limitation penv works around — it is a fact the provider states (`holds: "projection"`, `readsValues: false`) and every command reads.

For a team whose CI holds its secrets, the whole flow is local-first: declare the provider —

```ts
providers: {
  production: { type: "@penvhq/provider-github", location: "acme/api" },
}
```

— then `penv push --production`, and CI has it. No copy/paste, no browser tab, no `.env` pasted into a settings form at 2am. Your local tree is the source of truth and GitHub receives a *projection* of it — resolved variable names, the same one-directional shape as `penv generate` writing a `.env`, pointed at CI instead of at disk. If the GitHub deployment environment does not exist yet, the push offers to create it and creates it only on your yes (`--yes` pre-approves for CI).

**What `penv pull` brings back.** Everything the store honestly has: the secret *names* come down as parameters with meta stubs, values stay absent — GitHub never returns one — and `penv validate` names every value you still need to fill. Pull the names, fill the values, and push the tree to any provider you like: that loop is also the migration path between stores.

**A one-shot push needs no config change.** `penv push -e production --destination @penvhq/provider-github --location acme/api` pushes once to a provider the config does not name, persisting nothing — the declared provider stays the system of record.

**What the push carries, and what it deliberately does not.** `penv push` resolves each parameter as CI would see it, which means **both `.local` scopes are skipped**. A `database-url.production.local` is your machine's override; pushing it would make one developer's laptop the source of production's secret, which is the scope-widening leak penv exists to delete. The rule is the same one the `test` environment already follows.

Your environment scope maps to a GitHub *environment* secret of the same name, and the unscoped default maps to a *repository* secret. That is not a flattening penv invented and hopes holds: GitHub resolves environment secrets over repository secrets, which is penv's own cascade expressed in the destination's native mechanism.

**Encryption stops at the boundary, stated rather than implied.** A CI runner holds no penv key, so `.enc` values are decrypted locally and pushed as plaintext for GitHub to re-seal under its own key. penv does not offer to push its key alongside them, because a key stored beside the values it protects buys nothing over plaintext. penv's encryption protects your local tree; GitHub's custody takes over at the push.

**Names are checked before anything is sent.** GitHub reserves the `GITHUB_` prefix, refuses a leading digit, and allows only `[A-Za-z0-9_]` — so a parameter named `githubToken` cannot be pushed, and penv says so before writing a single secret rather than sixty in. A push is all or nothing, for the same reason an import is.

### What `doctor` can and cannot tell you about a value-withholding provider

A store you can only half-see is still legible, as long as the half you cannot see says so. `penv doctor` reports three different kinds of certainty against a provider that declares `readsValues: false`, and they never wear the same glyph:

| | |
|---|---|
| **Names** | Exact. Listing them is the one read GitHub allows, so "declared but never pushed" and "in GitHub but not declared here" are definite findings. |
| **Manual edits** | Detected, indirectly. GitHub reports when each secret was last updated; penv records when it last pushed. A GitHub copy newer than penv's push means someone edited it by hand — the seam this provider exists to close, caught without reading a value. A warning rather than a failure: it detects that something was touched, not that the values differ. |
| **Values** | **Unknown, permanently.** penv cannot read a GitHub secret back, so it can never tell you the two copies agree. `doctor` reports this as `unknown` — its own verdict, never a ✓. A check that did not look must never look like a check that looked and found nothing wrong. |

Against a record-holding provider none of this hedging applies: `doctor` reads both copies and compares them value by value, exactly.

## Encryption

Each parameter encrypts independently — the `.enc` terminal marker denotes an encrypted value file at any scope, so rotating one secret never means re-encrypting unrelated ones.

Whether a parameter *must* be encrypted is a **policy** declared in its meta, and the on-disk `.enc` marker is validated against that policy. The filename is not the sole authority on what is secret, which is what lets `penv doctor` catch a secret parameter that has a committed *plaintext* value file for some environment.

Encryption keys are provider-backed: the OS keychain locally, and KMS-derived keys in CI and production. Keys are never stored repo-adjacent. Each environment declares where its key lives:

```ts
export default defineConfig({
  environments: ["development", "production"],
  providers: { development: { type: "@penvhq/provider-filesystem" }, production: { type: "@penvhq/provider-filesystem" } },
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
⚠ Edited outside penv       DATABASE_URL        github's copy is newer than penv's last push
? Value drift               github              not checked — secrets cannot be read back
✓ Provider                  vault
✓ Destination               @penvhq/provider-github · acme/api
  penv set redis/password --env production
  penv set app/api-key --env production
```

**Four verdicts, not three.** `✓` is a check that looked and found nothing wrong. `⚠` is a check that looked and found something. `?` is a check that **could not look** — and it is deliberately not a `✓`. penv cannot read a GitHub Actions secret back, so it can never tell you your CI values match your tree; saying so in words, in its own glyph, is the only honest report available. A check that did not run must never be indistinguishable from a check that passed. The same verdict covers a browser check with no `publicPrefixes` declared, and any check a failed schema load made impossible.

**The browser check is the one nothing else can make.** To your framework, `NEXT_PUBLIC_` *is* the intent — it inlines the value into every page and cannot know you consider it a secret. Your app's own env module cannot know either. penv holds the policy and the name at once, which is the only vantage point from which the contradiction is visible. It needs `publicPrefixes` declared; without it penv says it could not check, rather than reporting a clean run it never made.

Every warning names the parameter and the concrete problem. The full `.penv/` tree is the payoff for teams who want to act on what doctor finds — not a precondition for reading the report.

**Schema↔tree drift, both directions.** `Declared, no value` and `Unused parameter` are the two halves of one distance: what your schema declares that the tree has no value for, and what the tree holds that the schema never declares. `penv watch` reports the same two, live, while you edit. Where a value would close the gap, the `penv set` lines are collected below the report to paste.

Reporting is all it does. penv will not materialise a value file from a declaration, because a declaration has no value — inventing one is how a placeholder reaches production silently, which is the failure penv exists to delete. `penv set` stays the only thing that writes a value.

`doctor`'s cross-provider drift check needs to know how local names map to provider paths; that correspondence comes from `penv.config.ts`.

**Against a value-withholding provider, drift is partial and says so.** A record-holding provider can be read back, so `Drifted from provider` is a definite finding: penv compared two values and they differ. A store that never returns a value cannot offer that certainty, and penv does not pretend otherwise — it reports the names exactly, catches a secret edited by hand outside penv by comparing timestamps, and marks value drift `?`. That is less than records give you, and it is stated rather than papered over. See [Projection providers](#projection-providers-github-actions-secrets) for what each tier can and cannot claim.

## CLI reference

| Command | Purpose |
|---|---|
| `penv init` | Adopt a project: detect dotenv files, declare environments, draft the schema, install the runtime dependency, import, validate, and move the prior dotenv files into one rollback bundle. All or nothing. `--yes` sets up `development` on the filesystem provider and nothing else. |
| `penv init undo` | Restore the dotenv files the last cutover moved, under their exact names. |
| `penv cleanup` | Close a finished migration — removes the rollback bundle and its cutover state, and nothing else. |
| `penv run -- <command>` | Resolve, validate, and start `<command>` in a penv-owned child environment. `--source` defaults to `project`; `--env` falls back to `defaultEnvironment`; `--watch` opts into provider-backed restarts. |
| `penv migrate` | Convert a project written under an earlier layout to `.penv/state/`. Previews first, moves records on approval, leaves your schema, config, and loader byte-identical. |
| `penv add <package>[@<version>]` | Add a provider extension: record it in the manifest with its integrity, install it into the launcher's cache, generate its type declaration, offer the config edit and any onboarding step. `--registry <url>` for a private registry; `--trust-young` overrides the seven-day age gate. |
| `penv upgrade [version]` | Move the pinned engine and the project's `@penvhq/penv` dependency together. |
| `penv install` | Install the exact engine and extensions the manifest pins. The preinstall step for CI and production, which never download during a run. |
| `penv import <file>` | Import an existing dotenv file; it becomes the source of truth. The filename names the scope the values are written at (`.env.production` → `<name>.production`); `--env` names it for a file that doesn't, and contradicting the filename is an error. |
| `penv generate` | Write a standard `.env` artifact for deploy targets. |
| `penv pull` | Materialise the parameter tree for an environment from its provider. Supports `--env`. |
| `penv push` | Ship an environment's values to its provider. A record-holding destination receives the tree verbatim (sealed values stay sealed); a projection-holding one receives the resolved projection, both `.local` scopes skipped. `--destination`/`-d` and `--location`/`-l` push once elsewhere; `--yes` pre-approves creating a missing destination environment. Takes `--env <name>` or the environment as a bare flag (`--production`). |
| `penv get <key>` | Read a parameter. Supports `--env` and `--explain`. |
| `penv set <key>` | Update a parameter and push to the active provider. |
| `penv fill` | Prompt for each declared parameter the tree has no value for, deriving the value-file name from the schema so you never translate a camelCase key to its kebab file by hand. Supports `--env`. |
| `penv mv <from> <to>` | Rename a parameter, every scope and its meta at once. |
| `penv rotate <key>` | Rotate a parameter's value by the mechanism its meta declares; `--begin`/`--complete` open and close a dual-valid grace window. Supports `--env`. |
| `penv remove <key>` | Delete a parameter. |
| `penv list` | List parameters. |
| `penv encrypt` / `penv decrypt` | Encrypt / decrypt one parameter's value file at one scope. Both need `--env`. |
| `penv key create` | Generate a key for an environment. penv prints it and stores nothing. |
| `penv artifact build` | Build the sealed delivery artifact for one environment. `--env` is required — an artifact for whichever environment happened to be the default is a footgun — and `--out` names the path. |
| `penv validate` | Validate configuration against the schema; non-zero on failure. |
| `penv doctor` | Report drift, missing, unused, weak, fallback, plaintext-secret, encryption, and rotation issues. |
| `penv watch` | Re-validate whenever the parameter tree or `penv.config.ts` changes. Supports `--env`. |

`penv generate` writes plaintext, so it refuses an encrypted value unless you pass `--allow-decrypt`, and says how many secrets it unsealed when you do. The leaving guarantee below is why the flag exists rather than a refusal; the flag is why it is never a surprise.

## Migrating and leaving

**Adopting** is `penv init`, and it is a complete cutover: penv adopts the dotenv files you select, imports and validates them, and then moves the originals into an ignored rollback bundle so your framework cannot read two sources at once. A partial adoption is refused rather than half-performed — configuration coming from two places, with load order deciding, is the exact drift penv exists to remove. `penv import <file>` remains for bringing one more dotenv file into an adopted project.

After adoption the parameter tree is your source of truth and `.env` is generated. Editing a generated `.env` by hand and expecting penv to absorb the change is not supported — edit the tree and regenerate. This one-directional flow is deliberate: two-way sync would recreate the very drift penv removes. `penv run` refuses to start while a framework-active `.env`, `.env.local`, or `.env.<environment>` file has reappeared, so the second source cannot come back quietly; `.env.example` and its documentation siblings are excluded, because they configure nothing.

**Changing your mind, and closing the migration.** `penv init undo` restores the moved dotenv files under their exact names and returns the project to its pre-adoption shape. `penv cleanup` does the opposite — it removes the rollback bundle once you are staying. Until one of the two runs, the bundle is unresolved and a second adoption refuses, because two overlapping recoveries have no defined restore. The bundle is recovery for one migration, never a local version store.

**Moving an existing penv project forward.** `penv migrate` converts a project written under an earlier layout: it previews exactly what moves and what is created, converts on your approval, and leaves `penv.schema.ts`, `penv.config.ts`, and `.penv/env.ts` byte-identical. Running it twice is a no-op that says so. penv reads one layout, so an unmigrated project is refused by name rather than read two ways.

**What import carries across.** Every variable's key and value round-trips exactly. A comment sitting directly above a variable is a description of it, so it becomes that parameter's `description` in meta, and `generate` re-emits it as a comment — annotations survive in both directions. A comment attached to nothing in particular — a file header, or one separated from the next variable by a blank line — has no parameter to belong to; `import` reports how many it dropped rather than discarding them silently. Ordering is normalized: `generate` emits parameters in a deterministic sorted order rather than the source file's sequence, which makes generated output stable and diffable across machines.

**Committing safely.** `penv init` writes the `.gitignore` under `.penv/state/` so value files and the rollback bundle are ignored, while structure, meta, the manifest, and the extension declarations are committed. A committed plaintext secret is a `penv doctor` failure, not a soft warning.

**Leaving.** `penv generate` produces a working `.env` at any time, so you are never locked behind a proprietary store. Encrypted values are part of that guarantee rather than an exception to it: `penv generate --allow-decrypt` unseals them into the artifact, because a store you cannot leave with your own secrets is the thing penv exists not to be. The flag is there because unsealing a secret should be a moment you chose, not a side effect of a command you ran for another reason — and `generate` says how many it unsealed. Your `penv.schema.ts` is an ordinary Zod schema you own; the schema and its inferred types port to plain tooling without penv.

## Design tradeoffs

These are permanent properties of penv, stated plainly because they are part of what penv *is* — not gaps that a future release closes.

- **More files than a flat `.env`.** A `.penv/` tree with many parameters is harder to eyeball in one glance than a single file. This cost buys per-parameter access control and independent rotation, which a flat file structurally cannot offer.
- **Migration restructures your source of truth.** penv is not an additive layer; after import, `.penv/` is primary and `.env` is generated.
- **It does not beat t3-env on local dev speed.** That is a different job, well solved by tools that do less. penv competes on sharing a data model with production, not on raw onboarding speed.
- **An encrypted unscoped default requires the decrypt key for local dev.** See [Encryption](#encryption).
- **Access control is delegated, not reimplemented.** penv relies on provider-native ACLs rather than building its own permission system.

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.