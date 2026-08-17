# ISSUE-06 — The `penv run` contract

**Branch:** `issue/06-run-contract` · **Wave 3** (after 03 + 04 merge; parallel with 05 — do not
touch `packages/launcher`).

## Goal

`penv run` per PRD §4 with seals 1–3: an opaque, network-forbidden command runner with an owned
child environment, `--source` defaulting to `project`, `--env` falling back to a declared
`defaultEnvironment`, and nested runs refused.

## Read first

PRD §4 and §5, friction items 1–3 and 10; `packages/runtime/src/load.ts`/`resolve.ts`;
existing `packages/cli/src/commands/watch.ts` (reuse its child-process handling if sound).

## Settled decisions (do not relitigate)

- `penv run [--env <e>] [--source project|snapshot] [--watch] -- <command> [args…]`. `--source`
  defaults to `project`. `snapshot` is accepted by the flag grammar but implemented in ISSUE-09 —
  until that merges it refuses with copy naming the artifact feature, not a stub that half-works.
- `defaultEnvironment` is a new declared key in `penv.config.ts` (validated against the
  environment whitelist; inference stays forbidden). `--env` omitted + no default = refusal naming
  both remedies. `pull`, `push`, `set` and friends honor the same default.
- The child is opaque: spawn the exact command after `--`, preserve argument boundaries, pipes and
  lifecycle hooks stay the package manager's business, forward exit code and signals.
- Owned child environment: every schema-declared mapped variable is overwritten with the resolved
  value or **deleted** if optional and absent; unrelated host variables remain; penv key
  variables, provider credentials, and internal control variables are stripped before spawn.
- Network-forbidden: `run` constructs no provider. Missing materialization is a named failure.
  `--watch` (opt-in) is the only run mode allowed to sync; a failed pull/validation leaves the
  current child running.
- Nested run: `run` sets an internal marker in the child env; a `penv run` that finds the marker
  refuses, naming both invocations (the marker is one of the stripped-from-app variables — it is
  visible to a nested *penv*, not to the application; get this ordering right and test it).
- Public-prefix policy is checked before spawn: a secret mapped to a public-prefixed variable
  refuses with the parameter named.
- Sealed refusal copy, asserted verbatim in tests (friction item 10):
  - Direct start outside `penv run` (the runtime bridge's error): names the missing parameter and
    prints the exact `penv run -- <their command>` remediation shape.
  - First missing pull: `No materialized values for <env>. Run: penv pull` (docs voice, parameter
    and environment named where known).

## Tasks

1. Implement/rebuild `commands/run.ts` + the child-env assembly in runtime; wire `defaultEnvironment`
   through config parsing and every env-taking command.
2. Tests: child spawn forwarding (use a tiny node child fixture), env ownership (overwrite /
   delete-optional / preserve-unrelated / strip-penv), nested-run refusal, source default,
   env default + refusal, public-prefix refusal, network-forbidden (no provider constructed —
   assert via mock provider counter), watch remains opt-in.

## Out of scope

The launcher (05), init's proposal of `defaultEnvironment` (07), the snapshot source's real
implementation (09).

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; every refusal in this issue asserts its copy
verbatim and names exactly one next command.

## Decisions log

(append here)
