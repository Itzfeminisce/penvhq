# ISSUE-01 — Docs truth-up: the documents stop arguing with each other

**Branch:** `issue/01-docs-truth-up` · **Wave 1** · Docs only, no code.

## Goal

Bring Roadmap, RFC, AGENTS.md, Documentation.md, README.md and the PRD into one consistent story:
the developer-first rebuild is the next milestone, the embedded snapshot is retired, and the seal
verdicts are recorded.

## Read first

- `docs/PRD-Developer-First-Execution-and-Delivery.md` — the whole thing, including the friction
  review at the end.
- `docs/Roadmap.md`, `docs/RFC.md` §on snapshots, `AGENTS.md`, `docs/Documentation.md` (snapshot
  and layout sections), `docs/provider-unification-plan.md` (the precedent for amending the RFC in
  the same change).

## Settled decisions (do not relitigate)

- Seal verdicts: **1 amended** (wrapper-outside stays blessed; already in the PRD text),
  **2–4 and 6–11 approved as written**, **5 approved as `.penv/state/`** (the `_journal` name is
  dead).
- The embedded snapshot (`penv.snapshot.ts`, `penv snapshot`, `doctor snapshot-stale`) shipped in
  0.8 and is retired by this rebuild, replaced by external sealed artifacts (PRD §7). Its deletion
  is ISSUE-02; your job is only to make the documents say so.
- The rebuild is the **v0.9 milestone**. v0.7 is closed (shipped as npm 0.7.0). Engine dual-layout
  support is NOT provided: `penv migrate` converts old projects; the engine reads only the new
  layout (supersedes the PRD's "migration window" sentence — record that in the roadmap entry).

## Tasks

1. **Roadmap** — close v0.7; correct the availability table (two-module scaffold shipped; embedded
   snapshot: shipped 0.8, retired v0.9); add the v0.9 milestone "Developer-first execution and
   delivery" naming what it retires (adoption friction; the source-coupled snapshot) and its gate
   (the PRD's first-user journey runs end to end). Ambient delivery moves after v0.9, explicitly.
2. **RFC** — new sections, in RFC voice (why + alternatives + tradeoffs): the launcher/manifest
   split and one-visible-version; `.penv/state/` and the committed-layout reasoning; the
   all-or-nothing cutover; external sealed artifacts superseding the embedded snapshot (mark the
   embedded-snapshot rationale superseded, the way provider-unification amended prior decisions);
   the run-ergonomics seals (default source, declared `defaultEnvironment`, wrapper-outside).
3. **AGENTS.md** — add a short "Developer-first rebuild" note: the PRD + `docs/rebuild/` issues
   are authoritative during the rebuild and the invariant stop-gate is waived for that scope;
   update any invariant text or examples that reference the old layout or `penv.snapshot.ts`.
4. **Documentation.md** — remove the embedded-snapshot sections; describe (finished-design voice,
   no "not yet"): the launcher and one runtime dependency, `penv init` cutover with undo,
   `penv run` with its defaults, `penv pull`/`push` as the sync boundary, sealed deployment
   artifacts and platform-native serverless delivery. Availability language stays out — that is
   the roadmap's job.
5. **PRD** — annotate each friction-review item with its verdict (approved / amended / approved as
   `.penv/state/`), one line each.
6. **README.md** — sync the pitch and examples with the above.

## Out of scope

Any code or test change; version numbers in package.json; the historical plan docs
(`v0.5-plan.md`, `v0.8-plan.md`, `provider-unification-plan.md`) — leave history alone.

## Acceptance

- No document contradicts another on snapshots, layout, milestones, or command examples.
- `grep -ri "penv.snapshot" docs/ README.md` hits only historical/plan files and
  retirement/supersession language.
- `grep -r "_journal" docs/ README.md AGENTS.md` hits nothing outside this rebuild folder and the
  PRD's friction item that renamed it.
- Command examples use the sealed short forms (`penv run -- pnpm dev`) with the long form shown
  once as the CI form.
- `pnpm typecheck && pnpm test && pnpm lint` still green (should be untouched).

## Decisions log

(append here)
