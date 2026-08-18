# penv build roadmap

This is the single source of truth for **what is available when.** The [documentation](./Documentation.md) describes finished penv as a complete system with no "not yet" language; this file is where every "not yet," every version number, and every availability caveat lives. If the docs describe a capability and you need to know whether you can use it today, this file answers that.

The roadmap is sequenced by **which risk each milestone retires**, not by feature count. penv's design is settled; the two live risks that sequenced it were (1) whether provider portability holds against a real provider — now proven across Vault, SSM, and Kubernetes — and (2) whether the market wants this at all, which remains open. Engineering effort is spent against the non-contestable advantage first, and everything that competes on t3-env's terrain is deferred until the provider story is proven.

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
| GitHub Actions Secrets **sink** — `penv push`, `sinks` config, `gh`-backed | Yes | v0.4 |
| `doctor` against a sink: name drift, manual-edit detection | Yes | v0.4 |
| `doctor`'s fourth verdict — `unknown`, a check that could not look | Yes | v0.4 |
| OS keychain key source | Yes | v0.4 |
| Rotation (`dual-valid`, `atomic-cutover`), `doctor` rotation checks | Yes | v0.5 (with the first real provider) |
| Mock provider, for rehearsing rotation | Yes | v0.5 |
| Vault provider + cross-provider `doctor` drift | Yes | v0.5 |
| `penv pull` — materialising the tree from a provider | Yes | v0.5 (with the first real provider) |
| `readPrevious` — the retention capability, declared per provider | Yes | v0.5 |
| AWS SSM, Kubernetes providers | Yes | v0.6 |
| Provider portability as a *proven* claim | Yes | v0.5 (Vault), generalized v0.6 |
| Provider unification — `sinks` deleted, `@penvhq/provider-github`, `push`/`pull` against every provider | Yes | v0.7 (npm 0.5.0) |
| Ambient delivery — blessed `process.env` mirror via `load(schema, { inject: true })`, schema exclusivity, per-framework seams, `override` rename | Yes | v0.8 (npm 0.6.0–0.7.0) |
| `doctor`'s `ambient-shadow` check | Yes | after v0.9 |
| `penv upgrade [version]` — moving the pinned engine and the runtime dependency together | Yes | after v0.9 |
| Two-module scaffold — `penv.schema.ts` shape + `.penv/env.ts` loader, tooling `load(schema.pick({…}))`, stray-code-file diagnosis | Yes | v0.8 (npm 0.8.0) |
| Embedded snapshot — `penv snapshot`, `penv.snapshot.ts`, `source` pinning, digest staleness | No longer | shipped v0.8 (npm 0.8.0); **retired v0.9** |
| Fully-qualified provider `type`, declaration-merged config types, `location` | Yes | v0.7 (npm 0.5.0) |
| Install-what-you-use providers — Vault, SSM, Kubernetes, GitHub external to the CLI | Yes | v0.7 (npm 0.5.0) |
| `--destination` one-shot push, environment shorthand flags, `ensureTarget` create-on-approval | Yes | v0.7 (npm 0.5.0) |
| Global launcher + pinned engine — `.penv/state/manifest.json`, `$PENV_HOME`, one visible version | Yes | v0.9 |
| One runtime dependency — `@penvhq/penv` alone, extensions installed by the launcher | Yes | v0.9 |
| `.penv/state/` layout and `penv migrate` | Yes | v0.9 |
| `penv run` — opaque child, owned child environment, network-forbidden, `--watch` opt-in | Yes | v0.9 |
| `penv init` as a complete dotenv cutover, with `penv init undo` and `penv cleanup` | Yes | v0.9 |
| `penv add` and the extension trust model (official / third-party / private) | Yes | v0.9 |
| Sealed deployment artifacts — `penv artifact build`, `penv run --source snapshot` | Yes | v0.9 |
| Platform-native serverless delivery (Vercel, Cloudflare) | Yes | v0.9 |
| `.json` meta format | Yes | v0.2 |
| `.toml` / `.yml` meta formats | Yes | post-v1.0, pluggable |
| Azure Key Vault, Google Secret Manager, Cloudflare providers | Yes | post-v1.0, community SDK |
| Public provider SDK / plugin ecosystem | (Future possibilities) | v1.0 |
| IDE integration | (Future possibilities) | post-v1.0 |

