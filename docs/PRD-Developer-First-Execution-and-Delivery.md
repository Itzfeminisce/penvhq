# PRD — Developer-first execution and delivery

## Status and scope

This is a local implementation PRD for native Penv. It records the product decisions made for a
complete `penv init` adoption journey, a version-safe global launcher, local command execution,
and deployment artifacts. It deliberately keeps Penv Cloud's managed delivery control plane out
of the OSS provider contract; that optional hosted capability is described only where its boundary
matters to native Penv.

This PRD is subordinate to the repository invariants in `AGENTS.md`. In particular, every value
file remains ignored by default. A future option to commit sealed records is a separate security
decision requiring explicit human sign-off, not part of this PRD's implementation scope.

## Problem statement

Penv has the right durable model—one schema, a local parameter tree, and a provider that is a
sync boundary—but adoption currently asks a new developer to remember several Penv-specific
commands and leaves generated `penv.snapshot.ts` coupled to an application's source and bundler.

The desired everyday experience is familiar:

```sh
penv run --env development --source project -- pnpm dev
```

Penv must work like other secret-manager command runners without inheriting their runtime network
dependency. A remote provider may be unavailable at application start; a previously materialized
project or deployment artifact must still start locally and deterministically.

The design must also remain trustworthy for complex package scripts. Penv cannot safely parse,
rewrite, or emulate arbitrary shell syntax and package-manager lifecycle hooks. It must start the
user's command as an opaque child process, preserving `predev`, `dev`, `postdev`, pipes, shell
syntax, and future package-manager behavior.

## Solution

Penv becomes a two-part product:

1. A globally installed, stable **launcher** locates an exact, project-pinned Penv engine and its
   verified extensions.
2. The project retains exactly one runtime dependency, `@penvhq/penv`, for typed `@env` access.
   It is version-pinned to the same release as the engine.

`penv init` is a one-off, conversational adoption command. It detects dotenv files, lets the
developer select a complete environment cutover, creates the project schema/configuration and
runtime dependency, imports values, validates the result, then moves active dotenv files out of
framework discovery. It never changes `package.json` scripts automatically. The developer uses
the normal package-manager script underneath `penv run`:

```sh
penv run --env development --source project -- pnpm dev
```

`penv run` resolves locally, validates, creates a deliberately owned child environment, and starts
the exact command after `--`. It never contacts a provider. Remote providers are used only by
explicit sync commands such as `penv pull` and `penv push`.

For containers and VMs, CI creates an external, environment-specific sealed delivery artifact and
`penv run --source snapshot` consumes it. For managed serverless targets that own process startup
(such as Vercel or Cloudflare), native platform environment delivery is the correct mechanism; no
TypeScript snapshot file is generated or imported by the application.

## User stories

1. As a new developer, I want `penv init` to guide me from detected dotenv files to a working,
   validated project so I do not have to assemble Penv commands from documentation.
2. As a developer, I want to select exactly which detected dotenv files Penv adopts so deployment
   environments are never invented from filenames.
3. As a developer with only local needs, I want `penv init --yes` to create a development-only
   filesystem project so non-interactive onboarding is useful without inventing production.
4. As a developer, I want Penv to refuse a partial dotenv cutover that would leave my framework
   reading both dotenv files and Penv-injected values.
5. As a developer, I want one temporary undo path after adoption so I can restore the prior
   dotenv files and script-free project state if I decide not to continue.
6. As an application developer, I want `import { env } from "@env"` to stay typed and validated
   while ordinary dependencies can continue to read the child process environment.
7. As a developer, I want to start any package-manager command under Penv without Penv parsing
   or changing its pipes, redirects, lifecycle hooks, shell syntax, or arguments.
8. As a developer, I want a remote provider to be an explicit refresh operation, not a network
   condition for each application startup.
9. As a developer with a personal local override, I want `penv pull` to preserve `.local` values
   while replacing provider-owned shared values.
10. As a developer, I want an optional `--watch` mode that refreshes and restarts my development
    child only when I expressly opt into network-backed watching.
11. As a team, I want a project to pin the exact Penv engine and provider extensions it needs so
    opening another project cannot silently change behavior.
