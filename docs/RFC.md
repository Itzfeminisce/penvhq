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

## Decisions and their reasoning

Each subsection records a decision and *why* it was made that way, including the alternative that was rejected. These are the load-bearing choices; the documentation states them as rules, this RFC states why they are rules.

### Value resolution follows the established `.env` cascade

**Decision.** Values resolve by scope, most-specific first: `<name>.local` > `<name>.<env>` > `<name>`. This is flat override — a more specific scope replaces a less specific one wholesale. `.local` is skipped in the `test` environment.

**Why.** dotenv, Next.js, and Vite already converged on exactly this cascade, and developers have it in muscle memory. Inventing a different resolution order would impose a learning cost for no benefit. Adopting the known cascade means "if you understand how `.env.local` beats `.env`, you understand penv's value resolution." Skipping `.local` in test is borrowed from the same tools, which solved test-reproducibility this way already.

**Rejected.** A penv-specific precedence scheme, and any form of value *merging*. Values are opaque; there is nothing to merge, and merging opaque values would be a novelty with no precedent and no upside.

### Meta merges hierarchically and shallowly

**Decision.** A parameter's meta file has a base object and per-environment blocks. An environment block overrides the base per top-level key and inherits the rest. Nested objects are replaced wholesale, not deep-merged. `.local` does not participate.

**Why.** Meta is the one structure the `.env` ecosystem never had to handle, so there is no cascade to inherit — but the ecosystem's consistent preference for flat override over deep-merge tells us which way to lean. Shallow merge preserves a legibility property that is central to penv: the effective meta for any environment is computed by reading exactly two objects (base and that environment) and overlaying keys. Deep-merge breaks that "read two things" property and makes effective policy hard to reason about. Replace-wholesale at the top level was rejected earlier for a related reason — it would silently wipe base fields like `description` on a partial override — so the settled rule is shallow per-key merge: neither deep nor wholesale-replace.

**Rejected.** Deep-merge (too clever, illegible) and wholesale-replace (silently destructive). `.local` in meta was rejected because policy is a property of the shared parameter, not of a developer's machine.

### Encryption is orthogonal to scope

**Decision.** Any value file may be encrypted with a terminal `.enc` marker, at any scope, including the unscoped default. `.enc` is always last; the scope segment precedes it. Meta is always plaintext.

**Why.** Encryption is a storage property, not a precedence axis. Making it orthogonal keeps the grammar composable — an encrypted value competes for precedence exactly as its plaintext equivalent would — rather than coupling "is this secret" to "which environment is this." Whether a parameter *must* be encrypted is expressed as policy in meta and validated against the on-disk marker, so a committed plaintext secret is a detectable `doctor` failure rather than an invisible mistake.

**Accepted cost, stated not hidden.** Because the unscoped default doubles as the local-dev value, encrypting it (`<name>.enc`) means a developer needs the decrypt key to run locally. This is a real ergonomic cost of that particular choice; penv permits it and documents it rather than forbidding it, leaving the scope-of-encryption decision to the team.

### Rotation state lives in meta and the provider, never in filenames

**Decision.** The value file is always the current value. Rotation phase (`rotationState`, `rotatingSince`, etc.) lives in meta; the previous value, during a grace window, lives in the provider. There is no `.current`/`.previous` value-filename suffix.

**Why.** A prototype surfaced this as the key design bug: if rotation state is encoded in filenames, the value tree changes shape mid-rotation, `.previous` files appear and must be cleaned up, and an interrupted rotation orphans ghost state inside the source of truth — the exact thing penv exists to avoid. Keeping rotation phase out of the value-filename namespace also protects the single-schema invariant. The consequence — filesystem-backed environments cannot exercise true dual-valid rotation, because dual validity is a property of a live system — is stated deliberately rather than discovered later. Local rehearsal is a mock-provider concern.

