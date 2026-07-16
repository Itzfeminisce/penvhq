# penv build roadmap

This is the single source of truth for **what is available when.** The [documentation](./Documentation.md) describes finished penv as a complete system with no "not yet" language; this file is where every "not yet," every version number, and every availability caveat lives. If the docs describe a capability and you need to know whether you can use it today, this file answers that.

The roadmap is sequenced by **which risk each milestone retires**, not by feature count. penv's design is settled; its two live risks are (1) whether provider portability holds against a real provider, and (2) whether the market wants this at all. Engineering effort is spent against the non-contestable advantage first, and everything that competes on t3-env's terrain is deferred until the provider story is proven.

---

## Availability at a glance

Everything below describes the *finished* design (see docs). This table says when each part becomes real.

| Capability | Described in docs | Available |
|---|---|---|
| Filesystem provider, CLI, import/generate, value cascade | Yes | v0.1 |
| `@env` / `.penv/env.ts`, one-schema typing, `penv validate` | Yes | v0.2 |
| `.enc` encryption grammar | Yes | grammar reserved v0.1; encrypt/decrypt v0.3 |
| Provider-backed keys (OS keychain / KMS) | Yes | v0.3 |
| Rotation (`dual-valid`, `atomic-cutover`), `doctor` rotation checks | Yes | v0.3 |
| Vault provider + cross-provider `doctor` drift | Yes | v0.4 |
| AWS SSM, Kubernetes providers | Yes | v0.5 |
| Provider portability as a *proven* claim | Yes | v0.4 (Vault), generalized v0.5 |
| `.json` meta format | Yes | v0.2 |
| `.toml` / `.yml` meta formats | Yes | post-v1.0, pluggable |
| Azure Key Vault, Google Secret Manager, Cloudflare providers | Yes | post-v1.0, community SDK |
| Public provider SDK / plugin ecosystem | (Future possibilities) | v1.0 |
| IDE integration | (Future possibilities) | post-v1.0 |

**On "amber" claims.** Two statements in the docs are true of the finished design but unproven until a specific milestone, and should be read as promises until then: *provider portability* (proven at v0.4, generalized at v0.5) and *encryption as a security rather than organizational improvement* (true once keys are provider-backed at v0.3). Until those milestones, treat them as roadmap items.

---

## v0.1 — Filesystem core

**Retires:** the risk that the many-files storage model is unworkable day to day.

- Filesystem provider: read, write, list, remove against the parameter tree.
- Filename grammar and reserved-token validation. **`.enc` is a reserved terminal token from day one** — a parameter named `enc` errors immediately — even though encrypt/decrypt is not implemented until v0.3. This avoids a later migration.
- Value cascade: `<name>.local` > `<name>.<env>` > `<name>`, flat override, `.local` skipped in `test`, loud fallback surfacing.
- `penv init`, `import`, `generate`, `get`, `set`, `remove`, `list`.
- Runtime loader and the `process.env` compatibility path.
- `.gitignore` automation.

**Gate to advance:** `penv import .env` on a real 30+ variable project, then `penv generate`, round-trips every variable losslessly — identical keys, values, and quoting semantics, modulo declared name overrides. Comments attached to a variable survive as that parameter's `description`; ordering is normalized and blank lines are not preserved, because one-value-per-file discards presentation by construction. If a single value does not survive the round-trip, nothing downstream matters.

## v0.2 — Schema, types, `.json` meta

**Retires:** the risk that "type-safe" and "validated" are claims penv cannot back.

- `.penv/env.ts` scaffolding (schema + `load`), the `@env` tsconfig alias written by `init`.
- Generic `load<T>(schema): z.infer<T>`; eager loading; named validation errors.
- `penv validate` — builds the config object, checks against Zod, exits non-zero on failure.
- `.json` meta files with shallow base→env merge.
- Deterministic name transform with collision detection.
- Schema draft generation on import, labelled as a draft.
- Watch mode.

**Gate to advance:** one schema visibly drives both a failing `penv validate` and a compile-time type error from the same source, with no duplicated type declarations.

## v0.3 — Encryption and rotation

**Retires:** the risk that penv's security and rotation stories are decoration rather than mechanism.