12. As a team, I want only one Penv package in the project's runtime dependencies, rather than a
    CLI package and a separate provider package for every configured provider.
13. As a team, I want provider configuration to remain typed even when provider adapter code is
    installed by the launcher instead of the application's package manager.
14. As a security-conscious team, I want Penv to load extensions only for explicit provider
    operations and never merely because an application starts.
15. As a maintainer, I want untrusted third-party extension selection to be visible and reviewed,
    with exact integrity, publisher identity, and a minimum-age default.
16. As a production operator, I want a container to start from one sealed deployment artifact,
    without its application importing a generated snapshot module or contacting a secret provider.
17. As a serverless operator, I want native platform environment delivery before the platform
    builds/runs my app, so build-time configuration works without bundler-specific Penv files.
18. As an operator, I want Penv to fail before child startup if its project/snapshot inputs are
    missing, stale, incompatible, undecryptable, or would expose a secret to a public prefix.
19. As an existing Penv user, I want an explicit migration that preserves my schema and loader
    files and never silently moves or rewrites my source tree.
20. As a Penv Cloud user, I want native Penv's offline runtime behavior to remain unchanged while
    optional hosted delivery can be layered on independently.

## Implementation decisions

### 1. Ownership and project layout

The project has three ownership zones:

```text
project root/
  penv.schema.ts                 developer-owned schema shape
  penv.config.ts                 developer-owned project policy

  .penv/
    env.ts                       generated once, then project-owned loader bridge
    state/                       Penv-managed state
      manifest.json              committed engine/extension lock
      .gitignore                 committed safety boundary
      records/                   canonical local parameter tree
      extensions/*.d.ts          committed type-only declarations
      cutover.json               temporary adoption recovery state, when needed
      rollback/dotenv/           ignored, temporary original dotenv files
```

`penv.schema.ts` remains the one editable Zod schema. `penv.config.ts` remains visible TypeScript
policy—not generated hidden state—because it declares the environment whitelist, provider
locations, encryption key sources, public prefixes, and explicit name overrides. `.penv/env.ts`
continues to be generated once and is never overwritten.

`.penv/state/` holds Penv-managed project state, not append-only secret history. It must not be used
as an audit or rotation version store; provider history remains provider-owned.

All plaintext values, including `.local` values, remain ignored. The initial layout migration moves
the current parameter tree underneath `.penv/state/records`; its grammar, cascade, metadata, AAD,
and provider serialization remain unchanged.

### 2. Manifest and launcher

`.penv/state/manifest.json` is a deliberately small, committed launcher contract. It contains layout
format, exact engine version/integrity, and selected extension version/integrity. It contains no
secret values, keys, provider credentials, absolute machine paths, provider configuration, or
snapshot data.

The global `penv` executable is a stable launcher. Outside a project it uses its bundled current
engine to run `init`. Inside a project it reads only the manifest's stable format, finds the exact
verified engine and extensions in `$PENV_HOME`, then delegates every substantive command to that
engine. A newer global launcher never upgrades a project; only an explicit `penv upgrade [version]`
updates the manifest and the project's `@penvhq/penv` dependency together.

Interactive developer use may download a missing, integrity-pinned engine/extension once. CI and
production never download during `run`; they preinstall the exact manifest contents and fail with
an actionable message if absent. The launcher retains the actual installation method so an
unsupported manifest error prints its precise update command and the command the user was running.

### 3. One runtime dependency and typed provider configuration

Each adopted project has one exact runtime dependency:

```json
{ "@penvhq/penv": "<same exact version as manifest engine>" }
```

It supplies the typed `@env` surface and validation helpers, not a full provider/CLI distribution.
The launcher owns the CLI engine and provider extensions.

Provider extensions remain independently versioned packages. `penv add <package>` verifies and
records a chosen extension in the manifest, installs it in the launcher cache, and offers—but does
not assume—an interactive update to `penv.config.ts`. It never adds the extension to
`package.json`.

An installed provider contributes a generated, committed, type-only declaration under
`.penv/state/extensions`. That declaration augments provider configuration typing without loading the
adapter into the application. Generated declarations contain no adapter code, credentials, values,
or key material.

