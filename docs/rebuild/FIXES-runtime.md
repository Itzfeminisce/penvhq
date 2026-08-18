# Fix log — runtime, child environment, and the sealed artifact

The adversarial review's findings against `packages/runtime`, `packages/core/src/artifact.ts`,
`packages/cli/src/child.ts`, and the `run` / `artifact build` commands. One section per finding:
what was wrong, what it is now, and the test that fires on the defect beside the one that stays
quiet on the fix.

---

## 1 (blocker) — Windows env-var case-insensitivity defeated the strip and the delete

**Was.** `childEnvironment` spread the host into a plain object and matched by exact key. On
Windows that loses the environment block's own rule: `penv_key_prod` in the host *is*
`PENV_KEY_PROD` — `createEnvKeySource` reads it and decrypts with it — but the strip never saw it,
so the key reached the child. The same miss ran the other way: `Database_Url=STALE` survived the
exclusivity delete of `DATABASE_URL`, and the application read the stale value penv had resolved to
nothing.

**Now.** `childRecord` (`packages/runtime/src/child-env.ts:110`) builds the record the child
environment is assembled in. On POSIX it is the plain copy it was; on Windows it is a view that
resolves every read, write, delete and `in` to whichever spelling the host used, keeping that
spelling — which is what Node hands the child, and what Windows resolves either way. The strip, the
key-prefix match (`penvOwnVariables`), `inject`'s write-or-delete (it targets this record), and the
control stamp all go through it, so one place decides and the exact-case POSIX semantics are
untouched.

**Tests** (`packages/runtime/src/child-env.test.ts`, "names, as the platform reads them"). Each
case is asserted on both platforms — `process.platform` is overridden per test, so neither half
depends on where the suite runs.

| Fires on the defect | Stays quiet |
|---|---|
| `strips an inherited key whatever case the host spelled it in` | `leaves that same spelling alone where names are exact` |
| `deletes a valueless parameter under the spelling the host used` | `keeps a differently-cased variable where names are exact` |
| `overwrites a resolved parameter once, not beside itself` | the whole existing exact-case suite |
| `strips a declared provider's credentials whatever case they arrived in` | |
| `takes back an inherited control channel and stamps its own once` | |

Verified by reverting `caseInsensitiveNames()` to `false`: exactly those five fail, the POSIX ones
pass.

---

## 2 (should-fix) — `DELIVERY_CONTRACT_INVALID` was a one-shot refusal

**Was.** `consumeDelivery` deleted `PENV_RUN` and `PENV_DELIVERY` from the environment *before*
`parseNames` could throw, and left `consumed` unset. The second `load` therefore found no contract
at all, fell back to the default name transform, and delivered each parameter from whatever
variable happened to match — the outcome the channel exists to prevent, and the one the function's
own comment forbids.

**Now.** The refusal is cached beside the answer (`child-env.ts:391`): `refused` is thrown by every
subsequent call, and `resetDelivery()` clears both. Emptiness is never cached.

