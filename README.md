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
.penv/redis/password.production.enc   ⟷   secret/production/redis/password
        └─ how you store it locally         └─ how Vault stores it in prod
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

Already have a `.env`? Adoption is one command:

```bash
npm install penv
npx penv import .env
```

```
✓ Found 34 variables
✓ Created .penv/
✓ Generated .penv/env.ts       (schema + loader — yours to edit)
✓ Added @env alias to tsconfig.json
✓ Updated .gitignore
✓ Validated configuration

Done. .penv/ is now your source of truth.
```

Read values in code, fully typed — imported from your own project, no magic:

```ts
import { env } from "@env";

env.databaseUrl;         // string, validated at boot
env.redis.password;      // string | undefined (optional in your schema)
```

`@env` is an alias for `.penv/env.ts`, the one file `penv init` scaffolds and you own:

```ts
// .penv/env.ts
import { z } from "zod";
import { load } from "penv";

export const schema = z.object({ /* your config shape */ });
export const env = load(schema);   // typed z.infer<typeof schema>, validated at import
```

The types come from `z.infer` on your schema; the values are validated against that same schema at boot. One source, so the type you code against and the value you receive can't diverge. Generate a plain `.env` for deploy targets any time:

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

For what's *available when* — encryption, providers, rotation — see the [roadmap](./docs/Roadmap.md).

## Documentation

- **[Docs](./docs/Documentation.md)** — the complete reference to finished penv: concepts, resolution, schema, providers, encryption, rotation, CLI.
- **[RFC-0001](./docs/RFC.md)** — the story book: why penv is shaped this way, the alternatives weighed, the decisions and reasoning.
- **[Roadmap](./docs/Roadmap.md)** — the single source of truth for what's available in which release.

## Contributing

The highest-leverage contribution right now isn't code — it's signal. If you run a real secret manager and maintain the local↔production translation by hand, open an issue describing that pain. That's the demand question the roadmap can't answer from the inside.

For code: the provider contract (roadmap v0.4) is the highest-risk, highest-value surface. Start there, or with a `doctor` check.

## License

MIT

---

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.