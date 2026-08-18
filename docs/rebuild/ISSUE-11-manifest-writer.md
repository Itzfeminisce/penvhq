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

**The pin is a TypeScript module, `packages/launcher/src/pins.ts`, not `pins.json`.** The issue
allows "or equivalent". A JSON file needs `resolveJsonModule`, sits outside the package's `rootDir`,
and has to be either bundled in or added to `files` — and the launcher publishes two formats, so a
runtime read relative to `import.meta.url` has a CJS case to get wrong. One typed module is read by
`tsc`, by vitest and by tsup identically, and a release step that rewrites three literals in it is
the same step that would rewrite three keys in JSON.

**`migrate` joined `init` as a command the launcher runs outside a project.** A project on the old
layout is precisely a project with no manifest, so `penv migrate` reached `NoProjectError` and the
one command that fixes the layout could never be run. It is delegated to the bundled engine on the
same route `init` takes.

**An adoption is recognised by `.penv/state/`, not by an exit code.** `init` with neither a terminal
nor `--yes` previews and writes nothing, and `migrate` in an ordinary directory says there is nothing
to migrate — both exit 0. The state directory is what the two commands actually create, and it is the
directory the manifest goes in, so the launcher writes only where it found one. `migrate`'s root can
be above `cwd`, so the search walks up, exactly as the manifest search does.

**The pin carries the engine's version, and it is checked against the engine that ran.** An SSRI
describes one published tarball. Taking the integrity from the pin and the version from the resolved
engine would let a stale pin write a manifest naming bytes nobody can install; recording the pin's
own version would break "pins the engine that just scaffolded the project". They must agree, and
`PENV_ENGINE_PIN_MISMATCH` says so when they do not.

**A launcher built from source refuses, loudly, after a successful adoption.** The alternative was
skipping the write when the pin is the development value, which is the shipped bug this issue closes,
silently. `PENV_ENGINE_PIN_UNRELEASED` names npm as the one remedy. The check runs after the manifest
and state-directory guards, so a run that adopted nothing never mentions the pin.

**The launcher prints one line for the file it wrote.** `✓ .penv/state/manifest.json pins @penvhq/cli
<version>`, in `penv add`'s form. The manifest is committed and the engine's own summary cannot
mention it, so silence would leave the file for the reviewer to find in the diff.

### Flagged, not built

**`penv upgrade` has nothing to write with.** It rewrites the engine pin, which means resolving a
version and its integrity from the registry — a different seam from this one (a release-time
constant, no network). The launcher owns that command for the same reason it owns this write; no
issue in the set has it.
