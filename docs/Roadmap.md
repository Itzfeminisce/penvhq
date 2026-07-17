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
| `penv mv` — rename a parameter, re-sealing encrypted values | Yes | v0.3 |
| Configurable `schemaFile`, framework detection at `init`, `publicPrefixes` | Yes | v0.3 |
| `.enc` encryption grammar | Yes | grammar reserved v0.1; encrypt/decrypt v0.3 |
| KMS-derived keys, exported to the environment | Yes | v0.3 |
| OS keychain key source | Yes | post-v0.3 |
| Rotation (`dual-valid`, `atomic-cutover`), `doctor` rotation checks | Yes | v0.4 (with the first real provider) |
| Mock provider, for rehearsing rotation | Yes | v0.4 |
| Vault provider + cross-provider `doctor` drift | Yes | v0.4 |
| `penv pull` — materialising the tree from a provider | Yes | v0.4 (with the first real provider) |
| AWS SSM, Kubernetes providers | Yes | v0.5 |
| Provider portability as a *proven* claim | Yes | v0.4 (Vault), generalized v0.5 |
| `.json` meta format | Yes | v0.2 |
| `.toml` / `.yml` meta formats | Yes | post-v1.0, pluggable |
| Azure Key Vault, Google Secret Manager, Cloudflare providers | Yes | post-v1.0, community SDK |
| Public provider SDK / plugin ecosystem | (Future possibilities) | v1.0 |
| IDE integration | (Future possibilities) | post-v1.0 |

**On "amber" claims.** Two statements in the docs are true of the finished design but unproven until a specific milestone, and should be read as promises until then: *provider portability* (proven at v0.4, generalized at v0.5) and *encryption as a security rather than organizational improvement* (true once keys are provider-backed at v0.3). Until those milestones, treat them as roadmap items.

**On the docs' key sources.** The docs say keys are "the OS keychain locally, and KMS-derived keys in CI and production". The second half is true at v0.3; the first is a roadmap item until the keychain source ships. What is never true, at any milestone, is a key stored repo-adjacent — that is a design property, not a schedule.

---

## v0.1 — Filesystem core

**Retires:** the risk that the many-files storage model is unworkable day to day.

- Filesystem provider: read, write, list, remove against the parameter tree.
- Filename grammar and reserved-token validation. **`.enc` is a reserved terminal token from day one** — a parameter named `enc` errors immediately — even though encrypt/decrypt is not implemented until v0.3. This avoids a later migration.
- Value cascade: `<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`, flat override, both `.local` levels skipped in `test`, loud fallback surfacing.
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
- **Schema↔tree drift reporting.** `watch` and `doctor` name the distance between `.penv/env.ts` and the parameter tree in both directions: declared with no value for this environment (with the `penv set` line to paste), and present in the tree but undeclared. Reporting only — nothing here writes or deletes a value file. The drift is the signal `validate` exists to raise; the report makes it legible without closing it.

**Gate to advance:** one schema visibly drives both a failing `penv validate` and a compile-time type error from the same source, with no duplicated type declarations.

## v0.3 — Encryption

**Retires:** the risk that penv's security story is decoration rather than mechanism.

- `.enc` encrypt/decrypt at any scope; policy-driven encryption (meta declares must-encrypt; marker validated against it).
- **Provider-backed keys** — KMS-derived in CI/production, never repo-adjacent. *This is the milestone at which penv encryption becomes a security improvement rather than an organizational one.*
- Plaintext-secret detection in `doctor`, and an `encryption` check for a sealed value penv cannot open.
- `penv encrypt` / `penv decrypt` / `penv key create`.

**Gate to advance:** a parameter meta declares a secret; `penv set` seals it with no flag at the keyboard; `penv get` returns it with the key and reports *why* without it — never as a missing value; and a ciphertext copied from another scope fails to open rather than silently widening scope.

### Deferred out of v0.3, and why

**Rotation moved to v0.4**, to be built alongside the Vault adapter. Rotation needs provider-side previous-value retention for the grace window, and the provider contract has no such verb. Adding one now would mean shaping the contract around a *mock* — the one provider that cannot get it wrong, because it has no real behaviour to be wrong about — and then discovering at v0.4 what Vault actually needs. The contract rule exists precisely for this: a contract change is a finding, not an edit. Rotation is designed (see the docs) and is buildable; it is sequenced behind the provider that can prove its shape.

This is a real cost, stated plainly: v0.3 no longer retires the rotation risk, and v0.4 now carries two risks instead of one.

