# Fixes — cutover recovery, launcher repair paths, and the docs that lied

Branch `fix/cutover-launcher-docs`, from the adversarial review of the
developer-first rebuild. One section per finding: what was wrong, what changed,
and the two tests that hold it — one that fires, one that stays quiet.

## BLOCKER — the cutover recorded recovery after moving files

**Finding.** `bundleDotenvFiles` renamed every dotenv file and *then* wrote
`cutover.json`. An interruption between two renames — a crash, a Windows file
lock — left files in a gitignored bundle no command knew about: `readCutover`
returned `undefined`, so `penv init undo` said `INIT_UNDO_NOTHING`; a re-run of
`init` passed `assertBundleResolved` (which read the record, not the bundle) and
wrote a fresh record naming only the survivors; `penv cleanup` then `rmSync`'d
the orphan for good.

**Fix** — `packages/cli/src/cutover.ts`, `packages/cli/src/commands/init.ts`.

- `cutover.ts:143-172` — the record is written **first**, naming every file the
  move intends. A move that dies partway now leaves a bundle penv can describe.
- `cutover.ts:98-112` (`bundleUnresolved`) and `init.ts:1691-1706`
  (`assertBundleResolved`) — a non-empty bundle counts as unresolved whether or
  not a record names it, so a re-run cannot bury the first cutover's files. The
  remedy now offers `penv init undo` before `penv cleanup`.
- `cutover.ts:196-259` (`runUndo`) — resumable. The names it works from are the
  record's, plus anything in the bundle the record does not name. A name at the
  project root **and** in the bundle is the only collision (`INIT_UNDO_OCCUPIED`);
  a name at the root but no longer in the bundle was restored by an earlier run
  and is skipped. A name in neither is reported (`missing`), not refused — the old
  `INIT_UNDO_INCOMPLETE` sent the user to `penv cleanup`, which deleted every file
  still recoverable.
- `init.ts:2210-2245` — the undo report names what was already back and what is
  gone, and stops claiming "back exactly as they were" when it is not true.

**Tests** — `packages/cli/src/commands/init.cutover.test.ts`, describe
`an interrupted cutover`:

| Test | Holds |
|---|---|
| `records every file before it moves any` | fires: the second rename throws, and the record still names both files while only the first is bundled |
| `is undone without losing a file` | fires: the crash-after-first-rename state undoes to `restored: [.env]`, `alreadyBack: [.env.development]`, nothing lost |
| `restores what it can when a recorded file is gone` | fires: a genuinely missing file is reported, and the one still in the bundle is restored |
| `refuses a re-run while the bundle is unresolved` | fires: the record deleted by hand, `init` still refuses |
| `is undone from the bundle alone when the record is gone` | quiet: undo works off the bundle |
| `leaves nothing for cleanup to drop once it has been undone` | quiet: `cleaned: false` after a completed undo |
| `refuses rather than writing over a file that came back` (existing) | quiet: the genuine collision still refuses, unchanged |

## SHOULD-FIX — an interrupted migrate could never resume

**Finding.** `planMigrate` threw `HALF_MIGRATED` whenever `oldLayoutEntries` was
non-empty *and* the records tree held anything. An interruption between two
renames leaves exactly that, and every other command answers an old-layout tree
by naming `penv migrate` — so the project was wedged.

**Fix** — `packages/cli/src/commands/migrate.ts:90-98`, `121-145`. Only a name
held on **both** sides is a question penv cannot answer. A disjoint remainder is
the rest of the migration and resumes. The comparison folds case, because on
Windows and macOS `DB` and `db` are one file and the rename would overwrite
rather than collide.

**Nit, same file** — `migrate.ts:148-161`: the new `state/.gitignore` is written
**before** the old `.penv/.gitignore` is removed, so the plaintext records this
command just moved are never unignored, not even between two writes.

**Tests** — `packages/cli/src/commands/migrate.test.ts`:

| Test | Holds |
|---|---|
| `refuses a tree that is half in each layout` (existing, tightened) | fires: a genuine duplicate still refuses, and the message names it |
| `refuses a record the tree already holds under another casing` | fires: `API-KEY` vs `api-key` |
| `resumes a migration that was interrupted partway` | quiet: a disjoint remainder migrates, and a second run says `current` |
| `writes the new boundary before it drops the old one` | fires: with the new boundary's write forced to fail, the old one is still there |
| `drops the old boundary once the new one is written` | quiet: the end state is unchanged |

## SHOULD-FIX — the launcher parsed the manifest before the repair commands ran

**Finding.** `launcher.ts` parsed the manifest strictly at line 201, before
dispatching `install` or `add`. A manifest with an invalid extension entry threw
`MANIFEST_FIELD_TYPE`, whose remedy is `penv add <pkg>` — which hit the same
parse. `penv install`, the remedy every missing-package refusal names, was wedged
identically.