**On "amber" claims.** Two statements in the docs were true of the finished design but unproven until a specific milestone: *provider portability* (proven at v0.5, generalized at v0.6) and *encryption as a security rather than organizational improvement* (true once keys are provider-backed at v0.3). All three milestones have now shipped, so both claims now hold in released code rather than standing as promises.

**A sink is not a provider, and v0.4 does not move the portability claim.** The GitHub Actions sink ships first because it is what the teams trialling penv actually need, not because it advances the thesis. It cannot: GitHub Actions Secrets is write-only, so no adapter for it ever passes the provider contract, and shipping it leaves penv with exactly one provider — the filesystem — and nothing proven about switching between them. The portability gate is v0.5's, unchanged and untouched by v0.4. At v0.4 this distinction was expressed as a separate `sinks` config concept; v0.7 later unified it into the provider contract as declared capabilities — see the RFC's "Everything the config names is a provider; a store's limits are declared, not renamed" for the supersession and what survives of the original argument.

**On the docs' key sources.** The docs say keys are "the OS keychain locally, and KMS-derived keys in CI and production". The second half is true at v0.3; the first ships at v0.4. What is never true, at any milestone, is a key stored repo-adjacent — that is a design property, not a schedule.

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

**Rotation moved to the provider-proof milestone** (now v0.5), to be built alongside the Vault adapter. Rotation needs provider-side previous-value retention for the grace window, and the provider contract has no such verb. Adding one then would have meant shaping the contract around a *mock* — the one provider that cannot get it wrong, because it has no real behaviour to be wrong about — and then discovering later what Vault actually needs. The contract rule exists precisely for this: a contract change is a finding, not an edit.

This is a real cost, stated plainly: v0.3 no longer retires the rotation risk, and the milestone that does now carries two risks instead of one.

**Postscript, added after reading the providers' documentation.** The verb's shape was found without building anything. Vault KV v2 retains on a count *and* a time TTL (`max_versions`, `delete_version_after`); SSM retains on a count only, fixed at 100; Kubernetes Secrets retain nothing at all, by design. So no mandatory retention verb survives all three, the portable intersection is "read the previous value" and nothing more, and retention is a **declared capability** rather than a contract verb. The finding the deferral was protecting arrived from three documents rather than from an adapter — which is the rule working, one milestone earlier and for the price of an afternoon. See the RFC's "Previous-value retention is a declared capability, not a universal verb".

**The OS keychain key source moved to v0.4**, and is no longer unscheduled. The `env` source ships at v0.3 — a KMS-derived data key, unwrapped by the deploy and exported, which is the CI and production story in full. The keychain needs a native, synchronous dependency, and that choice was the blocker. It rides with the sink because the sink is what makes a laptop the master copy of production's secrets; see v0.4.

**The mock provider** was a v0.3 item only because the rotation gate needed one. It moves with rotation.

## v0.4 — Adoption: the sink and the local key

**Retires:** the risk that penv cannot reach the teams that actually exist — that the design is right and nobody can adopt it without running a secret manager they do not have.

- The GitHub Actions Secrets **sink**: `penv push`, declared under a `sinks` key in `penv.config.ts`, never under `providers`.
- Sink resolution skips both `.local` levels. CI receives what CI would read, never a developer's personal override.
- Every name checked against the destination's grammar *before anything is pushed*: the reserved `GITHUB_` prefix, a leading digit, and the case collision an `override` can express.
- `penv doctor` against a sink: exact name-level drift, manual-edit detection by comparing GitHub's `updated_at` against penv's own last-push time, and value drift reported as `unknown` because it cannot be read.
- `doctor`'s fourth verdict — `unknown`, a check that could not look — and the `publicPrefixes` line it retroactively fixes.
- The OS keychain key source (`source: "keychain"`), so a local tree's key stops living in a dotfile.
- Every GitHub call through the `gh` CLI. penv never holds a GitHub credential.

