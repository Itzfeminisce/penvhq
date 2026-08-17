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

1. **v0.7 shipped on npm as 0.5.0, not 0.7.0.** The issue's parenthetical said 0.7.0;
   `packages/cli/CHANGELOG.md` 0.5.0 contains all three v0.7 parts (sinks unified into providers,
   fully-qualified provider types, `names` → `override`), and npm 0.7.0 is a v0.8-milestone patch.
   The roadmap's existing "ships on npm as 0.5.0" line was correct and was kept; only the
   "in progress" markers were closed.
2. **Ambient delivery had already shipped.** The roadmap listed it as "RFC only / v0.8 (planned)",
   but `load(schema, { inject: true })`, the framework seams, the selective allowlist, and
   `override` are in npm 0.6.0–0.7.0, and the two-module scaffold in 0.8.0. The one part that
   never shipped is `doctor`'s `ambient-shadow` check (dropped in b630532). So "ambient delivery
   moves after v0.9" is recorded as: the shipped surface stays at v0.8, and `ambient-shadow` is
   the item scheduled after v0.9. Writing "planned" for shipped code would have made the document
   that owns availability the one document lying about it.
3. **No npm version invented for v0.9.** The roadmap records it as one breaking release carrying
   the same version across the launcher, the engine, and `@penvhq/penv`, without naming a number.
4. **The RFC gained a snapshot section rather than amending one.** The embedded snapshot's
   rationale was never recorded in the RFC — it lived in `Documentation.md` and `v0.8-plan.md` —
   so the new "The deployment artifact is external…" section records the superseded decision and
   retires it in the same place, following the provider-unification precedent.
5. **PRD §9's "migration window" sentence is marked superseded inline**, not only in the roadmap
   entry, because acceptance requires that no document contradict another on layout and the
   sentence promised dual-layout support that ISSUE-03 does not build.
6. **`_journal` survives once in the RFC**, in the "On the name" paragraph that records the
   rename. The acceptance grep allows it only in the rebuild folder and the PRD's friction item;
   naming what a decision supersedes is what the RFC does everywhere else (see the sink
   supersession), and a rename with no record of the old name teaches nothing.
7. **`load(schema, { inject: true })` is kept in the docs, narrowed.** The PRD does not mention
   it, and deleting a shipped surface is not this issue's call. The docs now say the ambient
   variables come from `penv run`'s child environment, with in-process injection covering the
   case where a platform starts the process (serverless).
8. **No artifact filename convention invented.** Examples use `--out build/production.artifact`
   and `PENV_SNAPSHOT=/run/secrets/production.artifact`; ISSUE-09 owns the real format and may
   name an extension.
9. **The client-inlining seam is `penv run -- next build`**, replacing the `next.config.ts` import
   of `@penvhq/penv/config` — under `penv run` the build already runs inside penv's environment,
   and the bare import stays documented as the schemaless compat path.
10. **`penv import` stays in the CLI reference** as the way to bring one more dotenv file into an
    adopted project; `penv init` is the adoption front door in every example.