**Two rotation modes, not one.** `dual-valid` (grace-window overlap) and `atomic-cutover` (immediate flip, overlap only at the infra layer) are distinct mechanisms and are never unified into one code path. `lastRotated` (last completed rotation) and `rotatingSince` (current rotation's start) are distinct clocks, because the overdue check and the stuck check measure different things; collapsing them breaks stuck detection. Stuck detection is gated to `dual-valid` so atomic-cutover passwords are never false-flagged.

### Environments are a whitelist, never inferred

**Decision.** Valid environment names are declared in `penv.config.ts`. A filename segment is an environment only if it appears in that whitelist.

**Why.** Inference from folder or filename structure would make environment scoping ambiguous against namespace folders. The whitelist removes the ambiguity entirely: a segment is an environment because it was declared, not because a heuristic guessed. This is why the parameter grammar is suffix-based and flat rather than nested-per-environment — nested folders collide with namespace folders, suffixes plus a whitelist do not.

### One schema, imported from the project, not the package

**Decision.** There is one Zod schema per project, in `.penv/env.ts`. Application code reads `import { env } from "@env"`, where `@env` is a tsconfig alias for `.penv/env.ts`. `env.ts` exports both the `schema` (the shape) and `env = load(schema)` (the loaded values). `load` is generic, returning `z.infer<T>`.

**Why.** The type must come from the user's schema, but a published package cannot know the user's schema. Three mechanisms were weighed. Module augmentation (`declare module "penv"`) works but hides a coupling the reader cannot see at the callsite. Codegenerating a `.d.ts` from the schema was rejected outright: a generated type is a *second representation* that can drift from the schema, which is precisely the disease penv treats — using `z.infer` directly means the schema is the only representation and the type cannot disagree with it. The chosen mechanism — a generic `load` applied to a schema the user imports from their own project — is honest at the callsite (the import path points at the file the type comes from), requires no augmentation, and involves no codegen. `penv init` scaffolds `env.ts` once and never regenerates it; it is the user's file. The alias is generated, the file is not.

**A note on why the type is trustworthy.** `z.infer` is a compile-time promise. It is made true by `load` validating the loaded values against the same schema at runtime and throwing on mismatch. Inference and validation from one schema is what makes "type-safe" a guarantee rather than an aspiration. `load` is eager — importing `env` loads and validates immediately — so invalid configuration fails at startup, not at first use; type-only consumers import `schema` instead to avoid triggering the load.

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
- **Vault / AWS SSM / Kubernetes Secrets** — the production providers whose path models penv is isomorphic to.

## Unresolved questions

- **Market demand.** Design risk is well understood; demand is not. The governing open question is how many teams feel the seam pain acutely enough to change their source of truth to fix it — measured against what they have already spent making their existing glue tolerable, not against raw pain. This is validated with customer conversations, not more design.
- **doctor's mapping input.** Cross-provider drift detection requires a declared local↔provider correspondence (from config). The minimal day-one configuration that yields a useful report without false positives needs specification.
- **Exit-path detail.** "Reversible" is guaranteed in principle (`penv generate` + a portable schema); the fully documented reverse workflow is worth writing down for cautious adopters who evaluate the exit before the entrance.

- **Ordering on round-trip.** `import` → `generate` preserves every value, and preserves comments attached to a variable by mapping them to that parameter's `description`. It does not preserve the source file's *ordering*, because one-value-per-file discards it by construction: reproducing it would mean recording a source line number in meta, which is presentation data in a file that otherwise holds policy. `generate` therefore emits a deterministic sorted order — stable and diffable across machines, at the cost of not matching the input's original sequence. Whether any team feels that loss is unmeasured; if one does, the question is where ordering could live without turning meta into a rendering hint. Deliberately not settled, and not a commitment on the roadmap until it is.

## Future possibilities

Genuinely speculative directions, distinct from the settled design above: team key-sharing UX; automatic rotation scheduling; per-parameter version history and audit metadata; a community provider plugin ecosystem; IDE integration. These are recorded as possibilities, not commitments. When any becomes a commitment, it appears on the roadmap with a version.

## Guiding principle

> Configuration should be treated as structured data — not a flat text file, and not two disconnected systems kept in sync by hand.