**Gate to advance:** on a real project, `penv push --env production` places every declared parameter in GitHub Actions with no value touched by hand; a developer's `.production.local` override is provably not among them; a parameter named `githubToken` is refused before a single secret is written rather than sixty in; and `penv doctor` names a secret that was edited in the GitHub UI without ever reading a value. Separately: a `.enc` value opens with a key held in the OS keychain and no `PENV_KEY_*` anywhere in the environment.

**What this milestone does not do, stated plainly.** It does not retire the portability risk and it proves nothing about the thesis — penv still has one provider afterwards. It retires the adoption risk instead. The roadmap's own closing section says demand must be validated with real teams before the provider proof is resourced; the teams trialling penv keep their CI secrets in GitHub Actions. A milestone that serves them is what makes that validation possible. A Vault adapter built first would be a confident answer to a question none of them asked.

**Why the keychain rides here.** In the provider model the local production tree is ephemeral: `pull` materialises it, `.gitignore` hides it, the next deploy replaces it. In the sink model the local tree **is** the master copy of production's secrets, sitting on a laptop. That inverts the keychain's priority. The milestone that makes a laptop authoritative is the milestone that must stop the key protecting it from living in a `.zshrc`, which is the arrangement penv's own documentation calls out as the thing it exists to delete.

## v0.5 — Provider proof (the pivotal milestone) and rotation

**Retires:** the single highest-risk claim — that switching providers is a config change, not a rewrite — and, with it, the rotation risk that v0.3 deferred here.

- Vault adapter implementing the full provider contract: read, write, list, remove, encrypted values, and `readPrevious` as a declared capability.
- **KV v2 required and validated, not assumed.** KV v1 retains nothing — "Any update will overwrite the original value and not recoverable" — so a v1 mount is an adapter that silently cannot rotate. It is refused at config time, not discovered mid-rotation.
- Meta stored at its own provider address, since Vault's `custom_metadata` cannot hold it: `map<string,string>`, 512-byte values, no nesting.
- A recursive walk for `list()`. Vault's LIST returns one level — "list on a file will not return a value" — so enumerating a tree is N round-trips, not one scan.
- Explicit `(env, namespace, name) → provider path` mapping from `providers.*.path`.
- `penv doctor` cross-provider drift detection against a live Vault instance — value by value, because this provider can be read back.
- The provider contract extracted and documented as the interface future adapters must satisfy, with retention marked optional.
- Rotation: `dual-valid` and `atomic-cutover` as distinct mechanisms; meta fields including the distinct `rotatingSince` clock.
- `doctor` rotation checks: overdue (`now - lastRotated > rotationPolicy`) and stuck (`now - rotatingSince > stuckThreshold`, gated to `dual-valid`).
- The mock provider, for rehearsing rotation flows locally.

**Gate to advance:** the Vault adapter passes the *same* behavioural suite the filesystem provider passes, and flipping an environment from `filesystem` to `vault` requires zero application code changes. **Only after this passes is provider portability stated as a proven capability rather than a promise.** Separately: a `dual-valid` rotation runs `active → rotating → active` with grace-window overlap; `atomic-cutover` flips without a penv-layer grace window; `doctor` flags a stuck external rotation *without* false-positiving on atomic-cutover passwords.

**The retention verb no longer waits on Vault to be shaped.** This milestone deferred rotation here so a real provider could say what retention looks like, rather than a mock inventing it. Reading Vault's, SSM's, and Kubernetes' documentation settled the shape without an adapter: retention is present-with-a-TTL, present-with-a-count-cap, and wholly absent, respectively. The portable intersection is `readPrevious` and nothing more — no TTL, no retention policy, because those are not shared. penv keeps the grace-window clock, which is what the design already committed to. What remains for Vault to prove is that the *rest* of the contract survives a real network provider; retention's shape is settled before the milestone starts.

