# ISSUE-03 — `.penv/state/` layout, and `penv migrate`

**Branch:** `issue/03-state-layout` · **Wave 2** (after 02 merges).

## Goal

Move Penv-managed project state under `.penv/state/` per PRD §1 (with seal 5's rename from
`_journal`), and ship `penv migrate` to convert existing projects. The engine reads only the new
layout.

## Read first

- PRD §1 (Ownership and project layout), §9 (Existing project migration), friction item 5.
- `packages/cli/src/project.ts` (current `PENV_DIR`/tree root), the filesystem provider's root
  handling, `packages/core/src/grammar.ts`.

## Settled decisions (do not relitigate)

- The directory is `.penv/state/` — not `_journal`, not `state` at the project root.
- Layout: `state/manifest.json` (committed; may be absent until the launcher lands — reading code
  must tolerate absence for now and NOT invent a stub), `state/.gitignore` (committed safety
  boundary), `state/records/` (the parameter tree), `state/extensions/*.d.ts` (committed),
  `state/cutover.json` and `state/rollback/dotenv/` (created by init in ISSUE-07 — reserve the
  names, do not create them here).
- **No dual-layout support in the engine.** An old-layout project gets one refusal naming
  `penv migrate` (this supersedes the PRD's "migration window" sentence, per the rebuild's
  no-fallbacks directive). `penv migrate` previews, then on approval moves the tree, writes the
  `state/.gitignore`, and touches nothing user-owned.
- Grammar, cascade, metadata, AAD and provider serialization are unchanged — this is a root move,
  byte-identical records.

## Tasks

1. Introduce the `state/` root in `project.ts` (or its successor): records under
   `state/records/`, with one function owning the path so later issues don't scatter it.
2. `state/.gitignore`: ignores value files and `rollback/`, keeps `manifest.json`,
   `extensions/*.d.ts`, meta and structure committed — port the current committed/ignored split
   exactly (AGENTS.md invariant 20 stands).
3. Old-layout detection → one refusal, docs-voice, naming the exact command: `penv migrate`.
4. `penv migrate`: preview (what moves where, what is created), approval prompt, move
   `.penv/<old records location>` → `.penv/state/records/`, write the `.gitignore`, leave
   `penv.schema.ts` / `penv.config.ts` / `.penv/env.ts` byte-identical; idempotent (running on a
   migrated project says so and exits 0); refuses cleanly on a half-migrated tree.
5. Update every path reference in cli/core/runtime and all test fixtures to the new layout.

## Out of scope

The manifest's content (ISSUE-04), init/cutover files (ISSUE-07), launcher reading of
`state/manifest.json` (ISSUE-05).

## Acceptance

- Migration fixture tests: old layout in → new layout out, user-owned files byte-identical,
  records byte-identical; second run is a no-op; refusal fires on an old-layout `penv <cmd>`.
- `grep -r "_journal" packages/` → no hits.
- `pnpm typecheck && pnpm test && pnpm lint` green.

## Decisions log

(append here)
