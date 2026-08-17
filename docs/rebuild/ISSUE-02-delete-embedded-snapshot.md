# ISSUE-02 — Delete the embedded snapshot, completely

**Branch:** `issue/02-delete-embedded-snapshot` · **Wave 1** · Code + tests, no docs.

## Goal

Remove every trace of the committed-TypeScript snapshot model from the codebase — modules,
command, doctor check, load/resolve wiring, tests, changesets — leaving the tree green. No
replacement lands here (external artifacts are ISSUE-09). Deletion is the deliverable.

## Read first

- PRD §7 ("Deployment artifacts replace generated `penv.snapshot.ts`") and friction item 11.
- The three commits that built what you are deleting: `git show --stat fb0a49f fc3c556 2690243`.

## Settled decisions (do not relitigate)

- No compat shim, no deprecation warning, no legacy loader path. A project containing
  `penv.snapshot.ts` is simply a project with a stray file; nothing reads it.
- `load()`/`resolve()` lose their snapshot options and fallback entirely — the signature shrinks.
- The `snapshot` concept will return in ISSUE-09 as an external sealed artifact with a different
  format; share nothing with it. Delete `sealedSnapshotValues`, `snapshotDigest`, `PenvSnapshot`
  and friends rather than keeping them "for later".

## Tasks

1. Delete: `packages/cli/src/snapshot.ts` + tests, `packages/cli/src/commands/snapshot.ts`,
   `packages/core/src/snapshot.ts` + tests, `packages/runtime/src/snapshot.ts` + tests,
   `packages/penv/src/snapshot.integration.test.ts`.
2. Strip snapshot wiring from: `cli/src/index.ts` (command registration), `init`
   (snapshot generation/mention), `validate`, `doctor` (the `snapshot-stale` check and its tests),
   `runtime/src/load.ts` + `resolve.ts` + `config.ts` (options, fallback, provenance),
   `runtime/src/diagnostics.ts` if snapshot-specific, package `index.ts` exports, and
   `core/src/types.ts` (`PenvSnapshot`, `SyncValueSource` if snapshot-only — check callers).
3. Delete the snapshot changesets (`.changeset/snapshot-fallback-and-provenance.md`,
   `.changeset/wire-trailing-comma.md` if snapshot-related) and add one changeset: major-intent
   note that the embedded snapshot is removed (v0.9 rides the next breaking release).
4. Hunt stragglers: `grep -ri "snapshot" packages/` must end at zero hits outside
   test fixtures that merely use the word incidentally (there should be none).
5. Update any error/help copy that named the command.

## Out of scope

Docs (ISSUE-01 owns them), the new artifact (ISSUE-09), layout changes (ISSUE-03).

## Acceptance

- `grep -ri "snapshot" packages/` → no hits.
- `pnpm typecheck && pnpm test && pnpm lint` green; no test skipped to get there.
- Deleted-only where possible: the diff should be overwhelmingly red.

## Decisions log

(append here)
