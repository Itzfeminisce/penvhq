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

- **The path owner is `recordsDir(projectRoot)` in `packages/core/src/layout.ts`.** Everything else
  in that module hangs off it: `recordPath` for the paths messages print, `oldLayoutEntries` and
  `assertMigrated` for the refusal, `renderStateGitignore` for the boundary. The CLI, the runtime
  and `migrate` all ask it, and nothing else spells the tree.
- **`ProviderFactoryContext.root` is now the project root, not `.penv/`.** Keeping it at `.penv/`
  would have needed a second path function (penv-dir → records) beside the one owner, and the
  registry already walked up from it (`dirname`) to resolve plugin packages. No shipped provider
  read `root`; the filesystem factory now calls `recordsDir(root)` and the mock keeps its store at
  `.penv/.penv-mock.json`. Recorded in the changeset as a breaking change for third-party providers.
- **Old layout means: an entry directly under `.penv/` that is not a dotfile, not `state/`, not the
  module `schemaFile` names, and not a code module.** That is exactly what the tree walker used to
  read, so an injection seam (`.penv/preload.ts`) and `.penv/env.ts` stay put. One function answers
  it, so the refusal and `migrate`'s move list cannot disagree.
- **The refusal fires in the runtime too**, not only in `openProject`. An unmigrated project that
  booted would report a missing required parameter — the layout change disguised as a config error.
- **`migrate` deletes `.penv/.gitignore`.** penv wrote it, it described a layout that no longer
  exists, and left in place its `*` would keep ignoring `.penv/env.ts`, which the new layout
  commits. It is previewed as a removal like everything else.
- **`state/.gitignore` adds `!*.d.ts` and re-excludes `rollback/`**, on top of the ported
  committed/ignored split (`*`, `!*/`, `!.gitignore`, `!*.json`). `cutover.json` therefore lands on
  the committed side of `!*.json`; ISSUE-07 owns that file and may narrow the rule when it lands.
- **`schemaInsideTree` now measures against `.penv/state/records/`.** The rule is unchanged — a
  schema inside the tree is skipped by the path the config names — but the tree moved, so the
  scaffolded `.penv/env.ts` is no longer inside it. An `env.ts` that does sit in the tree is a
  stray code module and is refused, which is what the grammar already said about code in the tree.
- **`isCodeModule` is exported from `grammar.ts`** so `migrate` and the walker ask one question
  about what is code rather than two.
- **`Project.penvDir` is replaced by `Project.recordsDir`.** Two callers wanted the tree (`watch`,
  the provider) and two wanted the project (`push`, `sourceProviderFor`); one field meaning two
  things is how a path gets scattered.
- **A half-migrated tree is: old-layout entries present *and* a non-empty `state/records/`.** It is
  refused with `HALF_MIGRATED`, naming the by-hand move and `penv validate` as the way back.
- **Approval:** `migrate` prints the plan, then asks on a TTY; `--yes` skips the question. Without
  a TTY and without `--yes` it prints the preview and writes nothing, so a script never migrates by
  accident. `runMigrate` carries the same three outcomes as statuses (`previewed`, `migrated`,
  `current`) rather than a boolean, so the tests drive the command's own vocabulary.
- **`renderGitignore` moved out of `init.ts` into core** as `renderStateGitignore`: `init` and
  `migrate` write the same bytes, and two renderers is how a boundary drifts.
- **`penv fill`'s blocked remedy now names `penv.schema.ts`** instead of a hard-coded
  `.penv/env.ts` — the shape module is where parameters are declared, and the old string was a
  path this issue moved past.
