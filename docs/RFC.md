# RFC 0001 — penv

| | |
|---|---|
| **RFC** | 0001 |
| **Title** | penv |
| **Status** | Draft |
| **Authors** | penv working group |
| **Created** | 2026-07-16 |

This RFC is the canonical record of *why* penv is shaped the way it is: the problem it targets, the decisions it made, the alternatives it weighed, and the tradeoffs it accepted on purpose. It is the story book, not the manual and not the release schedule.

- For **how to use penv** — the complete reference to the finished system — see the [documentation](./Documentation.md).
- For **what is available in which release** — all versioning and availability — see the [roadmap](./Roadmap.md).

This RFC deliberately does not track availability. Where it describes a capability, it describes the intended design; the roadmap says when that design ships.

---

## Summary

penv is a configuration layer for TypeScript teams that stores each parameter as an individually-addressable resource on the filesystem, in a hierarchy that mirrors the shape production secret managers (Vault, AWS SSM, Kubernetes Secrets) already use. One Zod schema drives both runtime validation and TypeScript inference. `penv doctor` reports drift between local configuration and a live provider. The goal is not a nicer `.env` file — it is to delete the hand-maintained translation between local development and the production secret manager, which is where configuration drift, leaks, and mis-rotations actually happen.

## Motivation

The `.env` file is the industry default for local configuration. It does not scale for teams that also run a real secret manager in production, for reasons that are structural rather than cosmetic: no hierarchy or namespacing; no native validation or typing; no per-parameter access control (you cannot `chmod` a line); no independent rotation (rotating one key means re-deploying the file that holds every key); merge conflicts on a file everyone edits; and no structural relationship to how the production secret manager stores the same data.

Teams bridge the gap by hand-translating between a local `.env` and a provider-specific system in production. **That translation is the actual risk surface** — not the `.env` file. It is done manually, under deploy pressure, with no validation step. It is where a key renamed in Vault but not locally drifts silently, where a stale `.env.example` misleads a new hire, and where a staging secret is pasted into a production deploy at 2am because nobody had time to check.

penv's job is to delete that seam.

### What penv does not claim

penv is **not** the best local developer experience for reading `process.env` in TypeScript. Tools built purely for that — t3-env in particular — win on onboarding speed, IDE feel, and dev-loop latency, and they win *structurally*: those categories reward doing less, and no amount of investment in penv changes that. A weighted comparison against t3-env on the "best local experience" claim came out a near-tie that t3-env wins on the categories that define that claim.

penv's claim is narrower and more defensible: **it is the only configuration layer where the local environment and the production secret manager share a data model.** penv competes against the manual translation step, not against t3-env. This narrowness is a design choice, revisited and reaffirmed; the broader "best local config" positioning was considered and rejected as both weaker and less honest.

## The core decision: isomorphism, not a new paradigm

AWS SSM stores `/app/database-url`. Vault stores `secret/redis/password`. Kubernetes Secrets namespace by key. Every major provider independently converged on hierarchical, per-parameter storage, because that shape is what per-parameter access control, auditing, and rotation actually require.

penv's filesystem layout mirrors this. A local penv tree and a provider path are two serializations of the same logical record `(environment, path, name)`. Because the shapes match, switching providers is a configuration change rather than an application rewrite. This is the whole thesis, and every other decision is downstream of protecting it.

An earlier framing leaned on a file-routing analogy (Next.js/TanStack mapping files to URLs). It was tested and found weaker: file routing has an external anchor (the URL) that config lacks. The provider-isomorphism argument stands on its own and is the one penv leads with.

**On how far the convergence actually goes, read rather than remembered.** The paragraph above was written from familiarity with these providers. Checking it against their documentation sharpens it in two places and qualifies it in one.

Vault and SSM are the strong cases, and they are strong: Vault KV v2 addresses arbitrary multi-segment paths beneath a mount, and SSM names are `/`-delimited hierarchies up to fifteen levels deep. Kubernetes is the weak case, and "Kubernetes Secrets namespace by key" was doing more work than it admitted. A Secret is addressed by exactly three fixed levels — cluster namespace, Secret name, and a key inside a flat `data` map — `/` is legal in none of them, and there is no deeper nesting to reach for. penv's arbitrary-depth namespace does not map onto Kubernetes natively. It flattens, and how it flattens is a mapping decision with a collision hazard of its own.

What survives is worth more than the tidy version. The property the thesis rests on is not hierarchy — it is that every one of these stores an **individually addressable value with its own access control**, which is what per-parameter ACLs, auditing, and rotation require. Hierarchy is how Vault and SSM express that property; it is not the property. And the Kubernetes flattening is exact rather than lossy, which is checkable rather than hopeful: `data` keys admit `[A-Za-z0-9._-]`, a superset of the charset penv's value-filename grammar uses, so a penv value filename *is* already a legal Kubernetes key. The isomorphism reaches Kubernetes through penv's own grammar rather than through Kubernetes' path model — which is a weaker claim than the one first written, and a true one.