Official extensions come from Penv's signed registry. Public third-party extensions have a
seven-day minimum package-age default; an override is committed in the manifest with publisher,
exact integrity, timestamp, and human reason. Private/custom extensions require explicit trust
acknowledgement. Integrity proves downloaded bytes; it does not make arbitrary executable code
trustworthy. Therefore extensions run only in explicit provider operations and receive only their
declared credentials, not the caller's complete environment.

### 4. `penv run` contract

`penv run` is the generic, opaque command runner:

```sh
penv run --env <declared-environment> --source project -- <command> [arguments...]
penv run --env <declared-environment> --source snapshot -- <command> [arguments...]
```

It starts the command directly, preserving exact argument boundaries and child exit/signal status.
The command after `--` can be `pnpm dev`, `npm run start`, `node index.js`, Python, Go, or any
other runtime. Because the package manager remains the child, it retains sole ownership of
`pre*`/main/`post*` lifecycle behavior and all shell language in its scripts. Penv never rewrites
scripts, detects operators, renames lifecycle hooks, or creates generated backing scripts.

`--source project` reads only the local `.penv/state/records/` tree. `--source snapshot` reads only
the path provided by `PENV_SNAPSHOT`. `--source` defaults to `project` and `snapshot` is always
named (seal 2), so naming a source in a script is recommended rather than required; no `provider`
source exists. Internal runtime APIs may keep an `auto` compatibility mode only where required by
existing library behavior.

Before spawning, Penv resolves the existing cascade, validates against the schema, applies explicit
variable mappings, checks public-prefix policy, and prepares an owned child environment. Every
schema-declared mapped variable is overwritten with Penv's resolved value or deleted from the child
if optional/absent. Unrelated host variables such as `PATH` remain intact. Penv removes its key
variables, provider credentials, and internal control variables before starting the application.

The application's typed bridge validates the injected environment only. It does not reopen the
records tree or the artifact, and never calls a provider. Starting an adopted app directly outside
`penv run` fails with a parameter-named remediation command.

`penv run` is network-forbidden. A missing project materialization or snapshot is a named failure,
not an occasion to fetch from a provider.

### 5. Remote providers and optional development watch

Remote providers remain an explicit sync boundary:

```text
provider -- penv pull --env development --> project records
project records -- penv run --source project --> child process environment
```

`pull` replaces provider-owned non-local records and preserves `.local` and environment-local
overrides. It never runs implicitly during application startup.

`penv run --watch --source project -- ...` is an opt-in development mode. It may watch/synchronize
the configured remote source, preserve local overrides, validate the complete next state, and only
then restart the child. A failed pull or validation leaves the current child running. Watch is not
the default `run` contract and is not the production delivery mechanism.

### 6. Complete dotenv adoption with `init`

`penv init` is the primary onboarding command. It detects dotenv files and presents a flat file
selection, preselecting the development cascade where it is present:

```text
[x] .env                      shared default
[x] .env.local                local override
[x] .env.development          development
[x] .env.development.local    development-local
[ ] .env.production           production
```

Selecting an environment-scoped file explicitly declares that environment. Selecting `.env` alone
does not declare an environment. The initial schema is a clearly labelled draft: fields observed in
every selected environment may begin required; fields absent in any selected environment begin
optional. Init never infers per-environment requiredness from dotenv observations.

`init --yes` on a new project uses only the explicit safe default of `development` with the
filesystem provider. It never invents production, staging, preview, or another deployment
environment. When detected files show another environment that depends on a shared `.env` fallback,
`--yes` refuses before changing files and requires an interactive complete cutover.

No partial cutover may activate Penv. Before moving any dotenv file, init must preflight every
selected file, environment declaration, grammar collision, schema draft, dependency installation,
and target variable mapping. It must also ensure all framework-discoverable dotenv files relevant
to the command's cascade are included. If not, it may prepare/import nothing but must not offer an
active Penv runtime, archive files, or claim migration is complete.

On an approved complete cutover, init stages/imports and validates first, then moves the prior
active dotenv files to one ignored temporary rollback bundle. It records one cutover state so
`penv init undo` can restore those files. This is recovery for a single migration—not local secret
versioning. A later `penv cleanup` removes it. A second migration refuses while the first rollback
bundle is unresolved.

