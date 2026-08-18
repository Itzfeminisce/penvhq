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

**`defaultEnvironment` sits last in the chain.** Explicit → `PENV_ENV` → `NODE_ENV` → the declared
default. The env vars are what *this invocation* says; a committed key is the standing answer and
must not overrule them. It fills the case that used to refuse, and nothing else. It is checked
against the whitelist in `lookupEnvironment` and in `validateConfig`, so invariant 10 holds on the
runs where nobody typed a name.

**The no-environment refusal names the two sealed remedies only.** The old copy pointed at
`PENV_ENV`/`NODE_ENV`; those still work, but the seal asks for the flag and the declared key, and a
four-way remedy is not a next command.

**The missing-pull refusal fires only where there is something to pull from.** An environment whose
`providers` entry is the local filesystem tree has no elsewhere, so `Run: penv pull` would be a
command with nothing to do — that cohort gets the validation/direct-start answer instead.
`hasRemoteSource` in `packages/runtime/src/resolve.ts` is the single place that decides, and the
CLI's `run` reads it too. The sealed string carries no parameter name: nothing at all resolved, so
there is no single one to name.

**`DirectStartError` extends `ValidationError`.** It is that failure told to the one reader whose
remedy is a different command, so it keeps the issues and the `VALIDATION_FAILED` code that the
CLI's cross-realm unwrapping (`validationIssuesOf`) keys on. `ValidationError` gained an optional
wording argument for exactly this.

**The bridge still resolves the local tree.** PRD §4's "the bridge validates the injected
environment only" is *not* implemented here: it changes `load`'s source of truth for every consumer
and every fixture in the repo, and it is what `--source snapshot` will actually need (a container
has an artifact and no tree). ISSUE-09 should take it, together with the snapshot source. What is
implemented here is the refusal the seal asked for, at the bridge, from the resolution it already
performs.

**The marker is `PENV_RUN`, and it carries the outer invocation.** `run` stamps it *after* the strip,
so an inherited one cannot survive and the new one cannot be swept away. `load` consumes it out of
`process.env` on the first call (`consumeRunMarker`, memoised) — that is how it is visible to a
nested penv, which checks before anything loads, and not to the application, whose first act is the
bridge. `run` also sets `PENV_ENV` in the child, so the bridge validates the environment penv
resolved rather than re-deciding it.

**Provider credentials are a table keyed by provider package name, applied only to declared
providers.** penv deliberately owns no credential of its own — `VAULT_ADDR`/`VAULT_TOKEN` are the
Vault CLI's, `gh auth login` keeps GitHub's — so there is no config field to read and naming them is
the only way to keep them out of the child. `AWS_REGION` is excluded: a destination, not a
credential. A project that never names Vault keeps its own `VAULT_TOKEN`.

**penv's own line goes to stderr.** The child owns stdout, and `penv run -- node -e … | jq` must
deliver the child's bytes and nothing else.

**Windows `.cmd`/`.bat` targets go through `cmd.exe /d /s /c`.** Node refuses to execute a shim
without a shell, and every node-installed tool (`pnpm`, `next`) is one there. The command line is
built with `windowsVerbatimArguments` and each argument escaped for cmd — double-escaped for a
`node_modules\.bin` shim, which re-invokes cmd on its own way through. Everything else spawns
directly, on every platform. No shell is ever interposed.

**`--watch` syncs at start and on every debounced tree/config change, then re-checks, then
restarts.** A failed pull *or* a failed check aborts the cycle and leaves the current child exactly
where it was. There is no provider polling: no provider contract offers a change feed, and the
trigger is the local tree. A failed sync at *start* still starts the child — a provider being down
is not a reason an application cannot start. A child that ends on its own ends the run, rather than
the run waiting for an edit that might restart it.

**`validate` gained `checkEnvironment`.** `runValidate` is now a thin wrapper over it, and `run`
takes the same verdict plus the resolutions and validated object it was reached on. Two walks of the
tree could disagree, and then `run` would start a process CI had already rejected.

**The `import` assertion is measured on what a terminal shows.** `style.ts` exports `visibleText`
beside `visibleWidth` — one place that knows what a style sequence looks like — and the test keeps
asserting the whole line. Verified failing under `FORCE_COLOR=3` before the change and passing
after.

**Seams logged, not built.** The framework-active `.env*` reappearance check belongs in run's
preflight and is ISSUE-07's to write (a `prepare` in `commands/run.ts` is where it goes).
`--source snapshot` refuses by naming the artifact feature, for ISSUE-09 to replace. Nothing was
needed from `packages/launcher`.

**Test-suite note.** Six full `pnpm test` runs: four green, and two in which a handful of unrelated
jiti-heavy tests (`project.test.ts`, `doctor.sink.test.ts`) hit the 5s per-test timeout. One of the
two was demonstrably a second suite running in parallel on the same four cores. Their assertions are
timing-free and they pass alone, so this is machine load meeting a 5s default, not a new dependency
— but this issue's tests do add real child processes and a dozen more schema evaluations to the run,
so the margin is thinner than it was. If it recurs in CI, the per-test timeout is the knob.
