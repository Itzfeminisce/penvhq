# ISSUE-09 — The sealed deployment artifact

**Branch:** `issue/09-sealed-artifact` · **Wave 5** (after 07 + 08 merge).

## Goal

The external, environment-specific sealed delivery artifact per PRD §7: built by an explicit CI
command, stored outside git and outside the app source, consumed by `penv run --source snapshot`
via `PENV_SNAPSHOT` — verified, decrypted in memory, injected. This completes the `--source` flag
ISSUE-06 left refusing.

## Read first

PRD §7, friction item 11; ISSUE-02's deletion (share nothing with what it removed); ISSUE-06's
run/source seam; the sealing/AAD code in `packages/core`.

## Settled decisions (do not relitigate)

- Command: `penv artifact build --env <e> --out <path>` (CI names `--env` explicitly; the command
  refuses to default it — an artifact for "whatever the default was" is a footgun).
- Format 1, canonical JSON, deterministic serialization: `format`, `environment`,
  `engineVersion`, `schemaDigest` (non-secret), `keySource` identifier, `values` — only the final
  resolved non-local winner for each schema-declared delivery mapping, sealed ciphertext where
  encryption applies. Never: `.local` values, fallback records, provider config, provider
  credentials, plaintext secrets, key material.
- `penv run --source snapshot` reads only `PENV_SNAPSHOT`; verifies environment, engine/format
  compatibility, and schema digest before decrypting in memory; refusals name the mismatch and
  one remedy. No source files, no provider adapters, no network.
- An artifact in the repo tree or in git is a `doctor`-level finding, not a supported layout.
- Serverless platforms are explicitly NOT this path (native platform delivery, owned by
  integrations/Cloud); the docs sentence for that lives in ISSUE-01's output — code here must not
  generate bundler files of any kind.

## Tasks

1. `commands/artifact.ts` (build), format module + verification in core/runtime, run-source
   wiring replacing ISSUE-06's refusal.
2. Tests: build produces the canonical fixture byte-for-byte from a seeded project; contains no
   plaintext / `.local` / provider fields (negative scans); env mismatch, engine mismatch, digest
   mismatch each refuse with copy; run-from-artifact injects the owned child env with no provider
   constructed; missing `PENV_SNAPSHOT` refusal names the build command.

## Out of scope

CI recipe docs (post-rebuild docs work), delivery to platforms, any Cloud behavior.

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; `grep -ri "penv.snapshot" packages/` still zero.

## Decisions log

(append here)