`init` installs the exact runtime package using the detected package manager only after showing the
exact `package.json` and lockfile change. If installation is declined or fails, it performs no
cutover. It never automatically creates encryption keys, seals values, creates deployment
artifacts, authenticates with providers, or publishes hosted delivery contracts. It presents those
commands when the project has reached the prerequisite state.

After a successful cutover, `penv run` refuses framework-active `.env`, `.env.local`,
`.env.<environment>`, and `.env.<environment>.local` files so later edits cannot recreate two
active configuration sources. Documentation examples such as `.env.example` are excluded from
this check.

### 7. Deployment artifacts replace generated `penv.snapshot.ts`

The generated TypeScript `penv.snapshot.ts` model is retired for new projects. New `.penv/env.ts`
does not import a snapshot module.

For a container/VM release, CI performs an explicit sequence:

```text
pull target environment -> validate -> build target delivery artifact -> package/mount artifact
```

The artifact is canonical JSON or a binary format, not application source. It is environment- and
release-specific, stored outside Git and outside the application source tree, and read directly by
the launcher. It contains only the final resolved, non-local winner for each schema-declared
delivery mapping, sealed ciphertext where encryption applies, exact engine/format compatibility,
environment, non-secret delivery-contract digest, and the key-source identifier. It contains no
provider configuration, provider credentials, plaintext values, key material, or irrelevant
fallback records.

At runtime `penv run --source snapshot` verifies exact environment, engine/format, and delivery
contract compatibility before decrypting in memory and injecting the owned child environment. It
does not need source files, provider adapters, or network access.

Managed serverless platforms own the parent process. For those targets, Penv must deliver values
to the platform's native encrypted environment store before its build/deployment; the platform
then supplies the app's `process.env`. The typed bridge validates that injected environment.
An artifact placed in `dist` does not make a platform load it, so external snapshots are not the
serverless fallback.

### 8. Penv Cloud boundary

Penv Cloud can offer a hosted, optional delivery control plane: a non-secret delivery contract,
managed target sync, target-specific activation, and auditable desired/applied state. It is not
native Penv behavior and must not alter the generic provider contract to make it fit.

Native Penv remains:

```text
pull = explicit materialization
run  = local project or snapshot execution, no provider network request
```

Penv Cloud managed delivery, if configured, is responsible for automating platform-native target
updates. It is not a CI/CD system: customer Git/CI owns checkout, build, tests, approvals, branch
policy, release selection, traffic, and rollback. Penv Cloud may request activation only for an
explicitly approved deployment target. It must never infer production from the `main` branch.

### 9. Existing project migration

Existing projects continue to work under their current layout. A deliberate `penv migrate` previews
and on approval adds the `.penv/state/` manifest, relocates the parameter tree, updates the exact
runtime dependency and lockfile, and leaves `penv.schema.ts`, `.penv/env.ts`, and legacy
`penv.snapshot.ts` untouched. The legacy snapshot may be cleaned up only by a separate explicit
command.

The new engine supports old layout during the migration window. It never moves a project tree,
rewrites user-owned schema/loader modules, or changes runtime behavior merely because a global
launcher was upgraded.

**Superseded (2026-08-17).** The engine reads only the new layout. An old-layout project gets one
refusal naming `penv migrate`, because an engine that reads both layouts is a tool with two truths
about where a project's values live. The rest of this section stands: `migrate` previews, moves
nothing user-owned, and changes no runtime behavior because a launcher was upgraded. The roadmap's
v0.9 entry owns this claim.

## Testing decisions

- Test the launcher protocol independently: manifest-format rejection, exact engine selection,
  integrity mismatch, offline missing-engine error, and installation-method-specific update
  remedies.
- Test manifest parsing and extension resolution as a deep, stable module. Ensure the manifest
  cannot carry values, credentials, keys, provider config, or absolute machine paths.
- Test `run` end-to-end with direct commands and package-manager children. Assert inherited
  lifecycle behavior without testing Penv's implementation of lifecycle semantics.
- Test source isolation: project and snapshot start without network/provider construction;
  `--watch` is the only run mode permitted to synchronize.
