# ISSUE-10 — Adversarial review of the whole rebuild

**Wave 6** (after every implementation issue is merged to `rebuild/developer-first`). Run by
review agents; findings go back to fix agents; nothing merges to `main` until this passes.

## Charge

Review the full diff `main...rebuild/developer-first` against the PRD and its seals. You are
trying to refute the claim "this rebuild is correct and complete" — not to summarize it.

## Angles (one reviewer per group)

**A. Contract and seals**
- Every sealed decision (friction items 1–11 verdicts) is implemented as sealed, not
  approximately. Check the copy strings, the defaults, the refusals, the one-visible-version
  rule, `.penv/state/` naming everywhere.
- PRD out-of-scope list: nothing crept in (no fetch-at-boot, no script rewriting, no inferred
  environments, no committed sealed records).
- Deletion completeness: no snapshot-era identifier, export, option, or doc-comment survives.

**B. Correctness and safety**
- Child-env ownership edge cases: optional-absent deletion, marker stripping order, signal
  forwarding, Windows path/spawn behavior.
- Migration: interrupted mid-move, rerun, weird old layouts, case-sensitivity.
- Manifest/launcher: integrity mismatch handling, downgrade attacks (manifest edited to an older
  engine — is that just... allowed? it should be, it's a pin — but verify the integrity still
  gates), path traversal in `$PENV_HOME` entries, the no-network-in-CI guarantee.
- Init preflight atomicity: any path where files moved but the cutover then failed.
- Artifact: plaintext leakage under every scope combination, AAD binding preserved, digest
  actually binding what it claims.

## Rules

Verify by reading code and running targeted tests, not by trusting reports. Report findings as:
file:line, claim, concrete failing scenario, severity. `pnpm typecheck && pnpm test && pnpm lint`
must be green on the integration branch before you start; if it is not, that is finding #1.
