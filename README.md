<h1 align="center">penv</h1>

<p align="center">
  <strong>Configuration that shares a data model with your production secret manager.</strong><br>
  So the local↔production translation stops being where secrets drift, leak, and get rotated wrong.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#is-penv-for-you">Is it for you?</a> ·
  <a href="./penv-docs.md">Docs</a> ·
  <a href="./RFC-0001-penv.md">RFC</a> ·
  <a href="./penv-roadmap.md">Roadmap</a>
</p>

---

`penv` stores each parameter as its own file, in a hierarchy that mirrors how Vault, AWS SSM, and Kubernetes Secrets already store the same data. One [Zod](https://zod.dev) schema gives you both runtime validation and TypeScript types. `penv doctor` tells you where your local config has drifted from your provider.

```
.penv/redis/password.production.enc   ⟷   secret/production/redis/password
        └─ how you store it locally         └─ how Vault stores it in prod
```

Those are two serializations of the same record. Because the shapes match, **switching provider is a config change, not an application rewrite** — and the translation between them stops being a script someone wrote under deploy pressure.

---

## What penv is — and isn't

**penv is not** the fastest way to read `process.env` in TypeScript. [t3-env](https://github.com/t3-oss/t3-env) is, and it wins that job *structurally* — it wins by doing less, and no amount of work on penv changes that. If a single `.env` and t3-env make you happy, use them. We mean it.

**penv is** the only configuration layer where your local environment and your production secret manager share a data model — instead of two systems you keep in sync by hand. That hand-maintained seam is the actual risk surface: a key renamed in Vault but not locally, a stale `.env.example`, a staging secret pasted into a prod deploy at 2am. penv's job is to delete it.

That's the whole pitch. It's narrow on purpose.

## Is penv for you?

**Yes, if** you already run (or are about to run) a real secret manager — Vault, AWS SSM, Kubernetes Secrets — and you currently hand-translate between a local `.env` and that provider, and you've felt the drift.

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
✓ Generated penv.config.ts
✓ Generated .penv/schema.ts   (draft — review it)
✓ Updated .gitignore
✓ Created .env.backup
✓ Validated configuration

Done. .penv/ is now your source of truth.
```

Then two things:

```bash
npx penv doctor        # what's missing, weak, unused, or drifted from your provider
```

…and open `.penv/schema.ts` to tighten the inferred schema — it's a starting point, not a guarantee.

Read values in code, fully typed:

```ts
import { env } from "penv";

env.databaseUrl;         // typed, inferred from your schema
env.app.jwtSecret;       // nested, matching your namespaces
env.require("jwt-secret"); // throws a clear error if absent
```

Generate a plain `.env` for deploy targets that expect one, any time:

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

## What it looks like

```
project-root/
├── penv.config.ts          # environments, providers, name overrides
└── .penv/
    ├── schema.ts           # one Zod schema — runtime validation + types
    ├── database-url
    ├── database-url.production.enc
    ├── database-url.json   # per-parameter meta (owner, rotation policy…)
    ├── app/
    │   ├── jwt-secret.production.enc
    │   └── jwt-secret.json
    └── redis/
        ├── password.production.enc
        └── password.json
```

Each value file holds one value. Nothing is a proprietary database — it's all inspectable with `ls` and `cat`.

## CLI

| Command | Does |
|---|---|
| `penv init` | Initialize a project |
| `penv import <file>` | Import an existing `.env`; it becomes the source of truth |
| `penv generate` | Write a standard `.env` for deploy targets |
| `penv get` / `set` / `remove` / `list` | Manage parameters |
| `penv encrypt` / `decrypt` | Encrypt/decrypt individual parameters |
| `penv validate` | Check config against the schema |
| `penv doctor` | Report drift, missing, unused, weak, plaintext, and rotation issues |

Full reference in the [docs](./penv-docs.md).

## Honest limitations

We'd rather say these plainly than let you discover them.

- **More files than a flat `.env`** — a real cost, accepted because it's what buys per-parameter access control and independent rotation. A flat file structurally can't offer those.
- **Migration restructures your source of truth** — it's not an additive layer. After `import`, `.penv/` is primary and `.env` is generated. Reversible, but not invisible.
- **Early encryption is organizational, not cryptographic** — until keys are provider-backed (OS keychain / KMS, never repo-adjacent), penv doesn't improve on `.env` security. That milestone is on the [roadmap](./penv-roadmap.md).
- **Provider portability is being proven, not assumed** — the "config change, not a rewrite" claim is validated against Vault first, then generalized. Until then, treat other providers as roadmap items.

## Status

Pre-1.0 and sequenced by which risk each milestone retires — see the [roadmap](./penv-roadmap.md). The pivotal milestone is **v0.4**, where the Vault adapter proves provider portability is real. Everything before it is buildable from the settled design; that one claim stays a promise until v0.4 ships.

## Documentation

- **[Docs](./penv-docs.md)** — full reference: concepts, environments, schema, providers, rotation, CLI.
- **[RFC-0001](./RFC-0001-penv.md)** — the design spec and the reasoning behind every decision.
- **[Roadmap](./penv-roadmap.md)** — what's built, what's next, and the two risks a build plan can't close.

## Contributing

The highest-leverage contribution right now isn't code — it's signal. If you run a real secret manager and maintain the local↔production translation by hand, open an issue describing that pain. That's the demand question the roadmap can't answer from the inside, and it decides where this project goes.

For code: the provider contract (v0.4) is the highest-risk, highest-value surface. Start there, or with a `doctor` check.

## License

MIT

---

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.