- Test child-environment ownership: declared values overwrite stale host values, absent optional
  values are deleted, unrelated variables remain, and Penv/provider credentials do not reach the
  child.
- Test the existing cascade unchanged at the new records root, including test-environment local
  exclusions, decrypt failure distinct from absence, AAD address binding, and doctor fallback
  reporting.
- Test init as an all-or-nothing cutover: multi-file preflight failures produce no archive or
  active runtime; successful cutover creates one rollback bundle; undo restores exact dotenv
  names; a later active dotenv file blocks `run`.
- Test `--yes` development defaults only for clean/new projects and refusal when shared defaults
  are also required by unselected environments.
- Test draft schema generation from multiple selected dotenv files without inferring production
  requiredness.
- Test project dependency/package-manager edits through file fixtures and preserve unrelated
  manifest formatting where existing init behavior does so.
- Test snapshot artifacts for exact environment/engine/contract matching, no local records,
  no plaintext, no provider details, and no source-module requirement.
- Test public-prefix rejection before child startup for secret-to-public mappings.
- Test legacy project migration against fixtures for both old and new layouts; assert user-owned
  schema/loader files are byte-identical.
- Test provider extensions for official/private/young-package trust paths, exact integrity, type
  declaration generation, declared-credential filtering, and no extension load during `run`.

## Out of scope

- Automatic rewriting of `package.json` scripts, lifecycle hooks, or arbitrary shell commands.
- Provider network reads at normal process startup.
- A new per-environment schema, generated replacement schema/types, or inferred deployment
  environment whitelist.
- Automatic key creation, encryption/sealing, snapshot/artifact generation, provider
  authentication, or remote provider configuration during init.
- Committing plaintext value records. Committed sealed records are also excluded pending a specific
  human decision to amend the current value-file gitignore invariant.
- A generic provider-contract capability for Penv Cloud managed delivery.
- Runtime secret polling, application SDK fetch-at-boot, or a promise that a running process's
  `process.env` can be changed in place.
- Penv Cloud becoming a CI/CD platform or inferring production from a branch.
- Auto-created preview environments or bulk secret propagation into every pull request deployment.

## Further notes

The command-runner ergonomics intentionally resemble Doppler and Infisical, but the runtime
boundary is different: Penv materializes before `run`; `run` remains entirely local. That preserves
the native value proposition while retaining the familiar parent-process model needed for package
manager correctness.

The most important product boundary is not the directory name or manifest format. It is this:

```text
Penv owns the schema-driven local/runtime path.
Providers own remote records and access control.
Penv Cloud may add an optional hosted delivery control plane.
```

Each layer has a single job and does not silently take over the other two.

## Adoption friction review — to seal before build

The abstractions above are correct, but several charge the newcomer at the exact moment they are
deciding whether to keep penv. Each item below names the friction and the seal — a decision to
record, wording to fix, or a cost accepted with its mitigation. Resolving this section closes the
PRD for implementation.

**Resolved 2026-08-17.** One amended (item 1), nine approved as written, and item 5 approved as
`.penv/state/`. Each item carries its verdict below, and the PRD is closed for implementation —
`docs/rebuild/` carries the issue set that builds it.

### 1. Where the wrapper lives

The PRD's examples show a human typing `penv run --env development --source project -- pnpm dev`,
and muscle memory is the cost. In-script wrapping looks cheaper, but the command after `--` is the
developer's own and unpredictable — penv cannot compose or suggest a script line containing it
without guessing. The two placements are also not equivalent: wrapped outside, `pre*`/`post*`
hooks run inside penv's environment; wrapped inside a script, they run before it exists.
**Seal:** wrapper-outside stays the blessed form; seals 2 and 3 are what shorten the daily command
to `penv run -- pnpm dev`. In-script wrapping remains permitted but entirely developer-authored,
documented with the hook-environment difference. A nested `penv run` (an outer wrapper meeting an
in-script one) is refused, naming both invocations.

**Verdict (2026-08-17): amended** — the seal above is the amended text; wrapper-outside stays blessed.

### 2. `--source` on every run

