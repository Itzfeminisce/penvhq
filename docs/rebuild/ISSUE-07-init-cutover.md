# ISSUE-07 — `penv init`: the all-or-nothing dotenv cutover

**Branch:** `issue/07-init-cutover` · **Wave 4** (after 05 + 06 merge).

## Goal

Rebuild `penv init` per PRD §6: detection, complete cutover, draft schema, rollback bundle with
undo, `--yes` development-only mode — plus the sealed acceptance bar: the first `penv run` after
cutover succeeds with zero schema edits.

## Read first

PRD §6 and §1, friction items 1, 3, 9, 10; existing `packages/cli/src/commands/init.ts` and its
tests (salvage what fits the PRD, delete what doesn't).

## Settled decisions (do not relitigate)

- Flat file selection of detected dotenv files, development cascade preselected. Selecting an
  environment-scoped file declares that environment; `.env` alone declares nothing.
- Draft schema: fields observed in every selected environment start required; absent in any start
  optional. Never per-environment requiredness inference.
- `init --yes` on a clean project: `development` + filesystem provider only; refuses (before
  changing anything) when detected files show another environment leaning on a shared `.env`.
- Preflight everything (selection, declarations, grammar collisions, schema draft, dependency
  install plan, target mappings) before moving any file. A failed preflight changes nothing and
  never claims partial success.
- Cutover: stage/import/validate first, then move prior active dotenv files to
  `.penv/state/rollback/dotenv/` (ignored), write `.penv/state/cutover.json`. `penv init undo`
  restores exact names; `penv cleanup` removes the bundle; a second migration refuses while a
  bundle is unresolved.
- Init writes `defaultEnvironment: "development"` when the development cascade was adopted
  (seal 3).
- Init installs `@penvhq/penv` (exact version) with the detected package manager only after
  showing the exact `package.json`/lockfile change; declined install = no cutover.
- Init never edits `package.json` scripts. It ends by *showing* the wrapper-outside daily command
  (`penv run -- <detected script runner> dev`) as copy, never writing it (seal 1 as amended).
- After cutover, `penv run` refuses framework-active `.env*` files that reappear (excluding
  `.env.example` and friends); implement that check here, in run's preflight, with sealed copy.
- No keys, sealing, artifacts, provider auth, or contract publishing during init — it names those
  commands when the project is ready for them.

## Tasks

1. Rebuild init per the above; keep the conversational flow one screen at a time, minimal
   questions, sensible defaults (detected facts proposed, deployment facts asked).
2. Fixtures: at minimum — Next-style cascade, bare `.env` only, multi-env with shared fallback,
   already-adopted project, `--yes` clean and `--yes` refusing. For every adoption fixture, the
   acceptance test runs `penv run -- node -e "…"` immediately after cutover and it must pass with
   the drafted schema unedited (friction item 9).
3. Undo/cleanup tests: exact filename restoration, refusal on second migration, cleanup removes
   the bundle and only the bundle.
4. Refusal copy asserted verbatim; each names exactly one next command.

## Out of scope

Provider onboarding (08), artifacts (09), migration of old penv layouts (03 shipped it).

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; the zero-schema-edit first-run test exists per
fixture and passes.

## Decisions log

**A selection that declares no environment is asked, not decided.** `.env` alone declares nothing
(settled), but a cutover that declares no environment produces a project `penv run` cannot start —
which fails the friction-9 bar for the bare-`.env` fixture. So init asks one question,
`environment · Enter for development`, and refuses (`INIT_ENVIRONMENT_UNNAMED`) when it is answered
by nobody. Proposing `development` in a prompt a human answers is the same permission `--yes`
already has; inferring it silently is what invariant 10 forbids.

**`defaultEnvironment` is `development` when it was adopted, else the sole adopted environment.**
Seal 3 covers the first case. The second is the smallest extension that keeps the daily command
working for a project that adopted exactly one environment under another name; two or more with no
`development` among them writes no default, because which one a bare `penv run` should mean is then
a fact penv cannot read.

**`--yes` on a project with nothing to adopt still declares `development`.** PRD §6 says `--yes` on
a new project uses the explicit safe default of `development` with the filesystem provider, which
supersedes the shipped "environments still start empty under `--yes`". It is applied in `planInit`
behind a flag rather than in the command, so the printed notes and the written config cannot
disagree. A run with no terminal and no `--yes` still declares nothing: absence of a terminal is not
consent.

**`state/.gitignore` re-excludes `/cutover.json`.** ISSUE-03 left the narrowing here. `!*.json` is
there for meta and the manifest; `cutover.json` names a rollback bundle that exists on one machine,
so a teammate who cloned it would be told a migration they never ran is unresolved — `penv init`
refused, `penv init undo` offering to restore files that are not there.

**`penv run`'s reappearance check is unconditional, not gated on a recorded cutover.** A
framework-active dotenv file beside penv's records is two live sources whether or not this project
was the one that migrated. It is judged against the declared whitelist (`.env.staging` in a project
with no `staging` is loaded by nothing) and excludes `.env.example`/`.sample`/`.template`, plus
`.env.backup`, which `penv import` itself writes.

**The refusal names `penv init` as the one next command.** Adopting the file is the action that
resolves it, and `penv init` is the command that adopts. Deleting the file is named as the
alternative in the same sentence, but it is not a second command.

**A cutover requires a terminal or `--yes`.** With neither, init prints the selection it would make
and writes nothing, the way `penv migrate` previews. A script that migrated a project by accident
is the one thing undo cannot help someone who did not know it happened.

**One parameter at several scopes is not a name collision.** `DATABASE_URL` in `.env` and in
`.env.development.local` is the cascade doing its job, so the refs are deduplicated before the
invariant-12 check. Without that, the most ordinary project there is could not be adopted.

**Two files disagreeing about a variable's type collapse to `z.string()`.** A drafted `z.stringbool()`
that rejects a value the project already had would fail the first run, which is the one thing the
draft exists to avoid.

**The adoption primitives moved out of `import.ts` into `adopt.ts`, and the draft into
`draft-schema.ts`.** `init` imports `import.ts` nowhere and `import.ts` imports `init.ts`, so the
shared checks had to live below both. The error strings are lifted verbatim; `import`'s tests are
unchanged.

**`@penvhq/penv`'s `src/cli.ts` went with its bin.** ISSUE-05 flagged the stale `penv` bin; leaving
the entry behind would ship the whole CLI in the runtime tarball for nobody to reach. Its
`@napi-rs/keyring` dependency went too — the native binding was the CLI's — and the artifact smoke
test now asserts the published package declares no bin.

**The engine reads its own version from its manifest** (`new URL("../package.json", import.meta.url)`,
the pattern `core`'s dependency-budget test already uses), rather than restating it in source beside
a number releases bump.

**`testTimeout` is 20s.** ISSUE-06 recorded that jiti-heavy tests hit the 5s default under a full
parallel run and named the timeout as the knob. This issue's suite adds real child processes and
another dozen schema evaluations, and a different innocent test failed on each full run while
passing alone. The assertions here are timing-free; the default was measuring the machine.

### Flagged, not built

**Nothing writes `.penv/state/manifest.json`.** The launcher (ISSUE-05) detects a project by that
file and the manifest module (ISSUE-04) requires an exact engine version *and* its npm SSRI, which
`init` cannot compute offline — and init is network-forbidden apart from the one dependency install.
So an adopted project has no manifest, and the global launcher will treat it as "outside a project".
No issue in the set owns this; it needs one before v0.9 ships.