**The OS keychain key source moved to post-v0.3.** The `env` source ships — a KMS-derived data key, unwrapped by the deploy and exported, which is the CI and production story in full. The local keychain needs a native, synchronous dependency, and that choice is not made yet. Until it lands, local development holds its key the same way CI does.

**The mock provider** was a v0.3 item only because the rotation gate needed one. It moves with rotation.

## v0.4 — Provider proof (the pivotal milestone) and rotation

**Retires:** the single highest-risk claim — that switching providers is a config change, not a rewrite — and, with it, the rotation risk that v0.3 deferred here.

- Vault adapter implementing the full provider contract: read, write, list, remove, encrypted values, and provider-side previous-value retention for the grace window.
- Explicit `(env, namespace, name) → provider path` mapping from `providers.*.path`.
- `penv doctor` cross-provider drift detection against a live Vault instance.
- The provider contract extracted and documented as the interface future adapters must satisfy.
- Rotation: `dual-valid` and `atomic-cutover` as distinct mechanisms; meta fields including the distinct `rotatingSince` clock.
- `doctor` rotation checks: overdue (`now - lastRotated > rotationPolicy`) and stuck (`now - rotatingSince > stuckThreshold`, gated to `dual-valid`).
- The mock provider, for rehearsing rotation flows locally.

**Gate to advance:** the Vault adapter passes the *same* behavioural suite the filesystem provider passes, and flipping an environment from `filesystem` to `vault` requires zero application code changes. **Only after this passes is provider portability stated as a proven capability rather than a promise.** Separately: a `dual-valid` rotation runs `active → rotating → active` with grace-window overlap; `atomic-cutover` flips without a penv-layer grace window; `doctor` flags a stuck external rotation *without* false-positiving on atomic-cutover passwords.

Retention is the reason these two arrived in the same milestone. The contract needs a verb for it, and shaping that verb around anything but a real provider is how a contract quietly becomes one provider's interface with extra steps. Vault is the first provider that can say what retention actually looks like — and if SSM and Kubernetes cannot satisfy the shape Vault implies, that is v0.5's finding, on the same terms as any other contract bend.

> Note the documented asymmetry: filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system. Local rehearsal uses the mock provider.

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
- **Materialising value files from `.penv/env.ts`** — watching the schema and writing a parameter file whenever a parameter is declared. Rejected, not postponed; the v0.2 drift report above is the answer to the itch behind it. Three reasons, in order of weight:
  1. **A declaration has no value.** Auto-creation must invent one, and every candidate resolves: an empty file is the value `""`, a placeholder is `"TODO"`. Either turns a loud "required parameter has no value for production" into a silent value reaching runtime — the exact failure penv exists to delete, reintroduced to save a `penv set`.
  2. **It deletes its own signal.** `env.ts` declares what must exist, the tree holds what does, and the gap between them is what `validate` and `doctor` report. Fill the gap by construction and `validate` can never fail.
  3. **Symmetry makes it destructive.** Files appearing on declaration implies files vanishing on undeclaration, and a rename is a delete plus a create — renaming `databaseUrl` to `dbUrl` would delete a real secret. No heuristic separates a half-typed name from a genuinely new one; they are byte-identical to a watcher, and a debounce loses to anyone who pauses mid-word. That rests a destructive operation on a guess that is wrong precisely when it is expensive.

  If the manual step still grates once the drift report exists, the ceiling is an explicit `penv sync` that prompts per parameter, creates only on a human keystroke, and never deletes — worst case an orphan, which `doctor` already catches. `penv set` stays the only writer of a value; one writer is what makes the tree auditable.

## The two risks this roadmap cannot close by itself

Sequencing retires engineering risk. Two risks sit outside it and must be addressed in parallel, not by building:

1. **Provider portability** stays a promise ("amber") until v0.4 proves it and v0.5 generalizes it. Everything the design implies is buildable from v0.1–v0.3; this is the one claim that is a promise until a real adapter proves it.

2. **Market demand** is unmeasured. Everything here is buildability, not demand. The failure mode is not "it doesn't work" — it is "it works beautifully and eleven people adopt it," invisible from inside a build plan. **Before v0.4 engineering begins, validate demand with real teams:** find teams who describe the local↔production seam pain unprompted and would change their source of truth to fix it, measured against what they have already spent making their existing glue tolerable. Five concrete yeses de-risks the market question the way the rotation prototype de-risked the rotation question. Absent them, the honest move is to ship penv as a tool for its authors and let adoption be a bonus, rather than resourcing v0.4+ against an inferred market.