> The documented asymmetry is wider than it was first recorded. Filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system — and that is not a filesystem quirk. Kubernetes Secrets sit on the same side of the line: no version history, no rollback, `resourceVersion` being "not older than" rather than "as it was". A provider declares whether it retains; `doctor` says what a non-retaining one cannot do. Local rehearsal uses the mock provider.

## v0.6 — Second and third providers

**Retires:** the risk that Vault worked only because the contract was quietly shaped around Vault.

- AWS SSM Parameter Store adapter. `readPrevious` via `name:version` / `GetParameterHistory`; meta at its own address, since `PutParameter` requires a `Value` and cannot write a `Description` alone; `WithDecryption` explicit on every read, because omitting it returns ciphertext *as the value* — a silent wrong value in penv's own adapter.
- Kubernetes Secrets adapter, **declaring no retention capability.** This is the contract working, not bending: Kubernetes retains no history by design, so a Kubernetes environment cannot dual-valid rotate and says so at config time.
- penv's arbitrary-depth namespace flattens onto Kubernetes' three fixed levels (cluster namespace, Secret name, key). The flattening is exact — `data` keys admit `[A-Za-z0-9._-]`, a superset of penv's value-filename grammar — but choosing *how* to flatten carries a collision hazard that is this milestone's to settle.
- Both built against the v0.5 contract with no contract changes permitted.

**Gate to advance:** SSM and Kubernetes satisfy the existing contract unchanged, with Kubernetes declaring retention absent rather than requiring the contract to accommodate its absence. If the contract must bend for anything else, that reopens v0.5 — it is a finding, not a footnote. Portability generalizes here.

**One bend has already been found, and priced.** Reading the three providers' documentation before v0.5 begins established that retention is not portable — Vault has it on a TTL, SSM on a fixed count of 100, Kubernetes not at all. Had that surfaced here instead, it would have reopened the provider-proof milestone after the fact. It surfaced early, so retention enters v0.5 as an optional capability rather than leaving v0.6 as a casualty. What that does *not* license is assuming the rest of the contract is safe: the remaining verbs are still unproven against a real network provider, and the rule stands.

## v0.7 — Provider unification (closed)

**Retires:** the friction the sink/provider split imposed on users — two config keys, two half-commands, and a migration between stores that the vocabulary made inexpressible.

Decided 2026-07-19; the [provider unification plan](./provider-unification-plan.md) owns *how*, and the RFC's two new sections ("Everything the config names is a provider" and "A provider is named by its package") own *why*, including what they supersede. In brief:

- `sinks` is deleted; `@penvhq/sink-github` becomes `@penvhq/provider-github`; `penv push` and `penv pull` work against every provider. What distinguished a sink moves into the contract as declared capabilities (`holds: "records" | "projection"`, `readsValues`) — the record-holding contract suite is untouched.
- `providers.<env>.type` becomes the provider package's fully-qualified name, typed via a declaration-merged `ProviderConfigMap`; `location` replaces `path`/`repo`; one provider per environment.
- The CLI pre-installs only the filesystem and mock providers; Vault, SSM, Kubernetes, and GitHub are installed by the projects that use them.
- `penv push --destination <package> --location <place>` as a one-shot, unpersisted target; `ensureTarget` with a CLI prompt (and `--yes`) when a push's destination does not exist yet; whitelisted environments usable as bare flags (`--production`).

Shipped on npm as **0.5.0** — a breaking release: configs naming short provider types or a `sinks` key are refused with the exact rewrite named in the error.

**Gate:** the full migration loop runs — pull names and meta down from GitHub, fill values locally, `validate` to green, push the tree to a freshly-declared Vault — with the contract suite passing unchanged for every record-holding provider and `doctor` reporting exactly (Vault) and honestly-partially (GitHub) at each step.

