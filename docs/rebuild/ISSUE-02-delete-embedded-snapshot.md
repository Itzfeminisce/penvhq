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

- **`load()`'s `source` option went with the snapshot.** `LoadSource` was
  `"auto" | "disk" | "snapshot"`; with one source left, `auto` and `disk` are the same
  behavior and pinning names nothing. `LoadOptions.source`, `LoadSource`, `ResolutionSource` and
  `ResolvedConfig.source` are deleted, and `@penvhq/penv` stops exporting `LoadSource`.
- **`ValidationError`'s `source` provenance is deleted.** It was added by the snapshot commit to
  answer "which of the two sources did penv read", and with one source the answer is never in
  doubt. The message returns to its pre-snapshot form; `ResolvedConfig.origin` survives as the
  config file's path, because the `PENV_DEBUG` account (not a snapshot feature) names it.
- **`doctor bundle-invisible-plaintext` is deleted along with `snapshot-stale`.** Both were gated
  on a committed snapshot existing, so neither can fire now; "invisible to a bundle" is a claim
  only the embedded snapshot made.
- **`searchConfigFile` / `ConfigSearch.beyondBoundary` are deleted from core.** The extra walk past
  the project boundary existed only to warn before falling back to the snapshot. `findConfigFile`
  now performs the bounded search directly; the boundary rule and its tests are untouched.
- **The runtime's `warn` channel is deleted.** `diagnostics.ts` was created by the snapshot commit;
  every `warn` call was a snapshot fallback. `PENV_DEBUG` (`debugEnabled`/`debug`) stays.
- **The prototype-inheritance regression test was re-expressed against the filesystem.** It was
  written against a snapshot holding `constructor.production.enc`; the hazard is in the value
  cascade, so it now loads a tree holding `constructor.production` and asserts the same absence.
- **Published `packages/*/CHANGELOG.md` entries for 0.8.0 are left alone.** They record what npm
  consumers actually received; rewriting them would make a released version's changelog lie. So
  `grep -ri snapshot packages/` is zero over source, and non-zero over that release history — the
  same exemption git history carries. The new changeset names the removal for the next release.
