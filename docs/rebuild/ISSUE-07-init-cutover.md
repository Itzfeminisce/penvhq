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

(append here)