**Fix.**

- **New** `packages/launcher/src/repair.ts` — `readManifestForRepair(text)`
  returns `{ manifest, broken }`: every extension entry that validates on its own,
  and the names of the ones that do not. It is built entirely on the public
  `parseManifest`, so nothing in core was weakened. Everything outside the entries
  still refuses in full — the format gate, the engine pin, unknown root keys and
  the forbidden-content scan — because an entry repaired in a manifest penv could
  not run afterwards is not a repair.
- `launcher.ts:206-230` — `install` and `add` are dispatched **before** the strict
  parse.
- `launcher.ts:319-348` — `install` installs what it can read and reports what it
  cannot with the `penv add` that rewrites it, exiting 1.
- `add.ts:248-268` (`recordExtension`) — reads through the tolerant path,
  tolerating **only** the entry it is rewriting. What gets written still goes
  through `serializeManifest`, which validates.
- `packages/core/src/manifest.ts:370-390`, `:519-524` — the engine-branch remedy
  named `penv upgrade`, which is not built, so it would have refused identically.
  It now says what to write.

**Tests** — `packages/launcher/src/add.test.ts` (`a manifest with an entry penv
cannot read`), `launcher.test.ts` (`penv install`), `repair.test.ts`:

| Test | Holds |
|---|---|
| `is repaired by the \`penv add\` its own refusal names` | quiet: the finding's exact scenario — numeric `version`, `penv add` for that package succeeds, manifest valid after |
| `refuses when another entry is broken too` | fires: one `add` rewrites one entry; the other is left as the user's, not dropped |
| `still refuses a manifest whose engine pin is wrong` (add and install) | fires: the engine pin is not an entry |
| `installs around an entry it cannot read, and names the add that rewrites it` | quiet: engine installs, exit 1, remedy printed |
| `readManifestForRepair` suite (6 tests) | fires on format, engine pin, non-JSON, non-object `extensions`; quiet on a clean manifest |

## SHOULD-FIX — `penv add` ignored `--no-download` and CI

**Finding.** With `--no-download`, `add` still GET'd the packument and the
tarball. In CI an official add downloaded and rewrote the committed manifest with
nothing asked.

**Fix** — `packages/launcher/src/add.ts:334-345`, `errors.ts`, `launcher.ts:339`.
Both refusals land **before the first request**, so a run that cannot finish an
add has not read the registry, filled the store, or touched the manifest.

**Decision — non-interactive `penv add` is refused outright, with no escape
flag.** What `add` writes is two committed files (the manifest entry and the
type-only declaration), so it is a decision, and a pipeline that rewrites the
manifest it was handed is a pipeline choosing which bytes the project runs. CI's
command is `penv install`, which installs what a person already decided. Applied
to **every** tier, not only the ones that pay the trust ceremony: an official add
takes no trust decision and still rewrites a committed file. A `--yes`-style
escape was rejected — it would be a second path to the thing the trust model
exists to prevent, for a use case nobody named.

Consequence: `TrustPromptNeededError` said the same thing later and for fewer
packages, so it was **deleted** (contract: no stale paths) and replaced by
`AddNotInteractiveError`. `AddNoDownloadError` is new. Both are exported from
`packages/launcher/src/index.ts`.

**Tests** — `packages/launcher/src/add.test.ts`, describe `what add will not do
on its own`:

| Test | Holds |
|---|---|
| `refuses \`--no-download\` before it reaches the registry` | fires: `asked` is empty, manifest untouched |
| `refuses in CI even for the official scope` | fires: no trust decision involved, still refused |
| `refuses with no terminal to ask at, and reaches no registry` | fires: was `PENV_TRUST_PROMPT_NEEDED` after one fetch, now `PENV_ADD_NOT_INTERACTIVE` after none |
| `adds when there is a person, a network and no CI` | quiet: the ordinary add is unchanged |

## Nits

