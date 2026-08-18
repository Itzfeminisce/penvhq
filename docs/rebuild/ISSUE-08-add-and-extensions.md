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

- **`add` lives at `packages/launcher/src/add.ts`, not `commands/add.ts`.** The launcher package is
  flat; a one-file `commands/` directory beside eleven siblings would be a layout that exists only
  because this ticket was drafted against the CLI's shape.

- **Provenance is recorded where a reviewer reads it, not in the manifest.** The manifest is a
  closed shape and a new key is a format bump, which is out of scope here. `add` checks the
  packument for `dist.attestations`, prints the answer, and writes it into the header comment of
  the generated declaration — a committed file, so the record lands in the diff either way.
  **Pre-launch TODO: real sigstore verification.** Today penv records *that npm holds an
  attestation*, never that it verified one. Nothing in the code pretends otherwise — there is no
  stub — but shipping the official scope as "verified silently" is only honest once the bundle is
  actually checked against the Rekor entry and the expected source repository.

- **The private tier is decided by `--registry`, not by a separate flag.** A package from a
  registry that is not npmjs is private; one from npmjs outside `@penvhq/*` is third-party. The
  manifest already records exactly this distinction (`registry` present or absent), so a second
  flag would be a second way to say one thing.

- **`@penvhq/*` from a non-default registry is refused.** The official scope is the one that asks
  no trust question; taking those bytes from a registry the user named on the command line would
  make "official" a claim anyone can make about any bytes. An org proxying npm configures it in
  `.npmrc`, which penv's fetcher does not override.

- **The age gate applies to the third-party tier only.** A private package is usually published by
  the team adding it, minutes earlier; waiting seven days for your own release would make the gate
  a thing people learn to route around.

- **`penv.types` is the field a provider names its declaration with**, symmetrical with the settled
  `penv.onboard`. It points at a self-contained file inside the package, whose text `add` commits
  verbatim under a generated header. A specifier other than `@penvhq/core` is a refusal, not a
  warning: the file lands in a repository where the adapter is not installed, so anything else
  resolves to nothing. A package shipping none gets the open base shape keyed by its own name,
  which still makes the `type` in `penv.config.ts` a checked value.

- **The config edit is a per-environment offer.** `penv.config.ts` is scanned rather than parsed —
  the same technique `init` uses on `tsconfig.json` — and `add` offers, per environment already in
  the `providers` block, to repoint that entry's `type`. A config penv cannot read textually gets
  the one line to add, printed, and is never rewritten.

- **The accepted onboarding step runs through the engine.** `add` returns the argv; the launcher
  ensures the pinned engine and delegates, so the offer runs the same command the user would have
  typed and its exit code is `add`'s. Declining prints the command.

- **`LauncherIo` moved to `io.ts` and gained `ask`.** A trust reason is prompted, never invented,
  and `confirm` cannot carry a sentence. The interface no longer lives inside the protocol module
  because `add` needs it and the protocol imports `add`.

- **Follow-ups, out of scope here.** `penv remove` (nothing un-pins an extension; hand-editing the
  manifest is the only route today) and `penv upgrade <extension>` (re-running `add` re-resolves
  and re-asks, which is correct but re-prompts the trust ceremony for an already-trusted package).