## Decisions and their reasoning

Each subsection records a decision and *why* it was made that way, including the alternative that was rejected. These are the load-bearing choices; the documentation states them as rules, this RFC states why they are rules.

### Value resolution follows the established `.env` cascade

**Decision.** Values resolve by scope, most-specific first: `<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`. This is flat override — a more specific scope replaces a less specific one wholesale. Both `.local` scopes are skipped in the `test` environment.

**Why.** dotenv, Next.js, and Vite already converged on exactly this cascade, and developers have it in muscle memory. Inventing a different resolution order would impose a learning cost for no benefit. Adopting the known cascade means "if you understand how `.env.development.local` beats `.env.local` beats `.env.development` beats `.env`, you understand penv's value resolution." Skipping `.local` in test is borrowed from the same tools, which solved test-reproducibility this way already.

**On keeping all four levels.** An earlier draft of this RFC claimed the ecosystem cascade while specifying only three levels — it dropped `.env.[mode].local`, the environment-scoped personal override. That was not a simplification, it was a mistake, and a self-refuting one: the entire argument for adopting the cascade is that developers already know it, which a subset does not deliver. It surfaced the first time penv was pointed at an ordinary Next.js project, whose `.env.development.local` had nowhere in the tree to go. `import` papered over the gap by flattening the file to unscoped defaults — which then served *every* environment, so a value scoped to one developer's development machine became the shared fallback for production. Three levels do not just lose expressiveness; they silently widen scope, which is the failure penv exists to delete. All four levels are kept.

**Rejected.** A penv-specific precedence scheme, and any form of value *merging*. Values are opaque; there is nothing to merge, and merging opaque values would be a novelty with no precedent and no upside. Also rejected: mapping `.env.[mode].local` onto `.local` or onto `.[mode]` on import — both silently change a value's scope, and the second promotes a personal override into a shared environment value.

### Meta merges hierarchically and shallowly

**Decision.** A parameter's meta file has a base object and per-environment blocks. An environment block overrides the base per top-level key and inherits the rest. Nested objects are replaced wholesale, not deep-merged. `.local` does not participate.

**Why.** Meta is the one structure the `.env` ecosystem never had to handle, so there is no cascade to inherit — but the ecosystem's consistent preference for flat override over deep-merge tells us which way to lean. Shallow merge preserves a legibility property that is central to penv: the effective meta for any environment is computed by reading exactly two objects (base and that environment) and overlaying keys. Deep-merge breaks that "read two things" property and makes effective policy hard to reason about. Replace-wholesale at the top level was rejected earlier for a related reason — it would silently wipe base fields like `description` on a partial override — so the settled rule is shallow per-key merge: neither deep nor wholesale-replace.

**Rejected.** Deep-merge (too clever, illegible) and wholesale-replace (silently destructive). `.local` in meta was rejected because policy is a property of the shared parameter, not of a developer's machine.

### Encryption is orthogonal to scope

**Decision.** Any value file may be encrypted with a terminal `.enc` marker, at any scope, including the unscoped default. `.enc` is always last; the scope segment precedes it. Meta is always plaintext.

**Why.** Encryption is a storage property, not a precedence axis. Making it orthogonal keeps the grammar composable — an encrypted value competes for precedence exactly as its plaintext equivalent would — rather than coupling "is this secret" to "which environment is this." Whether a parameter *must* be encrypted is expressed as policy in meta and validated against the on-disk marker, so a committed plaintext secret is a detectable `doctor` failure rather than an invisible mistake.

**Accepted cost, stated not hidden.** Because the unscoped default doubles as the local-dev value, encrypting it (`<name>.enc`) means a developer needs the decrypt key to run locally. This is a real ergonomic cost of that particular choice; penv permits it and documents it rather than forbidding it, leaving the scope-of-encryption decision to the team.

### Rotation state lives in meta and the provider, never in filenames

**Decision.** The value file is always the current value. Rotation phase (`rotationState`, `rotatingSince`, etc.) lives in meta; the previous value, during a grace window, lives in the provider — where the provider retains one at all, which is not everywhere, and is the subject of the decision below. There is no `.current`/`.previous` value-filename suffix.

**Why.** A prototype surfaced this as the key design bug: if rotation state is encoded in filenames, the value tree changes shape mid-rotation, `.previous` files appear and must be cleaned up, and an interrupted rotation orphans ghost state inside the source of truth — the exact thing penv exists to avoid. Keeping rotation phase out of the value-filename namespace also protects the single-schema invariant. The consequence — filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system — is stated deliberately rather than discovered later. Local rehearsal is a mock-provider concern.

