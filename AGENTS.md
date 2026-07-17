# AGENTS.md

Instructions for AI coding agents working in the penv repository. Read this before making changes. Human docs: [README.md](./README.md), [Documentation](./docs/Documentation.md) (the finished design), [Roadmap](./docs/Roadmap.md) (what's available when), [RFC](./docs/RFC.md) (why).

If a change conflicts with an invariant below, stop and surface it to the human. These are settled design decisions with recorded rationale in the RFC — not defaults waiting to be improved.

**Know which document owns what.** The docs describe finished penv with no "not yet" language. The roadmap owns all availability and versioning. The RFC owns rationale. When you write or edit text, keep temporal claims ("not yet," version numbers, "amber until v0.4") in the roadmap only; keep permanent design properties in the docs; keep reasoning in the RFC.

---

## What penv is

penv stores each config parameter as its own file, in a tree that mirrors how Vault/SSM/Kubernetes store the same data. One Zod schema drives both runtime validation and TypeScript types. A local penv record and a provider path are two serializations of one logical record `(environment, path, name)` — so switching provider is a config change, not a rewrite. The value is deleting the hand-maintained translation between local `.env` and the production secret manager. A change that reintroduces a manual, drift-prone seam is a regression even if tests pass.

## Setup, build, test

> Assumes pnpm + TypeScript + Vitest. Correct this file if the repo differs.

```bash
pnpm install
pnpm build          # tsc
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome
```

Run `pnpm typecheck && pnpm test && pnpm lint` before proposing a change as done. Type errors here are frequently real invariant violations, not noise.

## Invariants — do not violate without human sign-off

1. **One schema, never per-environment.** Exactly one schema, in `.penv/env.ts`. Do not add per-environment schemas or fork by env — forking reintroduces the drift penv removes. Per-env requiredness is meta policy, not a second schema.

2. **`env.ts` is scaffolded once, never regenerated.** `penv init` writes it; the user owns it. Do not add codegen that overwrites it. Generate the `@env` alias, not the file. A generated type is a second representation that drifts from the schema — the exact disease penv treats.

3. **`load` must stay generic.** `load<T extends z.ZodType>(schema: T): z.infer<T>`. If it ever returns a non-inferred type, the entire type-safety story collapses to `unknown`. Keep a type-level test asserting the return type.

4. **Value resolution is the `.env` cascade, flat override.** `<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`, most-specific wins, no merging of values. These are the four levels Next.js and Vite already use (`.env.[mode].local` > `.env.local` > `.env.[mode]` > `.env`), one parameter at a time — matching them is the whole point, so do not drop a level or invent a different order. Both `.local` scopes are skipped in the `test` environment. Do not add value merging.

5. **Meta merges shallow, base→env only.** Env block overrides base per top-level key; nested objects replace wholesale (no deep-merge); `.local` does not participate in meta. The effective meta for an env must be computable by reading exactly two objects. Do not add deep-merge.

6. **`.enc` is a terminal marker, orthogonal to scope.** Grammar: `<scope>` then `.enc`, always last. `<name>.enc`, `<name>.<env>.enc`, `<name>.local.enc`, `<name>.<env>.local.enc` are all valid. `<name>.enc.<env>` is an error. Within a scope, `.local` follows the environment (`<name>.production.local`), never precedes it. Meta is always plaintext — never `.enc` a meta file.

7. **Rotation state never lives in value filenames.** No `.current`/`.previous` value suffixes. Current value is the value file; previous value lives in the provider during the grace window; rotation phase lives in meta. Do not change the tree's shape mid-rotation.

8. **`lastRotated` and `rotatingSince` are different clocks.** Overdue uses `lastRotated`; stuck uses `rotatingSince`. Stuck detection is gated to `rotationMode: dual-valid` — never flag `atomic-cutover` as stuck. Do not collapse the fields.

9. **Two rotation modes are distinct mechanisms.** `dual-valid` and `atomic-cutover` are not two configs of one code path.

10. **Environments are a config whitelist, never inferred.** A filename segment is an environment only if declared in `penv.config.ts`. No inference from folders/filenames.

11. **Reserved-token validation is mandatory and an error, not a warning.** Every env name plus `enc`, `json`, `toml`, `yml`, `local` are reserved. Collision fails `penv validate`.

12. **Name-mapping collisions fail `validate`.** Two parameters mapping to the same generated variable must error. Never last-write-wins.

13. **Fallback resolution is never silent.** Unscoped-default resolution for a real environment must surface in `penv doctor`.

14. **Encryption is policy-driven, not filename-driven.** Meta declares must-encrypt; the `.enc` marker is validated against it. A secret with a committed plaintext value file is a `doctor` failure. Do not add an `--encrypt` flag: it would make the command line the authority on what is secret, inverting the direction the check runs in.

15. **A key source never falls back to another one.** An unrecognised or unavailable source refuses, loudly. Sealing under a key penv picked because it could not find the one you named is the failure that makes encryption decoration. Relatedly: "the source could not be consulted" and "the source holds no such key" are different answers with opposite remedies and must never collapse into one.

16. **"Cannot decrypt" is never reported as "no value".** A present-but-unopenable winner carries `undecryptable`; a genuine absence carries neither that nor a value. Any caller that treats `value === undefined` as missing will tell a user to overwrite a secret they still have.

17. **A ciphertext is bound to its address.** The AAD is the value file's full name, so a sealed value cannot be copied between scopes. Never widen the AAD to the parameter alone — that reopens the scope-widening leak at the one layer below the cascade.

15. **`import` is one-directional.** After import, `.penv/` is source of truth; generated `.env` is an artifact. No silent reverse-sync of hand-edits.

16. **penv does not reimplement provider ACLs.** Access control is proxied to Vault policies / IAM.

17. **Value files are gitignored; only structure/`env.ts`/meta/config are committed.** Never weaken this. A change that could commit a plaintext secret is a security regression regardless of tests.

18. **`init` may default what it can observe; it must ask for what it cannot.** A fact about the codebase (the framework in `package.json`, whether `src/` exists) may be detected and proposed. A fact about the deployment — `environments` above all — may not: no file says whether a staging tier exists, and an invented environment accepts writes for infrastructure that does not. Unanswered means empty, and `CONFIG_ENVIRONMENTS_EMPTY` is written to be reached.

19. **Config records decisions, not identities.** There is no `framework` key and must not be one. Detection is an input to `init`; what gets written is the concrete facts it implied (`schemaFile`, `publicPrefixes`). A stored identity is one penv reinterprets on every run, so the meaning of a committed config could shift under the user when penv or the framework changes. Guess once, declare forever.

## Provider-contract rule (roadmap-critical)

**Do not modify the provider contract to accommodate a specific provider.** If Vault/SSM/Kubernetes seems to need a contract change, that is a finding to surface — it may mean the abstraction is wrong — not an edit to push through. Every provider satisfies one contract, with the filesystem provider as ground truth, or the portability claim is false.

## Positioning guardrails (docs, errors, comments)

- Do not claim penv beats t3-env on local dev speed. It doesn't, structurally.
- Do not add "not yet"/version language to the docs — that belongs in the roadmap.
- Do not describe encryption security or provider portability in the docs as *conditional* — the docs describe finished penv, where both hold. Their *availability* is the roadmap's job.
- Keep the permanent design tradeoffs visible in the docs; do not sand them off.
- Error messages follow the docs voice: name the parameter and environment, say what's wrong and how to fix it. `Missing required parameter redis.password for environment production` — never `Something went wrong`.

## Coding conventions

- TypeScript strict. No `any` in exported surfaces. Prefer inferred types from Zod over hand-written duplicates — duplication is the drift penv opposes; practice it in the code too.
- `import { env } from "@env"` is the blessed runtime path. Type-only consumers import `schema`, not `env`, to avoid triggering eager load. The `import "penv/config"` form is compat-only and carries an ESM ordering caveat.
- Every new `doctor` check needs a test that fires (true positive) *and* stays quiet when it should (no false positive). Stuck-rotation-vs-atomic-cutover is the canonical reason the negative test matters.

## Definition of done

1. `pnpm typecheck && pnpm test && pnpm lint` pass.
2. New behavior has tests, including negative cases for `doctor`/validation checks.
3. No invariant violated (or the violation is explicitly flagged with reasoning).
4. If provider behavior changed, the filesystem provider and every other provider still pass the *same* contract suite, unchanged.
5. User-facing text respects the positioning guardrails and the document-ownership split.

## When unsure

If a task seems to require breaking an invariant or bending the provider contract, that is usually a design question, not a coding one. Surface it with the specific invariant it touches. Reintroducing a hidden seam is the one failure mode this project exists to prevent — err toward flagging it.