Only two sources exist, and one is for CI/artifacts. `--source project` is ceremony for the
interactive user.
**Seal:** `--source` defaults to `project`; `snapshot` must always be named. This amends "public
scripts always name a source explicitly" from command-required to recommended-in-scripts.

**Verdict (2026-08-17): approved as written.**

### 3. `--env` on every command

Dotenv users typed nothing; penv asks for `--env` on `run`, `pull`, `set`, and everything else. A
`defaultEnvironment` declared in `penv.config.ts` is a recorded decision, not inference —
the environments-are-a-whitelist invariant stands untouched.
**Seal:** add declared `defaultEnvironment`; `init` proposes `development` when the development
cascade was adopted. CI continues to name `--env` explicitly.

**Verdict (2026-08-17): approved as written.**

### 4. Three version concepts

Launcher, engine, and runtime dependency are the right machinery, but if any happy-path output or
error asks the user to reason about *which* of three versions is wrong, the abstraction leaks.
**Seal:** one user-visible version. `penv --version` prints one line; the split surfaces only in
the unsupported-manifest error, which prints the exact remedial command and nothing to diagnose.

**Verdict (2026-08-17): approved as written.**

### 5. A name that needs a footnote

`_journal` requires a disclaimer in this very PRD ("not append-only secret history"). A name that
must be explained mis-teaches at first sight, and the layout is committed — renaming later is a
migration.
**Seal:** decide the name before code exists. Recommended: `.penv/state/`. Otherwise accept
`_journal` explicitly and delete this item.

**Verdict (2026-08-17): approved as `.penv/state/`** — the `_journal` name is dead, and sections 1
to 3 above are written in the new one.

### 6. Adding an official extension

The trust model — age gates, trust blocks, acknowledgements — exists for strangers. If
`penv add @penvhq/provider-vault` asks even one trust question, the safety abstraction has taxed
the blessed path.
**Seal:** official-scope `add` verifies provenance silently and asks nothing beyond the config
edit it already offers.

**Verdict (2026-08-17): approved as written.**

### 7. The gap between `add` and first use

`add` records the extension; onboarding (`penv cloud login`) is a second command the user must
discover.
**Seal:** `add` ends by offering the provider's declared onboarding step — the same
offer-never-assume rule as the config edit.

**Verdict (2026-08-17): approved as written.**

### 8. The key-authority question (Cloud boundary)

The one hard question in the whole journey, asked during login, permanent per environment, and
naturally phrased in cryptography. It cannot be removed, but it can be priced in one sentence per
option.
**Seal (jointly with the Cloud PRD):** Cloud-managed is the preselected default; each option
carries exactly one consequence line ("Cloud can deliver to your targets" / "Cloud can never read
these — and can never deliver them"); opaque is always chosen, never defaulted into; permanence is
stated in the prompt itself.

**Verdict (2026-08-17): approved as written.**

### 9. The schema meets the first run

If the drafted schema fails the first `penv run` after cutover, the newcomer's reward for adopting
is a Zod error in a file they did not write.
**Seal as acceptance criterion:** the first run after a successful cutover passes with zero edits
to `penv.schema.ts`, for every adoption fixture in the test suite.

**Verdict (2026-08-17): approved as written.**

### 10. Refusals are the product

This design refuses often, on purpose: partial cutovers, direct starts, recreated dotenv files,
missing pulls. Every refusal lands on someone mid-task who has not read this PRD.
**Seal as acceptance criterion:** every refusal names exactly one next command. The two
highest-traffic refusals — a direct start outside `penv run`, and a teammate's first missing
`pull` — get their copy written and reviewed here in the spec, not improvised in code.

**Verdict (2026-08-17): approved as written.**

### 11. Accepted cost: deploys need a pipeline edit

Retiring the committed snapshot means a clone no longer deploys by itself; CI must build the
sealed artifact. This is the rebuild's central reversal and stands — but it is also the adoption
step most likely to stall a team.
**Mitigation, shipped with v1:** copy-paste artifact recipes for the major CI systems and
platform-native delivery guides for Vercel/Cloudflare, in the docs at launch, not after.

**Verdict (2026-08-17): approved as written** — the cost is accepted and the mitigation is scoped
into the v0.9 milestone.
