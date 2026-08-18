# ISSUE-05 — The launcher

**Branch:** `issue/05-launcher` · **Wave 3** (after 03 + 04 merge).

## Goal

A new `packages/launcher` — the stable global `penv` executable. It reads only the manifest's
stable format, finds the exact verified engine and extensions in `$PENV_HOME`, and delegates every
substantive command to that engine. One user-visible version.

## Read first

PRD §2, friction items 4 and 6; `packages/core/src/manifest.ts` (ISSUE-04);
`packages/cli/package.json` (the engine you delegate to).

## Settled decisions (do not relitigate)

- Package `packages/launcher`, published as unscoped **`penv`** with the `penv` bin. The engine is
  `@penvhq/cli`; give it a programmatic/bin entry the launcher can spawn if one is missing.
- `$PENV_HOME` defaults to `~/.penv`; layout `$PENV_HOME/engines/<name>/<version>/` and
  `$PENV_HOME/extensions/<name>/<version>/`; `$PENV_HOME/meta.json` records how the launcher was
  installed (written by installers; when absent, the remedial command falls back to the npm form).
- Project detection: walk up for `.penv/state/manifest.json`. Outside a project the launcher runs
  only `init`, `--version`, `--help` via its bundled current engine.
- Verification: the installed engine/extension dir carries its SSRI; mismatch or absence in
  CI/production (`CI` env var set, or `--no-download`) is a refusal that prints the exact
  preinstall command. Interactive absence may download once from the recorded registry (npm
  tarball), verify SSRI, then install — one consent line first.
- One visible version: `penv --version` prints `penv <engine version>` inside a project (the
  pinned engine), `penv <bundled version>` outside. The launcher/engine split appears in exactly
  one place: the unsupported-manifest-format error, which prints the remedial command from
  `meta.json` and the command the user was running.
- Delegation preserves argv byte-for-byte, stdio, exit code, and signals. The launcher parses
  nothing after the command name it needs for its own three commands.

## Tasks

1. `packages/launcher` with bin, resolution, verification, spawn-delegation; wire into the
   workspace (tsup config, tsconfig paths, vitest alias — follow an existing package's pattern).
2. Download path isolated behind a small fetcher interface; tests use a fake fetcher — **no
   network in tests**.
3. Tests: manifest-format rejection copy; exact engine selection; integrity mismatch refusal;
   offline/CI missing-engine refusal naming the preinstall command; delegation forwarding (argv,
   exit code); `--version` in and out of a project.
4. A changeset describing the new package.

## Out of scope

Extension installation UX (`penv add`, ISSUE-08); actual npm publishing; Windows installer
variants of `meta.json` beyond the npm fallback.

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; zero network in the test run; the
unsupported-format error copy exists in one place and is asserted verbatim.

## Decisions log

**`penv install` exists, because the refusal names it.** "Refuse and print the exact preinstall
command" needs that command to be real, and nothing in the issue set installs the manifest's pins.
So the launcher owns a third in-project command beside `--version`: `penv install` materializes
every pin, and it is the one path that downloads regardless of `CI` — that is its whole job. A
corrupt install is refused there too rather than silently overwritten.

**`--no-download` leads, and does not cross.** Argv is preserved byte for byte *after* the command
name; the launcher owns only the tokens before it. So `--no-download` is recognized as a leading
token (`penv --no-download run -- …`) and removed from what the engine receives. A `--no-download`
appearing later belongs to the engine and is forwarded untouched.

**The engine is a dependency, not a bundle.** `@penvhq/cli` is a real dependency of `penv` and
gained a `penv-engine` bin plus a `./package.json` export. The bundled engine and an engine in
`$PENV_HOME` are then the same thing — a package directory with a `bin` — so there is one resolver
and one spawn path, and the bundled version is read rather than injected at build time. The global
name `penv` stays the launcher's.

**Verification is a recorded SSRI, not a re-hash.** An installed directory carries
`.penv-integrity`, written from the tarball it was extracted from; every later run compares the
manifest's pin against that. A directory can never hash to an npm tarball integrity, and re-hashing
one on every command would be a cost paid on every command. The gap this accepts is a directory
edited after install, which is a machine-local tamper the marker cannot see — noted for ISSUE-10.

**A mismatch never downloads.** Absence may be repaired interactively; a mismatch is refused in
every mode, including at a terminal. Downloading over bytes that are not the pinned bytes would
erase the evidence of whatever wrote them.

**`meta.json` is read for `updateCommand`.** `installMethod` is recorded for humans and installers;
the launcher reads `updateCommand` and falls back to `npm install -g penv` when it is absent,
unreadable, or not a string. A metadata file is never allowed to turn one refusal into two.

**The tarball URL is built, not looked up.** A pin names an exact version, so
`<registry>/<name>/-/<basename>-<version>.tgz` is enough — one GET, no registry metadata schema,
and one fewer network call to fake in tests.

**The tar reader is ours.** No tar dependency is available in this workspace, so `tar.ts` reads
gzipped ustar directly: regular files under `package/` only, pax `path` records honored, and
symlinks, hardlinks, absolute paths, drive letters, backslashes and `..` refused before anything
is written.

**`--help` inside a project is the engine's.** Only `--version` and `install` are answered by the
launcher itself; everything else delegates, so `penv --help` in a project with no engine installed
gets the install refusal. One rule, no second help text to drift.

**The child gets `PENV_HOME` resolved.** Argv, cwd and the streams are the user's; the one
environment variable the launcher sets is the store it just verified against, so the engine cannot
load an extension from somewhere else.

**Dependency footprint.** `@penvhq/core` brings `zod` (accepted, per the issue brief); nothing else
was added. Because the engine is a dependency, a global `penv` install also pulls `@penvhq/cli`'s
closure (`citty`, `jiti`, `@napi-rs/keyring`). That is the cost of `penv init` working outside a
project at all.

**`bundledEngine()` is injected in tests.** It resolves `@penvhq/cli/package.json` through Node,
which cannot resolve from `packages/launcher` in a worktree where installing is forbidden. The
protocol tests pass an engine directory instead; the resolver itself is a five-line lookup.

### For later issues

- **ISSUE-08 reuse.** The store, fetcher, verifier and tar reader are exported from `penv`.
  `@penvhq/cli` importing them would close a workspace cycle (the launcher already depends on the
  CLI), so `penv add` is best written as a launcher command beside `penv install` — it writes the
  manifest and installs into the cache, and needs no engine to do either.
- **A downloaded tarball has no `node_modules`.** Installing an engine from npm gives its own files
  and nothing else, so the published `@penvhq/cli` must bundle its runtime dependencies the way
  `@penvhq/penv` already does, or the install path needs a package-manager step. Publishing is out
  of scope here; flagged for whoever seals the artifacts.
- **`@penvhq/penv` still declares a `penv` bin** from the pre-rebuild layout, where it was the CLI
  distribution. Under PRD §3 it is the typed runtime surface only, and the global name is the
  launcher's. Left for ISSUE-07's cutover rather than removed mid-wave.