## v0.8 — Ambient delivery (closed)

**Retires:** the per-SDK bridge file — the hand-written mapping of `@env` values onto the exact `process.env` keys a third-party SDK reads, first written inside penv's own hosted product, which is what made the gap undeniable.

Decided 2026-07-19; the [v0.8 plan](./v0.8-plan.md) owns *how*, the RFC's "The ambient surface is a projection, and the schema is the pin list" owns *why*. Shipped across npm **0.6.0** (seams and selective inject), **0.7.0**, and **0.8.0** (the two-module scaffold). In brief:

- `load(schema, { inject: true })`, called from `.penv/env.ts`, is the blessed ambient surface: it validates before writing, writes generated (`override`-bent) names, and is exclusive over the schema — a declared parameter is written when it resolves and deleted when it does not, so nothing configures an SDK behind `@env`'s back. The bare `import "@penvhq/penv/config"` stays the schemaless compat path, because it never sees the schema.
- `penv init` scaffolds the import at the detected framework's guaranteed pre-app seam (Next `instrumentation.ts`, Nitro plugin, SvelteKit `hooks.server.ts`, `node --import`), plus the build-time seam for client-inlined variables. Halves scaffolded only where they exist; unknown frameworks are asked, never guessed.
- `names` becomes `override`, with schema-typed keys: the scaffolded `penv.schema.ts` registers the schema's shape on `PenvSchemaShape` (a type-only `declare module`, erased at runtime), and `override` keys narrow to the parameters the schema declares. Breaking; rides the 0.5.0 release train.
- The schema splits into two scaffolded modules: `penv.schema.ts` at the project root holds the *shape* (the `z.object` plus the `PenvSchemaShape` registration) and loads nothing, and `.penv/env.ts` becomes the thin loader that imports it, re-exports `schema`, and calls `load()`. Making the one schema importable without side effects is what lets a tooling config — `drizzle.config.ts`, a `playwright.config.ts`, a CI script — `load(schema.pick({ … }))` the same schema instead of hand-inlining a second `z.object` that drifts. This is the fourth config consumer (tooling evaluated outside the app runtime), joining `@env`, `inject`, and the client bundle.
- Stray-code-file diagnosis: a `.ts`/`.js` module dropped into `.penv/` that is not the file `schemaFile` declares is reported as a stray code module (`STRAY_CODE_FILE`) rather than misparsed as a value file — the safeguard that comes with the shape moving to the root, where the parameter tree has nothing to exclude.

**Gate:** penv-cloud deletes its WorkOS bridge files, declares the SDK's surface in its schema plus one `override` entry, and WorkOS authenticates with no penv-aware code in the app — including the exclusivity proof: a stray exported `WORKOS_API_HOSTNAME` never reaches the SDK.

**Two things this milestone carried that its title does not name.** The **embedded snapshot** shipped here (npm 0.8.0): `penv snapshot` generated a committed `penv.snapshot.ts` that the bundler traversed, so `load()` resolved inside a Next middleware chunk or a `/var/task` function with no `penv.config.ts` on disk. It is **retired at v0.9** and replaced by an external sealed artifact — see the v0.9 entry below and the RFC's "The deployment artifact is external, and the source stays out of the bundle". And `doctor`'s **`ambient-shadow`** check did not ship; it is resequenced after v0.9, because the rebuild changes where the resolved values come from and a check written against the old resolution path would have to be written twice.

## v0.9 — Developer-first execution and delivery

**Retires:** two risks at once — that adoption asks a newcomer to assemble penv-specific commands from documentation before anything works, and that delivery is coupled to the application's source tree and bundler.

