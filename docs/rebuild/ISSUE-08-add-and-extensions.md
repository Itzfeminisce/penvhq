# ISSUE-08 — `penv add` and the extension trust model

**Branch:** `issue/08-add-extensions` · **Wave 4** (after 05 + 06 merge).

## Goal

`penv add <package>` per PRD §3 with seals 6–7: official extensions add silently, third-party and
private ones through the recorded trust ceremony; the manifest is written, the launcher cache is
installed, a type-only declaration is generated, and `add` ends by offering the provider's
onboarding step.

## Read first

PRD §3, friction items 6–7; `packages/core/src/manifest.ts` (04); `packages/launcher` install
internals (05) — reuse its fetcher/verifier, do not duplicate them.

## Settled decisions (do not relitigate)

- `@penvhq/*` = official: resolve exact version (latest by default or `@<version>`), record
  SSRI, install to `$PENV_HOME`, generate the `.d.ts`, offer the `penv.config.ts` edit — zero
  trust questions. Provenance: check the npm registry metadata for an attestation's presence and
  record the result; full sigstore verification is a recorded pre-launch TODO in the decisions
  log, not a stub in code.
- Third-party scope: seven-day minimum package age by default; younger needs an explicit override
  that writes the full `trust` block (publisher, publishedAt, acknowledgedAt, human reason —
  prompted, not invented). Private registries: `trust.tier: "private"` with explicit
  acknowledgement; registry URL recorded, credentials never (`.npmrc` owns auth).
- Extensions are never added to `package.json`. The generated declaration goes to
  `.penv/state/extensions/<name>.d.ts`, committed, type-only, no adapter code.
- Extensions load only for explicit provider operations — nothing in `add` may introduce an
  import of adapter code into the app or the engine's startup path.
- Onboarding offer: an extension may declare an onboarding command in its package.json under
  `penv.onboard` (e.g. `"cloud login"`); when present, `add` ends with a one-line offer to run
  it now — offered, never assumed (seal 7). This field name is settled.
- All npm access behind the fetcher interface; tests use fakes, no network.

## Tasks

1. `commands/add.ts`: resolution, tier detection, age gate, trust prompts, manifest write
   (deterministic serialization from 04), cache install via launcher internals, `.d.ts`
   generation, config-edit offer, onboarding offer.
2. Tests: official add asks nothing (assert zero prompts); young third-party refused without
   override and recorded with it; private requires acknowledgement; manifest written exactly;
   declaration generated with no runtime code; onboarding offered only when declared; no
   `package.json` mutation.

## Out of scope

`penv remove`/`upgrade` (log as follow-ups if their absence hurts), real provenance verification,
the Penv Cloud extension itself (lives in the penv-cloud repo).

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; zero network in tests.

## Decisions log

(append here)
