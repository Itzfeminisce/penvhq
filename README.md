<h1 align="center">penv</h1>

<p align="center">
  <strong>Configuration that shares a data model with your production secret manager.</strong><br>
  So the local↔production translation stops being where secrets drift, leak, and get rotated wrong.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#is-penv-for-you">Is it for you?</a> ·
  <a href="./docs/Documentation.md">Docs</a> ·
  <a href="./docs/RFC.md">RFC</a> ·
  <a href="./docs/Roadmap.md">Roadmap</a>
</p>

---

`penv` stores each parameter as its own file, in a hierarchy that mirrors how Vault, AWS SSM, and Kubernetes Secrets already store the same data. One [Zod](https://zod.dev) schema gives you both runtime validation and TypeScript types. `penv doctor` tells you where your local config has drifted from your provider.

```
.penv/state/records/redis/password.production.enc   ⟷   secret/production/redis/password
        └─ how you store it locally                     └─ how Vault stores it in prod
```

Those are two serializations of the same record. Because the shapes match, **switching provider is a config change, not an application rewrite** — and the translation between them stops being a script someone wrote under deploy pressure.

> **Docs describe finished penv; the [roadmap](./docs/Roadmap.md) says what's shippable today.** This README and the docs describe the complete system. For what's available in which release, the roadmap is the single source of truth.

## What penv is — and isn't

**penv is not** the fastest way to read `process.env` in TypeScript. [t3-env](https://github.com/t3-oss/t3-env) is, and it wins that job *structurally* — by doing less. If a single `.env` and t3-env make you happy, use them. We mean it.

**penv is** the only configuration layer where your local environment and your production secret manager share a data model — instead of two systems you keep in sync by hand. That hand-maintained seam is the real risk surface: a key renamed in Vault but not locally, a stale `.env.example`, a staging secret pasted into a prod deploy at 2am. penv's job is to delete it.

That's the whole pitch. It's narrow on purpose.

## Is penv for you?

**Yes, if** you already run (or are about to run) a real secret manager — Vault, AWS SSM, Kubernetes Secrets — and you hand-translate between a local `.env` and that provider, and you've felt the drift.

**No, if** you're a solo dev or small project happy with `.env.example`. That's a smaller, well-solved problem, and penv would cost you more than it returns.

## Quickstart

Install the launcher once, then adopt your project in one command:

```bash
npm install -g penv
penv init
```

```
Found dotenv files. Which should penv adopt?

  [x] .env                      shared default
  [x] .env.local                local override
  [x] .env.development          development
  [ ] .env.production           production

✓ Declared environment       development
✓ Generated penv.schema.ts   (draft schema — review it, it's yours)
✓ Generated .penv/env.ts     (loads the shape — yours to edit)
✓ Added @env alias to tsconfig.json
✓ Installed @penvhq/penv
✓ Imported 34 parameters
✓ Validated development
✓ Moved 3 dotenv files       .penv/state/rollback/dotenv/   (penv init undo restores them)
```

Adoption is all or nothing — if anything in the preflight fails, no file moves and penv says so — and `penv init undo` puts your dotenv files back under their exact names. Then start your app under penv:

```bash
penv run -- pnpm dev
```

`penv run` resolves your tree, validates it against your schema, and starts the exact command after `--` as an ordinary child process — your pipes, your `pre`/`post` hooks, your exit code. It never calls a provider, so a secret manager being down is not a reason your app can't start. `penv pull` is the explicit step that fetches; production reads a sealed artifact your CI built.

The global `penv` is a small launcher: your project commits the exact engine and provider versions it pins, so CI runs what your repository says, and a newer penv on your laptop changes nothing. Your `package.json` gains exactly one dependency — `@penvhq/penv`, the typed `@env` surface.

Read values in code, fully typed — imported from your own project, no magic:

```ts
import { env } from "@env";

env.databaseUrl;         // string, validated at boot
env.redis.password;      // string | undefined (optional in your schema)
```

`penv init` scaffolds two modules you own: `penv.schema.ts` — the *shape*, side-effect free, so tests and tooling can import it without loading anything — and `.penv/env.ts`, the thin loader `@env` resolves to:

```ts
// penv.schema.ts — the shape, at the project root
import { z } from "zod";

export const schema = z.object({ /* your config shape */ });
```

```ts
// .penv/env.ts — the loader
import { load } from "@penvhq/penv";
import { schema } from "../penv.schema.js";

export { schema };
export const env = load(schema);   // typed z.infer<typeof schema>, validated at import
```

The types come from `z.infer` on your schema; the values are validated against that same schema at boot. One source, so the type you code against and the value you receive can't diverge — and because the shape imports without side effects, a `drizzle.config.ts` or CI script started with `penv run -- drizzle-kit migrate` loads `schema.pick({ … })` from the *same* schema instead of hand-writing a second one. Generate a plain `.env` for deploy targets any time:

```bash
npx penv generate
```

## The five-minute value moment

You don't have to restructure anything to get value on day one. Point `doctor` at your existing provider and local config:

```
$ penv doctor

✓ Schema valid
⚠ Missing parameter         redis.password      required for production, absent
⚠ Weak secret               app.jwt-secret      18 chars, schema requires ≥32
⚠ Unused parameter          LEGACY_API_KEY      present, not in schema
⚠ Drifted from provider     stripe.secret-key   local ≠ vault:secret/production
⚠ Plaintext secret          db-password.staging value file is not encrypted
✓ Provider                  vault
```

Restructuring into the full `.penv/` tree is the payoff for teams who want to *fix* what doctor finds — not a precondition for reading the report.

## Design tradeoffs (permanent, not gaps)

We'd rather state these than let you discover them. They're properties of finished penv, not things a release closes:

- **More files than a flat `.env`** — the cost of per-parameter access control and independent rotation, which a flat file structurally can't offer.
- **Migration restructures your source of truth** — it's not an additive layer. After `import`, `.penv/` is primary and `.env` is generated. Reversible via `penv generate`, but not invisible.
- **Doesn't beat t3-env on local speed** — different job, and it doesn't try to.
- **An encrypted unscoped default needs the decrypt key for local dev** — encrypt per-environment values instead if that's a problem.
- **Deploys need one pipeline step** — a `penv pull`, a mounted tree, or a sealed artifact your CI builds. Nothing in your repository carries production's values, which is the point and also the work.

For what's *available when* — encryption, providers, rotation — see the [roadmap](./docs/Roadmap.md).

## Documentation

- **[Docs](./docs/Documentation.md)** — the complete reference to finished penv: concepts, resolution, schema, providers, encryption, rotation, CLI.
- **[RFC-0001](./docs/RFC.md)** — the story book: why penv is shaped this way, the alternatives weighed, the decisions and reasoning.
- **[Roadmap](./docs/Roadmap.md)** — the single source of truth for what's available in which release.

## Contributing

The highest-leverage contribution right now isn't code — it's signal. If you run a real secret manager and maintain the local↔production translation by hand, open an issue describing that pain. That's the demand question the roadmap can't answer from the inside.

For code: the developer-first rebuild (roadmap v0.9) is where the work is — the launcher, the `penv run` contract, and sealed delivery artifacts. Start there, or with a `doctor` check.

## License

MIT

---

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.