Decided 2026-08-17; the [PRD](./PRD-Developer-First-Execution-and-Delivery.md) (including its sealed adoption-friction review) owns *what*, the `docs/rebuild/` issue set owns *how*, and the RFC's five new sections — the launcher/engine split, `.penv/state/`, the all-or-nothing cutover, the external artifact, and the run-ergonomics seals — own *why*. In brief:

- A **global launcher** (`penv`) and a project-pinned **engine** (`@penvhq/cli`). `.penv/state/manifest.json` is the committed contract naming the exact engine and extension versions with their integrity; the launcher resolves them from `$PENV_HOME` and delegates. A newer launcher never upgrades a project — the committed manifest is the only thing that moves a pin, and `penv install` fetches exactly what it names. One user-visible version: `penv --version` prints one line.
- **One runtime dependency**, `@penvhq/penv`, pinned to the engine's version. Provider extensions are installed by the launcher via `penv add <package>` and never enter `package.json`; each contributes a committed, type-only declaration under `.penv/state/extensions/`.
- **`.penv/state/`** holds Penv-managed project state — manifest, records, extension declarations, and adoption recovery state — under one committed safety boundary. `penv migrate` converts an existing project on approval; the engine reads only the new layout and refuses an unmigrated one by name. This supersedes the PRD's "migration window" sentence: there is no dual-layout engine, because a fallback is how a layout silently becomes two layouts.
- **`penv run -- <command>`** starts the developer's command as an opaque child of a validated, penv-owned environment. `--source` defaults to `project`; `--env` falls back to a declared `defaultEnvironment`. It contacts no provider, ever; `--watch` is the one opt-in mode that may synchronize.
- **`penv init` becomes a complete dotenv cutover** — detect, select, preflight everything, import, validate, then move the prior dotenv files into one ignored rollback bundle. `penv init undo` restores them exactly; `penv cleanup` closes the migration.
- **Sealed deployment artifacts.** `penv artifact build --env <e> --out <path>` produces an external, environment-specific artifact that CI packages or mounts, and `penv run --source snapshot` consumes it from `PENV_SNAPSHOT`. It is not application source, is not committed, and needs neither provider adapters nor network at start. Managed serverless platforms take **platform-native delivery** instead: penv writes to the platform's own encrypted environment store before the build.
- The embedded snapshot (`penv snapshot`, `penv.snapshot.ts`, the `snapshot-stale` and `bundle-invisible-plaintext` checks) is deleted, with no compat shim.

Ships as one breaking release: the launcher (`penv`), the engine (`@penvhq/cli`), and `@penvhq/penv` carry the same version, which is what makes "one visible version" true on the npm side as well as at the keyboard.

**Gate to advance:** the PRD's first-user journey runs end to end on a real project — `penv init` adopts a detected dotenv cascade with no partial state, the first `penv run -- pnpm dev` after cutover starts the app with zero edits to the drafted `penv.schema.ts`, and a container release built by `penv artifact build` starts from the artifact alone, with no `penv.config.ts`, no `.penv/` tree, no provider adapter, and no network.

**Resequenced after v0.9.** `penv upgrade [version]` — the one command that moves the manifest's engine pin and the project's `@penvhq/penv` dependency together — is not built at v0.9. The launcher ships `penv install` and `penv add`; until `upgrade` lands, a pin moves by editing the committed manifest and the runtime dependency, which is the same edit `upgrade` will make on your behalf.

**Accepted cost, carried from the PRD's friction review.** Retiring the committed snapshot means a clone no longer deploys by itself: CI must build the sealed artifact. Copy-paste artifact recipes for the major CI systems and platform-native delivery guides for Vercel and Cloudflare ship with this milestone, not after it.

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
- **Broad provider matrix** — no provider is claimed as supported until its adapter passes the contract suite. A projection-holding provider (GitHub) is never counted toward it: it does not take the record-holding suite, because it cannot, and it says so in its declared capabilities.

