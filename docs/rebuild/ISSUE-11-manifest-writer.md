# ISSUE-11 — The manifest gets written

**Branch:** `issue/11-manifest-writer` · **Wave 5** (parallel with 09; do not touch the artifact
or run-source code ISSUE-09 owns).

## Why this issue exists

ISSUE-07's flag: nothing in the issue set writes `.penv/state/manifest.json`. The launcher detects
a project by that file, and format 1 requires the engine's exact version *plus* its npm SSRI —
which `init` cannot compute offline. Today an adopted or migrated project has no manifest, so the
global launcher treats it as "outside a project" forever. Close the loop.

## Read first

ISSUE-05's launcher (home/store/engine/launcher modules and the bundled-engine path), ISSUE-04's
manifest module, ISSUE-07's init report section in its issue file, PRD §2.

## Settled decisions (do not relitigate)

- The **launcher owns manifest writing** — it owns installs, integrity, and the bundled engine's
  identity. The engine never writes the manifest.
- After a delegated `penv init` completes successfully in a directory with no manifest, the
  launcher writes one pinning **the engine that just scaffolded the project** (the bundled engine,
  or the pinned one if a manifest existed mid-flow — then it does nothing). Same behavior after a
  successful `penv migrate` on a manifest-less project.
- The bundled engine's SSRI comes from a **generated pin embedded in the launcher package at
  release time** (the release pipeline publishes `@penvhq/cli`, reads the tarball integrity from
  the registry, embeds it, then publishes `penv`). In the repo, that pin is a checked-in
  `pins.json` (or equivalent) with a clearly-fake dev value and a test asserting the release
  script refuses to publish with the dev value. Design the seam; a full release pipeline is out
  of scope.
- No network during init/migrate. The manifest written must round-trip through
  `parseManifest`/`serializeManifest` unchanged.
- `extensions` starts `{}`. `penv add` (ISSUE-08) already maintains it thereafter.

## Tasks

1. The post-delegation manifest write in the launcher (init and migrate paths), with the pin seam.
2. Tests: adopted project ends with a valid committed-shape manifest naming the bundled engine;
   migrate on a manifest-less project same; an existing manifest is never overwritten; a failed
   init writes nothing; the manifest round-trips; the dev-pin refusal test for the release seam.
3. A changeset.

## Out of scope

`penv upgrade` (log as follow-up), the real release pipeline, ISSUE-09's artifact work.

## Acceptance

`pnpm typecheck && FORCE_COLOR=0 pnpm test && pnpm lint` green from the worktree root.

## Decisions log

(append here)