| Nit | Fix | Tests |
|---|---|---|
| undo/cleanup rooted at `process.cwd()` | `cutover.ts:54-66` — `cutoverRoot` walks up for `penv.config.ts`, the same anchor every other command uses. Fixed once, inside `runUndo`/`runCleanup`, so all three call sites (`cutover.ts:161`, `cleanup.ts:44`, `init.ts:2161`) are covered without a fourth place deciding. | `finds the project from a subdirectory` × 2 (undo, cleanup) |
| `engine.ts:59` — `resolve(dir, bin)` with no containment | `engine.ts:56-73` — the same guard `packageDir` uses. `bin` is the package's own text. | `refuses a bin that climbs out of the package directory` / `takes a bin that walks down and back into the package` |
| `home.ts:52` — containment proved inside `$PENV_HOME`, not inside the bucket | `home.ts:49-71` — measured against `resolve(home, kind)`, so `../extensions/x` cannot file an engine among the extensions | `refuses a name that lands in the other bucket` / `addresses a package by exact name and exact version` |
| `tar.ts:91` — NaN or negative size silently truncated | `tar.ts:91-99` — a size that is not a whole count of bytes inside the archive is an `ArchiveError`. A size beyond the archive is refused too, for the same reason. | `refuses a size field that is not a count of bytes` (3 cases) / `reads an entry whose size field is untouched` |
| `layout.ts:101-109` — case-sensitive comparison of penv's own names | `layout.ts:89-121` — `state`, the schema name and the code-module check fold case. On Windows and macOS a `State` directory **is** `.penv/state`, and reading it as a record made every command refuse an already-migrated project. | `recognises penv's own names whatever their casing` / `keeps a record that only looks like one of them` |

## Docs

| # | Was | Is | Proof |
|---|---|---|---|
| 1 | `Documentation.md:482` — `run --source snapshot` verifies the digest "against the schema you are running" | self-consistency of the artifact's own delivery mappings, plus format/engine/environment checks, each its own refusal. `:476` corrected the same way | `core/src/artifact.ts` — `deliveryDigest()` hashes the artifact's own values; `assertArtifactFor()` checks engine then environment |
| 2 | `Documentation.md:441` — PENV_DEBUG names the source and the winning value file; `ValidationError` names the source | what `describeDelivery` prints: environment, count, and the variable each parameter arrived under. `penv get --explain` answers the winner question | `runtime/src/load.ts:299-312`; `core/src/errors.ts` — `ValidationError` carries environment and issues only |
| 3 | lines 139, 184-202, 358, 367-389, 427 implied tooling calls `load()` and it resolves the tree | tooling starts under `penv run -- <tool>`, mirroring the model already at line 435. The tooling rule itself is unchanged. Same drift fixed in `README.md:107` | `runtime/src/load.ts` reads only `options.env ?? process.env` |
| 4 | `penv/src/index.ts:6-9` — a `./cli.js` entry | two entries, `.` and `./config`, no command line | `packages/penv/package.json` |
| 5 | `launcher/src/errors.ts:5-7` — no error mentions the launcher/engine split | the two engine-pin refusals do, and that is the one failure that cannot be described without it | `EnginePinUnreleasedError`, `EnginePinMismatchError` |
| 6 | six comments naming pre-`state/` paths | corrected | `adopt.ts:49`, `import.test.ts:6,149,181`, `fill.test.ts:279`, `README.md` |
| 7 | `Roadmap.md` v0.9 body claimed `penv upgrade [version]` exists | moved to an explicitly-after-v0.9 row and a resequencing note; the v0.9 body now describes what ships | no `upgrade` in `cli/src/index.ts` subCommands or `launcher.ts` |
| 8 | PRD §4 `:202`, `:214`, §9 `:333` said "journal"; §4 `:204` said sources are always named | `.penv/state/records/`; `--source` defaults to `project` and `snapshot` is always named | PRD seals 2 and 5 |

`Documentation.md:45` and `:792` still describe `penv upgrade`. Left deliberately:
that file documents penv as designed, and availability lives in the roadmap (its
own stated contract at `Documentation.md:5`).

## Decisions log

1. **Non-interactive `penv add` is refused for every tier, with no escape flag.**
   Rationale above. `TrustPromptNeededError` deleted as unreachable.
2. **`penv add` tolerates one broken entry, not several.** A second broken entry
   refuses rather than being silently dropped, and the remedy is
   `git checkout .penv/state/manifest.json` — the file is committed. Carrying
   unparsed entries through the write path was rejected: it would need a
   validation-free write door in core, for a case a `git checkout` already
   answers.
3. **The engine-branch manifest remedy no longer names `penv upgrade`.** That
   command is not built (ISSUE-11 logs it as a follow-up), so the remedy would
   have refused identically on the same file. It now says what to write.
4. **`oldLayoutEntries` and the migrate collision check fold case
   unconditionally,** including on case-sensitive filesystems. Record names are
   lower-case by the grammar, so nothing legitimate is lost, and the alternative
   is a data-losing overwrite on the two platforms most developers use.
5. **`runCleanup` stays destructive.** It is the accept half of the migration.
   With the fixes above an orphaned bundle is recoverable by `penv init undo`, so
   cleanup deleting it is an explicit choice rather than a trap. `init` never
   calls it.

## Verification

`pnpm typecheck` · `FORCE_COLOR=0 pnpm test` (73 files, 1761 tests) · `pnpm lint`
— all green. Lint's 33 diagnostics are pre-existing `useLiteralKeys` **infos**,
untouched.