**Tests** (`packages/runtime/src/load.test.ts`, "a delivery contract that is not the one penv
writes"): `is refused when it is not JSON`, `… a JSON array`, `… a mapping is not a variable name`,
and the one that fires on this defect — `is refused again on the next load, not silently guessed`.
Quiet: `stays quiet for the contract penv actually writes, read twice`.

---

## 3 (should-fix) — the `.bin` shim double-escape was decided on the un-normalized path

**Was.** The shim test ran against `resolved` while the command was escaped from
`normalize(resolved)`, so `./node_modules/.bin/next.cmd` missed the shim branch and got single
escaping. The shim's inner `cmd` then re-expanded `&`, `|` and `>` in the arguments.

**Now.** `cmdCommandLine` (`packages/cli/src/child.ts:162`) normalizes first with `win32.normalize`
— the line is only ever read by cmd.exe — and judges the shim on what cmd will see.

**Tests** (`packages/cli/src/child.test.ts`): `double-escapes the same shim written with forward
slashes` and `finds a shim below an absolute forward-slash path` fire on the defect;
`double-escapes a shim written with backslashes` and `escapes once for a .cmd that is not a shim`
stay quiet.

---

## 4 (should-fix) — the delivery digest omitted each entry's address

**Was.** `deliveryDigest` hashed `[id, variable]`. A sealed entry is `(address, ciphertext)` and the
address is the AAD, so both travel together: `db.password`'s sealed pair dropped under
`analytics.token` still parsed, still opened, and delivered the database password as
`ANALYTICS_TOKEN`. Invariant 17 cannot see it — the AAD moved too.

**Now.** `packages/core/src/artifact.ts:123` hashes `[id, variable, address]` for a sealed entry and
`[id, variable]` for the others. The address is a name, stable across re-seals at the same scope, so
values still never enter the digest and a rebuild after `penv set` hashes the same.

**Tests** (`packages/core/src/artifact.test.ts`): `changes when a sealed pair is moved to another
parameter` and the reader-level `refuses a sealed pair moved to another parameter` fire; `covers the
mappings and not the values` and `is the same after a re-seal at the same scope` stay quiet.

---

## 5 (should-fix) — a third-party extension's credentials always reached the child

**Was.** Four first-party providers' credential variables were hardcoded, so a project using
`@acme/provider-consul` handed `CONSUL_HTTP_TOKEN` straight to the application — against the PRD's
"extensions receive only their declared credentials".

**Now.** An extension declares its credential variables in its own `package.json`, under
`penv.credentials`, symmetric with the settled `penv.types` / `penv.onboard`:

```json
{ "name": "@acme/provider-consul", "penv": { "credentials": ["CONSUL_HTTP_TOKEN"] } }
```

`declaredCredentials` (`packages/cli/src/commands/run.ts:332`) resolves that declaration from the
package the project actually installed, for the providers the config actually names, and passes it
to `childEnvironment` as `credentials`. `strippedVariables` unions it with the four penv ships. The
manifest format is untouched.

**Tests.** Runtime (`child-env.test.ts`, "an extension's declared credentials"): `never reach the
child`, `are the only ones taken — a variable it did not declare survives`, `are absent when the
extension declares none, and the first-party four still are not`. CLI (`run.test.ts`, "an
extension's credentials"): `never reach the child when the package declares them`, `stay where the
package declares none`, `refuse the run when the declaration is not a list of names`, `are known
without a declaration for the providers penv ships`.

**Honest limits.**

- A run from a sealed artifact (`--source snapshot`) strips no provider credentials at all, an
  extension's included. That is the existing design and it is unchanged: a container has no config
  to declare a provider in, and deleting its `AWS_ACCESS_KEY_ID` because some other project uses SSM
  would break an application that legitimately reads it.
- The declaration is read from the installed package — code penv is about to load anyway — not from
  the committed manifest. A provider whose package cannot be resolved from the project contributes
  nothing, but `assertProvidersRegistered` already refuses such a config at open, so there is no
  silent-skip path in practice. The two providers penv ships inside the CLI (filesystem, mock)
  resolve from the CLI rather than the project and hold no credentials.
- A malformed `penv.credentials` refuses the run (`PROVIDER_CREDENTIALS_INVALID`) rather than being
  skipped. Skipping would hand that extension's credentials to the application without saying so.

---

## 6 (nit) — `runArtifactBuild` never ran the name-collision check

**Was.** An `override` mapping two parameters to one variable emitted both entries, and delivery in
the container took whichever penv wrote last — silently, where nobody is left to notice.

**Now.** `packages/cli/src/commands/artifact.ts:171` calls `assertDeliverableNames`, the same check
`inject` makes.

**Tests** (`packages/cli/src/commands/artifact.test.ts`): `refuses an override that maps two
parameters to one variable` (and asserts nothing was written). Quiet: the existing "the bytes" suite,
which builds with a non-colliding `override`.

---

## Nits

**A generated name in penv's control namespace.** `stampControl` runs after `inject`, so a parameter
generating `PENV_ENV` / `PENV_RUN` / `PENV_DELIVERY` was written, clobbered a line later, and still
claimed as delivered by the contract. The rule now lives in one function —
`assertDeliverableNames` (`packages/runtime/src/control.ts:77`), which carries invariant 12 and the
reserved-name refusal together — called by `inject` (so `penv run` and `load({ inject })` refuse) and
by `penv artifact build`. Tests: `child-env.test.ts` "a parameter in penv's own namespace" (`is
refused before anything is written` / `is only the exact names — a parameter beside one is
delivered`) and `artifact.test.ts` `refuses an override that delivers into penv's own channel`.
The control-variable names moved out of `child-env.ts` into `control.ts` so `inject` can reach them
without a cycle; `child-env.ts` re-exports them, so the public surface is unchanged.

*Limit:* `deliveredEnvironment` does not re-check the mappings an artifact carries. Editing one
changes the delivery digest and is refused, and `artifact build` now refuses to produce one — but an
artifact built by a penv older than this fix could still carry a `PENV_*` mapping.

**`load` read the environment through the prototype.** `load.ts:198` now reads with core's `own`, so
a contract naming `constructor` finds nothing instead of a function. Test: `reads a delivered
variable off the environment's own keys`.

**`--watch` had no kill escalation.** `stop` (`run.ts:532`) sends SIGTERM and escalates to SIGKILL
after `stopGraceMs` (default 5s, injectable alongside the file's other seams). Tests: `insists when
a replaced child will not leave` fires; `asks once when the child leaves on its own` stays quiet.

**`--watch` reported the first run's counts.** The result now carries the environment the running
child was given. Test: `reports the run that is running, not the first one` (the tree gains a value
between the two runs, so `written` is 2 rather than 1).

---

## Decisions

1. **The platform is read at call time**, not captured at module load, and tests override
   `process.platform` per case. No production seam was added for it: a `platform` input on
   `ChildEnvironmentInput` would be an option nobody would ever pass but a test.
2. **`penv.credentials` is a list of variable names, and nothing else.** No globs, no per-environment
   shape. penv strips exactly what an extension names, so anything it cannot read plainly is a
   refusal rather than a guess.
3. **`stopGraceMs` is a public `RunOptions` field** (5s default) rather than a hidden constant,
   matching how `start`, `pull` and `changes` are already injected in this file.
4. **The digest carries the address only for sealed entries.** A plain entry's value is in the
   artifact anyway and a secret can never be plain (`ARTIFACT_PLAINTEXT_SECRET`), so nothing is
   gained by hashing it — and hashing values would break the rebuild-stability property the digest
   is for.

## Verification

`pnpm typecheck && pnpm test && pnpm lint`, from the worktree root: 73 test files, 1762 tests, no
type errors, lint clean.
