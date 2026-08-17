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

(append here)
