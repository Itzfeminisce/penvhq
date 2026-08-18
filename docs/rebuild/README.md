# Developer-first rebuild — working contract for implementing agents

This folder holds the issue set for the rebuild scoped by
[PRD-Developer-First-Execution-and-Delivery.md](../PRD-Developer-First-Execution-and-Delivery.md),
including its "Adoption friction review" seals. One agent takes one issue, in its own git worktree,
on its own branch. The orchestrator reviews and merges to `rebuild/developer-first`; nothing here
touches `main` until every issue is approved.

## Authority

1. The PRD (with its sealed friction review) wins over shipped code, over the docs, and over the
   roadmap. Where an issue file below records a decision, that decision is settled — do not
   relitigate it.
2. AGENTS.md still governs coding conventions, testing bars, and voice — but its "stop and surface
   an invariant conflict" rule is **waived for this rebuild**: where the PRD contradicts an
   invariant or shipped behavior, the PRD wins, silently.
3. Prefer redesign over fallbacks. Delete stale code and files completely — no compat shims, no
   deprecated paths, no "legacy mode" unless an issue explicitly asks for one.

## Your environment

- You work in a dedicated git worktree on branch `issue/<nn>-<slug>`, forked from
  `rebuild/developer-first`.
- Every `node_modules` directory in your worktree is a **junction into the master checkout**.
  Treat it as read-only. Never run `pnpm install`, `pnpm add`, or anything that writes to
  `node_modules`. If a dependency seems missing, record it in your report — do not install it.
- Never start dev servers, watchers, or `pnpm dev`. Never run `pnpm build` unless your issue says
  builds are in scope.

## Verification and done

- Green means: `pnpm typecheck && pnpm test && pnpm lint` from the worktree root.
- New behavior gets tests, including negative cases (a check that fires and a check that stays
  quiet). Type errors are frequently real design violations — fix the design, not the type.
- Comments: minimal and precise, one short line only where the reason is not obvious; never stack
  a new comment on an old one — replace stale ones.
- Commit in small conventional commits on your branch, ending each message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Any decision your issue did not settle: make the smallest reasonable call and append it to the
  **Decisions log** at the bottom of your issue file, so it merges back with your work.
- Your final report: what you changed and why, the verification output, the commit list, and any
  decisions logged or blockers hit.

## Wave order

| Wave | Issues | May start when |
|---|---|---|
| 1 | 01 docs truth-up · 02 delete embedded snapshot | immediately |
| 2 | 03 state layout + migrate · 04 manifest module | 02 merged |
| 3 | 05 launcher · 06 run contract | 03 + 04 merged |
| 4 | 07 init cutover · 08 add + extensions | 05 + 06 merged |
| 5 | 09 sealed artifact | 07 + 08 merged |
| 6 | 10 adversarial review | everything merged |