**Two rotation modes, not one.** `dual-valid` (grace-window overlap) and `atomic-cutover` (immediate flip, overlap only at the infra layer) are distinct mechanisms and are never unified into one code path. `lastRotated` (last completed rotation) and `rotatingSince` (current rotation's start) are distinct clocks, because the overdue check and the stuck check measure different things; collapsing them breaks stuck detection. Stuck detection is gated to `dual-valid` so atomic-cutover passwords are never false-flagged.

### Previous-value retention is a declared capability, not a universal verb

**Decision.** The contract asks a provider for one retention operation — read the previous value of a parameter — and that operation is **optional**. A provider declares whether it retains. `dual-valid` rotation requires one that does; `atomic-cutover` does not. penv owns the grace-window clock, and a provider is never asked to enforce it.

**Why.** The roadmap sequenced rotation behind Vault so the retention verb would be shaped by a real provider rather than a mock, and planned to learn from a later provider whether SSM and Kubernetes could satisfy the shape Vault implied. Reading the three providers' own documentation answers that up front, and the answer is that no single mandatory shape survives all three.

*Vault KV v2* retains natively: every write creates a version, `max_versions` defaults to 10 and is configurable per-mount and per-secret, `?version=N` reads a prior value, and `delete_version_after` expires versions on a **time** TTL. *KV v1 retains nothing* — "Any update will overwrite the original value and not recoverable" — so the adapter requires KV v2, not "Vault", and must validate that rather than assume it.

*AWS SSM Parameter Store* also retains: `GetParameterHistory` returns prior values and `name:version` addresses one. But the ceiling is 100 versions, fixed and not configurable, oldest silently pruned, with no TTL of any kind. Retention is expressible only as a **count**.

*Kubernetes Secrets* retain nothing. There is no version history, rollback, or revision store. `resourceVersion` is an optimistic-concurrency token whose documented GET semantics are "not older than" — it can say *at least as new as*, never *as it was*. The etcd change window is minutes and is compacted away, with no API to read through it. This is not an oversight in Kubernetes: a Secret is a current-state object by design.

Present-with-a-TTL, present-with-a-count-cap, and absent. A mandatory verb shaped on Vault's TTL would be unsatisfiable by SSM and unimplementable on Kubernetes, and the rule that a contract change is a finding rather than an edit would fire at a later milestone and reopen an earlier one. The finding is available now, so it is taken now — which is the rule working, one milestone earlier and for the price of reading three documents.

**What the intersection actually is.** "Give me the previous value" is the only operation every retaining provider shares — `?version=N` in Vault, `name:version` in SSM. Retention *policy* is not shared, and is therefore not asked for. This is also the reading the design already committed to elsewhere: rotation phase lives in meta, `rotatingSince` is penv's clock, and a provider enforcing its own grace window would be a second authority on a question penv already answers.

**The documented asymmetry was always right; it was simply narrower than the truth.** This RFC already states that filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system — recorded as a quirk of the filesystem. It is not a quirk. It is the general case, and Kubernetes sits on the same side of the line as the filesystem. So a provider declares retention, `doctor` reports what a non-retaining provider cannot do rather than letting a team discover it mid-rotation, and the contract suite runs its retention section only against providers that claim the capability.

**Accepted cost, stated not hidden.** Provider pruning is counted and penv's grace window is timed, and the two do not commute. Vault's default of ten versions means a parameter written ten times inside a grace window has already lost the value penv meant to keep; SSM's hundred means the same at a hundred. penv therefore cannot assume the previous version still exists when its own window closes — it must ask and be prepared to be told no. A rotation that cannot find its own previous value is a `doctor` failure, never a silent success, on exactly the rule the encryption check already follows for a sealed value penv cannot open.

### Meta is a record with its own address, not a provider's native metadata

**Decision.** A parameter's meta is stored as its own record at its own provider address, the way the filesystem stores a sibling `.json` file. It is never mapped onto a provider's built-in metadata mechanism. `list()` excludes meta addresses, which the contract already requires of every provider.

**Why.** The obvious reading is that each provider's own metadata facility is meta's natural home. Reading all three shows it is nobody's home, for three unrelated reasons that happen to converge.

*Vault's* `custom_metadata` is `map<string,string>` — 64 pairs, 128-byte keys, 512-byte values, no nesting. penv's meta is nested by design (`environments: { production: { required: true, owner: "infra-team" } }`), and one honest `description` plus an owner and two environment blocks passes 512 bytes without trying.

*SSM's* `Description` is a flat 1024-character string, and `PutParameter` **requires** `Value` on every call. There is no API path to write a description without writing a value — which the contract forbids in as many words: meta is held independently of any value, and a parameter with meta and no value is an ordinary state. SSM's richer facilities do not rescue it: Tags are fetched through a separate API and returned by neither `GetParameter` nor `DescribeParameters`, and Policies are Advanced-tier only, capped at ten, full-replace on write, and mean something else entirely.

*Kubernetes* annotations come closest — arbitrary strings including JSON, 256 KiB per object — but they are per-Secret, and a Secret holds a map of many penv values, so an annotation cannot address one parameter's policy. *GitHub Actions* has no metadata concept at all.

Three providers, three different walls, one conclusion: meta is a record, and records have addresses. That is what the filesystem provider already does, and it turns out to be the portable answer rather than a filesystem convenience — the sibling `.json` file was right for reasons its author had not yet checked.

**Rejected.** *Per-provider meta strategies* — `custom_metadata` on Vault, a sibling parameter on SSM, an annotation on Kubernetes — which is three mappings to maintain, three sets of limits to discover in production, and a `readMeta` that means something different per provider. That is the branch-on-provider-type the design forbids everywhere else, moved into the one place nobody would look for it. *Squeezing meta to fit the smallest facility* — a 512-byte string-map — which would delete `description`, the field that makes a value tree legible, to satisfy a store penv chose.

**Accepted cost, stated not hidden.** Meta doubles a parameter's provider addresses, so a tree of N parameters occupies up to 2N records, and `list()` must exclude the meta half on every provider rather than only on disk. Against SSM's 3 TPS write quota and its per-tier parameter caps, that doubling is a real operational cost a team pays for policy penv could not otherwise carry.

### Environments are a whitelist, never inferred

**Decision.** Valid environment names are declared in `penv.config.ts`. A filename segment is an environment only if it appears in that whitelist.

**Why.** Inference from folder or filename structure would make environment scoping ambiguous against namespace folders. The whitelist removes the ambiguity entirely: a segment is an environment because it was declared, not because a heuristic guessed. This is why the parameter grammar is suffix-based and flat rather than nested-per-environment — nested folders collide with namespace folders, suffixes plus a whitelist do not.

### One schema, imported from the project, not the package

**Decision.** There is one Zod schema per project, in `.penv/env.ts`. Application code reads `import { env } from "@env"`, where `@env` is a tsconfig alias for `.penv/env.ts`. `env.ts` exports both the `schema` (the shape) and `env = load(schema)` (the loaded values). `load` is generic, returning `z.infer<T>`.

**Why.** The type must come from the user's schema, but a published package cannot know the user's schema. Three mechanisms were weighed. Module augmentation (`declare module "@penvhq/penv"`) works but hides a coupling the reader cannot see at the callsite. Codegenerating a `.d.ts` from the schema was rejected outright: a generated type is a *second representation* that can drift from the schema, which is precisely the disease penv treats — using `z.infer` directly means the schema is the only representation and the type cannot disagree with it. The chosen mechanism — a generic `load` applied to a schema the user imports from their own project — is honest at the callsite (the import path points at the file the type comes from), requires no augmentation, and involves no codegen. `penv init` scaffolds `env.ts` once and never regenerates it; it is the user's file. The alias is generated, the file is not.

**A note on why the type is trustworthy.** `z.infer` is a compile-time promise. It is made true by `load` validating the loaded values against the same schema at runtime and throwing on mismatch. Inference and validation from one schema is what makes "type-safe" a guarantee rather than an aspiration. `load` is eager — importing `env` loads and validates immediately — so invalid configuration fails at startup, not at first use; type-only consumers import `schema` instead to avoid triggering the load.

### A provider is a sync target, not a runtime source

**Decision.** A provider is where an environment's values *live*; it is not what the application reads at boot. `penv pull` materialises the parameter tree from the provider, and the runtime reads that tree. Resolution is always local, always synchronous, and never branches on provider type.

**Why.** Four commitments looked individually reasonable and turned out to be jointly impossible: `load` returns `z.infer<T>` (not a promise); `env.ts` says `export const env = load(schema)` at module top level; changing provider is a config change with no application edit; and Vault, SSM, and Kubernetes are network reads. A synchronous `load` cannot make a network call, so on the obvious reading — the provider is what the runtime reads — the `@env` path simply cannot be backed by Vault, and the provider-portability claim would be false for the very surface penv leads with.

Separating the two halves dissolves the conflict rather than trading one commitment away. Reading stays local, so `load` stays synchronous and `z.infer<T>` survives untouched. Nothing in the resolution path branches on provider type, so there is genuinely no code path Vault takes that the filesystem does not — which makes "changing provider is a config change" *stronger* than it would be under an async runtime read, where at minimum `env.ts` would have to change.

It is also how these systems are actually operated. The Vault Agent Injector writes files; the Secrets Store CSI driver mounts them; External Secrets Operator syncs into Kubernetes Secrets. In-process Vault reads on the hot path are rare. The tree penv already stores is the same shape those tools produce, so `penv pull` is penv's own version of a step most deploys already have — not a workaround for a limitation.

Two pieces of the design already assumed this reading before it was written down, which is part of why it is the right one: `penv set` *pushes* to the provider, and `doctor` reports *drift* between local configuration and a live provider. Both describe penv as a sync engine. Drift is only a coherent idea if there are two copies.

**Accepted cost, stated not hidden.** A deploy must pull before it starts, or mount a tree something else has materialised. penv does not fetch secrets at import time. A tree that was never pulled resolves to whatever is on disk, which is exactly what `doctor`'s drift check exists to catch.

**Rejected.** *Top-level await* (`export const env = await load(schema)`) preserves the inferred type, since `await` unwraps the promise — but it makes `env.ts` an async module, which infects every importer, breaks CJS `require`, and reintroduces the ordering hazard that makes `import "@penvhq/penv/config"` compat-only rather than blessed. It also is not zero-edit: adopting Vault would mean hand-editing the one file penv scaffolds once and never regenerates. *A `prefetch()` cache* filled before first read is the same ordering hazard wearing a different hat. *An async `loadAsync` sibling* creates two resolution paths that will drift apart — the disease penv exists to treat, practised in penv's own code.

### A sink is a destination, not a provider

**Decision.** A provider is the system of record for an environment's values and satisfies the full contract: read, write, list, remove. A **sink** is a destination penv pushes values *to* and cannot read back. Sinks do not implement the provider contract, never appear as an environment's `provider`, and do not participate in `penv pull`. GitHub Actions Secrets is the first sink.

**This adds a concept; it does not narrow the thesis.** Everything above about providers stands untouched. Against a read-write provider — Vault, SSM, Kubernetes Secrets — penv's claim is exactly what it was: the local tree and the provider path are two serializations of one logical record, `penv pull` materialises the tree, `doctor` compares both copies value by value, and switching provider is a configuration change. The isomorphism argument is not weakened by the existence of destinations it does not describe. A sink is what penv offers a team whose CI holds a write-only store; it is the lesser half of the product, and it is named as a separate concept precisely so it cannot be mistaken for the whole one. A team on Vault is buying the thesis. A team on GitHub Actions alone is buying a subset, and should be told which.

**Why.** GitHub Actions Secrets is write-only by construction, and GitHub's own reference says so outright: *"Gets a single repository secret without revealing its encrypted value."* Every read endpoint — get and list, at organization, repository, and environment scope alike — returns `name`, `created_at`, and `updated_at`, and nothing at any scope returns a value. Writes go the other way: `PUT` takes an `encrypted_value` sealed client-side with LibSodium under a public key fetched from the destination, plus that key's `key_id`.

So the contract fails at its first assertion — "round-trips a written value" — and no GitHub adapter ever passes it. It is worth being precise about *why*, because the precision is what makes the sink a concept rather than an excuse. The destination is not structurally alien; most of it maps. Read is the one thing that is not a mapping question at all: the value cannot come back, at any scope, through any endpoint, by design. That single fact is what the whole distinction rests on. This is not the contract needing a bend, which the roadmap treats as a finding to be worked through — it is a second concept that was wearing the first one's word.

**The mapping a sink does get, which is more than expected.** GitHub's secret scopes are not one flat namespace. Environment secrets are keyed by environment name, repository secrets are the fallback available to every workflow, and — the part that matters — **the destination resolves them in penv's own order.** GitHub's documented precedence is environment over repository over organization. So penv's environment scope goes to a GitHub environment secret of the same name, penv's unscoped default goes to a repository secret, and the rule that an environment scope beats the unscoped default is not something penv has to flatten at the boundary and hope for: it is reproduced by the destination's own native mechanism. Two systems that converged on the same cascade, which is the isomorphism argument turning up somewhere the design never looked for it.

What does not map is bounded and unsurprising. Namespace flattens through the same name transform `penv generate` already uses, so `redis/password` arrives as `REDIS_PASSWORD` and one line decides it in both places. Meta has no home. Both `.local` scopes are never pushed at all — a personal override is not something CI has any business holding, and refusing to push it is the same scope-widening refusal `import` already makes. Organization secrets have no penv concept and are left alone rather than guessed at.

The direction of truth is what finally separates the two. With a provider, the provider holds the values and `penv pull` materialises the tree from it. With a sink, the local tree holds the values and the destination receives them — and at runtime nothing pulls, because CI injects the secrets as environment variables and penv's `process.env` compatibility path already reads them. A sink sits downstream of the source of truth exactly as a generated `.env` does; it is `penv generate` pointed at CI. That is also why a sink is cheap: no contract change, no `pull`, no meta storage, no read-back. Resolve the tree for an environment, seal each value under the destination's public key, put it.

**Rejected.** *A read-shaped sink provider* whose `read` returns `undefined` — it satisfies the type and fails the suite, and every check downstream that reads absence as "no value" would report an empty CI as a clean one. *Widening the contract* so `read` is optional — that makes read optional for every provider to accommodate the one destination that has none, and the portability claim rests on there being no code path Vault takes that the filesystem does not. *Two-way sync*, for the reason it is rejected everywhere else: it recreates the two-systems-kept-in-sync problem penv exists to delete.

**Accepted cost, stated not hidden.** penv's encryption stops at the sink. A CI runner holds no penv key, so `.enc` values are decrypted locally and pushed as plaintext for the destination to re-seal under its own. Pushing the penv key into the same store as the values it protects would buy nothing over plaintext, so penv does not offer it. For a team whose production story ends at a sink, penv's encryption protects the local tree and the destination's own custody takes over at the boundary. That is a narrower claim than "encryption is a security improvement rather than an organizational one," and it is the honest one for that team.

**A sink has a ceiling the local tree does not.** GitHub documents 100 repository secrets, 100 per environment, and 48 KB per value; names are `[A-Za-z0-9_]` only, may not begin with a digit, and may not begin with `GITHUB_`. A tree is bounded by the filesystem and a sink is bounded by someone else's product, so the destination's rules are narrower than penv's grammar and always will be.

The `GITHUB_` rule is the one that draws blood, and it is not hypothetical: a parameter named `githubToken` transforms to `GITHUB_TOKEN`, which the destination reserves and refuses — and `GITHUB_TOKEN` is among the likeliest names to exist in exactly the projects this sink targets. A leading digit is the same shape of gap: `1PASSWORD` round-trips cleanly through penv's transform and the destination rejects it outright.

Case is a narrower edge than it first appears, and worth stating exactly. The default transform always uppercases, and `checkNameCollisions` already refuses two parameters that produce one variable, so the destination's case-insensitivity is normally moot. The gap is `names` overrides, which are arbitrary strings compared exactly: `names: { a: "Foo", b: "foo" }` is two variables to penv and one to a destination that uppercases what it stores, and penv's existing collision check cannot see it. A sink pushes generated variable names, so it inherits every hazard the `names` block can express.

**These are checked before anything is pushed, never discovered mid-push.** This is `import`'s rule in a second place, for the same reason: `import` resolves every name against the config before it scaffolds a tree or writes a value, because a command that writes half a project and then refuses has already made the drift it was invoked to remove. A push that placed sixty secrets and then hit a reserved name would leave CI in a state neither the tree nor the destination describes. A sink push is all or nothing, and every name is judged against the destination's grammar first.

### A sink is declared in `sinks`, and speaks through the destination's own CLI

**Decision.** Sinks are declared under a `sinks` key in `penv.config.ts`, beside `providers` and never inside it. An environment may have both: a provider holding the truth and a sink receiving it. penv reaches GitHub Actions through the `gh` CLI, holds no GitHub credential of its own, and refuses loudly when `gh` is absent, unauthenticated, or under-scoped rather than falling back to anything.

**Why `sinks` and not `providers`.** The distinction survives in prose only as long as it survives in the config. `providers: { production: { type: "github" } }` would collapse the two concepts at the first place a user reads, and penv would then hold two "providers" — filesystem and GitHub — of which neither can be swapped for the other, while the portability claim quietly counted to two. The config is where a concept is either real or decorative. A team's ordinary shape is a filesystem provider and a GitHub sink for the same environment, which a single key cannot express and two keys express exactly.

**Why `gh` rather than the REST API.** Not for the encryption, though `gh` does it: *"Secret values are locally encrypted before being sent to GitHub"*, which spares penv a libsodium dependency — a WASM one, and honestly not a heavy cost. The reason is credential custody. Calling the API directly means penv needs a GitHub token, which means a config field or `PENV_GITHUB_TOKEN`, which means a personal access token living in someone's shell profile. penv would be shipping a tool that argues a secret in a dotfile is the disease, and requiring a secret in a dotfile to run. `gh auth login` has already happened, the token is `gh`'s to keep, and penv's config gains no field for it. That is the same instinct as never storing an encryption key repo-adjacent, applied to penv's own plumbing rather than to the user's values.

The flags happen to fit: `gh secret set --env <environment>` writes a deployment-environment secret, which is the mapping this RFC already committed to, and `gh secret list --json name,updatedAt` returns exactly what the manual-edit check needs. Those are conveniences. Custody is the argument.

**Values go through stdin.** Not `--body`, because argv is readable by other processes on most systems. Not `--env-file`, despite it accepting the dotenv format `penv generate` already emits — that route writes every production secret to a plaintext temporary file, which is the arrangement penv exists to delete, and round-trips opaque values through dotenv quoting, which the contract suite tests against precisely because it is lossy. One process per parameter is slower and correct, and the slowness is invisible on a command that runs at deploy prep rather than in a loop.

**Rejected.** *A fallback to the REST API when `gh` is missing* — two paths that drift apart, which this RFC rejects for `loadAsync` and which `keys.ts` rejects for key sources in the same words: nothing ever falls back to a weaker source, because a silent downgrade is how a mechanism becomes decoration. penv names which of "not installed", "not authenticated", or "insufficient scope" is true, and stops. *Reading `gh auth token` and calling the API with it* — that reintroduces the libsodium dependency it was meant to avoid while adding a subprocess, and hands penv custody of a token it had just avoided holding.

**Accepted cost, stated not hidden.** penv-the-sink becomes penv plus a tool penv does not control. A breaking change in `gh` is an outage penv did not cause and cannot fix, and `--json` field availability is a version contract that has to be checked rather than assumed. The exposure is bounded — nothing outside the sink needs `gh`, and a project with no sink never invokes it — but it is real, and it is accepted rather than discovered.

### `doctor` answers "I cannot tell" as its own verdict

**Decision.** A `doctor` check reports one of four verdicts: pass, warning, failure, and **unknown** — a check that could not look. Unknown is never rendered as a pass.

**Why.** This is the tri-state the key sources already use — `found`, `absent`, `unavailable` — where "I looked and there is nothing" and "I could not look" are opposite situations with opposite remedies. `doctor` needs the distinction for the same reason, and had been approximating it in two directions at once: a check the schema failure made impossible was reported as a warning, while a browser-exposure check with no declared `publicPrefixes` to check against was reported as a pass — so the line whose entire text said penv had not looked wore the glyph that means penv looked and found nothing wrong. Two answers to one question, and the wrong one was reassuring.

Sinks turn this from a blemish into a structural requirement. Against a write-only destination most of what `doctor` knows is what it cannot know, so a sink report is mostly unknown by construction, and a fourth verdict is what lets it say that out loud rather than in green.

**Unknown is what a sink forces, not what `doctor` becomes.** Against a read-write provider the verdict barely arises: penv reads both copies, compares them value by value, and reports drift exactly — a renamed key in Vault is a definite finding, not a shrug. The fourth verdict exists so that a report which *cannot* reach that standard is unable to imitate one that does. It widens what `doctor` can say honestly; it does not lower what it says when it can see.

**What a sink report can honestly claim.** Three tiers, rendered differently. *Names* are exact, because listing them is the one read the destination does allow: declared-and-never-pushed, and present-in-the-destination-but-undeclared — the `declared` and `unused` pair pointed at a sink instead of a schema. *Values* are unknown, permanently, because they cannot be read back to compare. *Manual edits* are detectable indirectly, and this is the tier that earns the sink its keep. GitHub returns `updated_at` per secret. Compared against the time penv last pushed that parameter, an `updated_at` that is newer means someone edited the secret by hand in the UI — which is precisely the seam a sink exists to close, caught without ever reading a value. The push time lives per environment in meta, which is committed and holds no secret; it records what penv did, and is not a value read back.

The manual-edit check is a warning and never a failure, because of what it actually detects: that something was touched outside penv, not that the two copies differ. An identical hand-edit still flags, and two developers pushing race each other's timestamps. It is a sensitive detector of the right failure mode, not a proof of drift, and it is reported as the former.

**Rejected.** *Omitting a check that cannot run* — printing nothing where a check belongs reads as "nothing found", which is the one thing a report must never imply. *Reporting unknown as a warning* — it makes every sink report permanently yellow, and a warning that can never be cleared is a warning everyone learns to skim past, which costs penv the warnings that are real.

### Migration is one-directional

**Decision.** After `penv import`, `.penv/` is the source of truth and any generated `.env` is an artifact. Hand-edits to the generated `.env` are not absorbed back.

**Why.** Two-way sync would recreate the two-systems-kept-in-sync problem that penv exists to eliminate. Reversibility is preserved differently — `penv generate` always produces a working `.env`, and `env.ts` is a portable Zod schema — so a team can leave without being locked in, without penv maintaining a drift-prone reverse channel.

## Drawbacks

Stated because they are part of what penv is, not hidden. If any is a dealbreaker for a team, penv is the wrong tool for that team, and that is the correct outcome.

1. **More files than a flat `.env`.** Accepted specifically to buy per-parameter access control and independent rotation, which a flat file structurally cannot offer.
2. **Migration restructures the source of truth.** penv is not additive; this is a real migration, reversible but not invisible.
3. **Secrets live in a directory that looks like source.** penv must establish a norm as strong as ".gitignore your `.env`": `penv init` gitignores the value tree, commits only structure/schema/meta/config, and a committed plaintext secret is a `doctor` failure.
4. **An encrypted unscoped default requires the decrypt key for local dev.** A direct consequence of making encryption orthogonal to scope.
5. **Adoption is education-dependent.** penv's value requires believing the model-alignment framing; a team that does not feel the seam pain will not see the point. The target is deliberately narrow.

## Rationale and alternatives

**Why filesystem-native rather than one structured file (SOPS-style)?** A single encrypted structured file gets per-value encryption without the many-files cost. penv chooses per-file storage because the filesystem *is* the structural match to provider path models — the isomorphism that makes provider switching a config change is the point, and it is weaker when the local representation is one opaque blob. SOPS remains the better choice for teams that want per-value encryption without restructuring.

**Why not Infisical / Doppler?** Those are the closest product competitors — hosted dev-to-prod secret platforms. penv differs on three axes: filesystem-native and inspectable rather than platform-hosted; typed runtime access inferred from one Zod schema; and provider *portability* rather than lock-in to one vendor's platform. A team happy inside a hosted platform is not penv's target.

**Why not extend `.env` with a convention?** Conventions on a flat file cannot deliver per-parameter ACLs or independent rotation, because the unit of the file is the file. The addressable unit has to change for those capabilities to exist at all.

**Why so narrow a target market?** Excluding solo developers and t3-env users is deliberate. penv cannot out-compete purpose-built tools on onboarding speed, and pretending otherwise produced the original, weaker positioning.

## Prior art

- **dotenv** — the flat-file baseline penv generates for and imports from, and the source of the value-resolution cascade.
- **Next.js / Vite env loading** — the `.env.local` / `.env.[mode]` / `.env` cascade penv adopts per parameter, including skipping `.local` in test.
- **t3-env** — best-in-class typed local env access; the `load(schema)` generic pattern is shared lineage. penv does not compete on its terrain.
- **SOPS** — per-value encryption in a single structured file; the nearest alternative to penv's per-parameter encryption without the file-tree cost.
- **Infisical / Doppler** — hosted dev-to-prod secret platforms; penv's nearest product competitors.
- **`pass`** — one-file-per-secret, GPG-encrypted, filesystem-hierarchical; the closest structural ancestor to penv's storage model.
- **Vault / AWS SSM / Kubernetes Secrets** — the production providers whose path models penv is isomorphic to. Vault KV v2 and SSM are the strong structural matches, with native versioning penv's rotation grace window reads through; Kubernetes is per-parameter but only three levels deep and retains no history at all, which is why retention is a declared capability rather than a contract verb.
- **GitHub Actions Secrets** — a write-only destination: create, update, delete, and list names, never read a value back. The first sink, and the reason the sink is a concept distinct from a provider.

## Unresolved questions

- **Market demand.** Design risk is well understood; demand is not. The governing open question is how many teams feel the seam pain acutely enough to change their source of truth to fix it — measured against what they have already spent making their existing glue tolerable, not against raw pain. This is validated with customer conversations, not more design.

  **First signal, and it is not the one the design expected.** The teams trialling penv predominantly keep their CI secrets in GitHub Actions Secrets — a sink, not a provider. If a team's production secret story ends at CI injection, that team is not buying provider portability. It is buying `import`, one schema, and a push that deletes the copy/paste.

  That is worth being precise about, because the tempting dismissal — "t3-env plus a sync command" — is wrong, and the accurate reading is more uncomfortable. It is not t3-env's terrain: t3-env types access to `process.env` and has no notion of a destination at all. Deleting the hand-copy from a laptop into CI is the seam this RFC's motivation names in its first paragraph. So these teams are buying penv's actual subject — just the half of it that portability is not. The claim has two halves, delete the seam and make the provider swappable, and a sink delivers the first for one destination while leaving the second exactly where it was.

  Whether these teams also run a provider *behind* CI — Vault or SSM holding what Actions merely reaches — is the question that decides whether the isomorphism thesis has found its market or only its first users. Unanswered, and worth more than any amount of further design.
- **doctor's mapping input.** Cross-provider drift detection requires a declared local↔provider correspondence (from config). The minimal day-one configuration that yields a useful report without false positives needs specification.
- **Exit-path detail.** "Reversible" is guaranteed in principle (`penv generate` + a portable schema); the fully documented reverse workflow is worth writing down for cautious adopters who evaluate the exit before the entrance.

- **Ordering on round-trip.** `import` → `generate` preserves every value, and preserves comments attached to a variable by mapping them to that parameter's `description`. It does not preserve the source file's *ordering*, because one-value-per-file discards it by construction: reproducing it would mean recording a source line number in meta, which is presentation data in a file that otherwise holds policy. `generate` therefore emits a deterministic sorted order — stable and diffable across machines, at the cost of not matching the input's original sequence. Whether any team feels that loss is unmeasured; if one does, the question is where ordering could live without turning meta into a rendering hint. Deliberately not settled, and not a commitment on the roadmap until it is.

## Future possibilities

Genuinely speculative directions, distinct from the settled design above: team key-sharing UX; automatic rotation scheduling; per-parameter version history and audit metadata; a community provider plugin ecosystem; IDE integration. These are recorded as possibilities, not commitments. When any becomes a commitment, it appears on the roadmap with a version.

## Guiding principle

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.