- `.enc` encrypt/decrypt at any scope; policy-driven encryption (meta declares must-encrypt; marker validated against it).
- **Provider-backed keys** — OS keychain locally, KMS-derived in CI/production, never repo-adjacent. *This is the milestone at which penv encryption becomes a security improvement rather than an organizational one.*
- Plaintext-secret detection in `doctor`.
- Rotation: `dual-valid` and `atomic-cutover` as distinct mechanisms; meta fields including the distinct `rotatingSince` clock.
- `doctor` rotation checks: overdue (`now - lastRotated > rotationPolicy`) and stuck (`now - rotatingSince > stuckThreshold`, gated to `dual-valid`).

**Gate to advance:** a `dual-valid` rotation runs `active → rotating → active` with grace-window overlap on a mock provider; `atomic-cutover` flips without a penv-layer grace window; `doctor` flags a stuck external rotation *without* false-positiving on atomic-cutover passwords.

> Note the documented asymmetry: filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system. Local rehearsal uses the mock provider.

## v0.4 — Provider proof (the pivotal milestone)

**Retires:** the single highest-risk claim — that switching providers is a config change, not a rewrite.

- Vault adapter implementing the full provider contract: read, write, list, remove, encrypted values, and provider-side previous-value retention for the grace window.
- Explicit `(env, namespace, name) → provider path` mapping from `providers.*.path`.
- `penv doctor` cross-provider drift detection against a live Vault instance.
- The provider contract extracted and documented as the interface future adapters must satisfy.

**Gate to advance:** the Vault adapter passes the *same* behavioural suite the filesystem provider passes, and flipping an environment from `filesystem` to `vault` requires zero application code changes. **Only after this passes is provider portability stated as a proven capability rather than a promise.**

## v0.5 — Second and third providers

**Retires:** the risk that Vault worked only because the contract was quietly shaped around Vault.

- AWS SSM Parameter Store adapter.
- Kubernetes Secrets adapter.
- Both built against the v0.4 contract with no contract changes permitted.

**Gate to advance:** SSM and Kubernetes satisfy the existing contract unchanged. If the contract must bend, that reopens v0.4 — it is a finding, not a footnote. Portability generalizes here.

## v1.0 — Stable SDK

**Retires:** the risk that third parties cannot safely build providers on penv.

- Public, versioned provider SDK — the contract frozen and documented.
- Plugin architecture for community providers.
- Complete documentation including the documented exit path.
- IDE integration deferred to after this — it competes on t3-env's terrain and is only worth investing in once the provider advantage is real.

**Gate:** an external contributor ships a working provider against the public SDK without core changes.

## Post-v1.0 (pluggable / community)

- `.toml` and `.yml` meta formats (the format layer becomes pluggable; `.json` remains the default).
- Azure Key Vault, Google Secret Manager, Cloudflare Secrets adapters.
- Team key-sharing UX, automatic rotation scheduling, per-parameter version history — these are RFC "future possibilities," promoted here only if and when committed.

---

## Explicitly deferred, and why

- **VS Code extension / IDE tooling** — competes on t3-env's ground; follows the provider proof, never precedes it.
- **Broad provider matrix** — no provider is claimed as supported until its adapter passes the contract suite.
- **Multi-format meta** — real cost (multiple parsers, mixed-format checks, more reserved tokens) for no v0.1–v1.0 value; `.json` first, others pluggable later.

## The two risks this roadmap cannot close by itself

Sequencing retires engineering risk. Two risks sit outside it and must be addressed in parallel, not by building:

1. **Provider portability** stays a promise ("amber") until v0.4 proves it and v0.5 generalizes it. Everything the design implies is buildable from v0.1–v0.3; this is the one claim that is a promise until a real adapter proves it.

2. **Market demand** is unmeasured. Everything here is buildability, not demand. The failure mode is not "it doesn't work" — it is "it works beautifully and eleven people adopt it," invisible from inside a build plan. **Before v0.4 engineering begins, validate demand with real teams:** find teams who describe the local↔production seam pain unprompted and would change their source of truth to fix it, measured against what they have already spent making their existing glue tolerable. Five concrete yeses de-risks the market question the way the rotation prototype de-risked the rotation question. Absent them, the honest move is to ship penv as a tool for its authors and let adoption be a bonus, rather than resourcing v0.4+ against an inferred market.