**On the rule the sink appears to break.** Deferring IDE tooling until after the provider proof is a rule about *terrain*, and v0.4 shipping first looks like it violates it. It does not, and the distinction is worth being exact about rather than waving through. t3-env's terrain is typed access to `process.env` — onboarding speed, IDE feel, dev-loop latency. t3-env pushes nothing anywhere; it has no notion of a destination. The seam between a developer's machine and the system that runs the code is penv's own subject, stated in the first paragraph of the RFC's motivation, and deleting the hand-copy into CI *is* that subject rather than an excursion from it.

What the sink genuinely does not do is prove portability — the thesis's other half. So v0.4 delivers one half of penv's claim for one destination and leaves the other half exactly where v0.3 left it. That is the honest accounting: not a rule broken, and not a milestone that earns more credit than it is due.
- **Multi-format meta** — real cost (multiple parsers, mixed-format checks, more reserved tokens) for no v0.1–v1.0 value; `.json` first, others pluggable later.
- **Materialising value files from `.penv/env.ts`** — watching the schema and writing a parameter file whenever a parameter is declared. Rejected, not postponed; the v0.2 drift report above is the answer to the itch behind it. Three reasons, in order of weight:
  1. **A declaration has no value.** Auto-creation must invent one, and every candidate resolves: an empty file is the value `""`, a placeholder is `"TODO"`. Either turns a loud "required parameter has no value for production" into a silent value reaching runtime — the exact failure penv exists to delete, reintroduced to save a `penv set`.
  2. **It deletes its own signal.** `env.ts` declares what must exist, the tree holds what does, and the gap between them is what `validate` and `doctor` report. Fill the gap by construction and `validate` can never fail.
  3. **Symmetry makes it destructive.** Files appearing on declaration implies files vanishing on undeclaration, and a rename is a delete plus a create — renaming `databaseUrl` to `dbUrl` would delete a real secret. No heuristic separates a half-typed name from a genuinely new one; they are byte-identical to a watcher, and a debounce loses to anyone who pauses mid-word. That rests a destructive operation on a guess that is wrong precisely when it is expensive.

  If the manual step still grates once the drift report exists, the ceiling is an explicit `penv sync` that prompts per parameter, creates only on a human keystroke, and never deletes — worst case an orphan, which `doctor` already catches. `penv set` stays the only writer of a value; one writer is what makes the tree auditable.

## The two risks this roadmap cannot close by itself

Sequencing retires engineering risk. Two risks sit outside it and must be addressed in parallel, not by building:

1. **Provider portability** was a promise ("amber") until v0.5 proved it with the Vault adapter and v0.6 generalized it across SSM and Kubernetes — both now shipped, so it is a proven capability. Everything the design implies is buildable from v0.1–v0.4; this was the one claim that stayed a promise until a real adapter proved it. v0.4 did not touch it, by construction — a sink cannot.

2. **Market demand** has its first signal, which is not the same as being measured. This section asked for five concrete yeses — teams who describe the local↔production seam pain unprompted and would change their source of truth to fix it, weighed against what they have already spent making their existing glue tolerable. That bar has not been cleared and should not be quietly retired: what exists is teams trialling penv, and a shared fact about them. The fact was enough to redirect the roadmap, because it was not the expected one — they keep their CI secrets in GitHub Actions, which is a sink and not a provider. So v0.4 was inserted to serve them and the provider proof moved to v0.5, rather than building a Vault adapter for a market that had not asked for one. Trialling is not yes. The five remain outstanding.

   **The question that decides v0.5 is still open**, and no amount of building answers it: *where do these teams' production applications actually read their secrets from?* If GitHub Actions injects them at deploy and that is the whole story, then nobody in the trial group is buying provider portability — they are buying the seam-deletion half of penv, and v0.5 is aimed at a market still to be found. If Actions merely holds the credential that reaches a Vault or an SSM behind it, v0.5 stands as written and its first adapter should be whichever of those they actually run. Ask before resourcing v0.5. The failure mode has not changed: it is not "it doesn't work", it is "it works beautifully and eleven people adopt it", which is invisible from inside a build plan.