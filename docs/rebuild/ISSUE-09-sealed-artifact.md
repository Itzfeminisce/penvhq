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

1. **`values` is keyed by parameter id, and each entry carries its `variable`.** The settled
   decision names "the final resolved non-local winner for each schema-declared delivery mapping";
   keying by variable alone would have lost the parameter the mapping belongs to, which the
   application's bridge needs to place the value at its schema key. Carrying both is strictly more
   of the delivery contract and no more of anything else — both halves are names.
2. **A declared mapping with no winner is carried as `{ kind: "absent" }`.** Exclusivity is the
   reason: `penv run` must *delete* a variable the schema declares and the environment has no value
   for, or a stale variable in the container stands in for a value penv resolved to nothing. An
   omitted entry could not express that, and the six top-level keys stay exactly as settled.
3. **`schemaDigest` is a sha256 over the sorted `(parameter id, variable)` pairs, and the reader
   recomputes it from the artifact's own `values`.** The reader has no schema to compare against —
   that is the whole point of the path — so the digest's checkable meaning is that the artifact's
   delivery mappings are the ones it was built with. A mapping added, removed, or renamed after the
   build refuses before anything is decrypted. A value changing does not move the digest, so a
   rebuild after `penv set` is not a contract change.
4. **Sealed values travel verbatim, with the value file's address beside them.** `penv artifact
   build` therefore never decrypts and CI never needs the key, and invariant 17 stays exact: the AAD
   is still the value file's full name. `openSealed(address, …)` was added to core because a
   container has no environment whitelist to parse that address back into a `ValueFile` with.
5. **`--out` is required, like `--env`.** There is no default path, because every default worth
   having would be inside the repository, which is the layout the issue rules out.
6. **`build` refuses a plaintext secret and a public-prefixed secret; it does not re-run
   `penv validate`.** The CI sequence is `pull → validate → build`, and a second verdict on "is this
   configuration good" would eventually let `run` start what `validate` rejected. These two are not
   that verdict — they are the delivery boundary's own refusals, made here because the container
   reading the artifact has no meta left to check either against.
7. **`penv run --source snapshot` takes `--env` as optional; when given it must match exactly.** The
   artifact names its own environment and there is no config to default from. A mismatch is refused
   with one command (build the environment you asked for).
8. **`--watch` with `--source snapshot` is refused, not ignored.** There is no tree to watch, and a
   flag that quietly does nothing is a developer waiting for a restart that is never coming.
9. **`doctor`'s artifact scan is bounded to `.json` files under 1 MiB, outside `.git` and
   `node_modules`, and identified by the six format-1 keys.** The writer only ever produces canonical
   JSON, so the bound costs nothing real; identification is by keys rather than by a successful
   parse, because a digest-mismatched or newer-format artifact is still an artifact sitting in the
   repository.
10. **The inject-only bridge (PRD §4, deferred here from ISSUE-06).** `load` now reads the injected
    child environment and validates *that*; it opens no config, walks no tree, decrypts nothing, and
    constructs no provider. The delivery contract travels in `PENV_DELIVERY` — parameter id →
    variable, names only — because `override` makes the mapping unguessable and a container has no
    config to read it from. The bridge reads it back as the `override` block it is, which is the only
    piece of configuration it needs. `LoadOptions.cwd` is gone (it had nothing left to address) and
    `LoadOptions.env` replaces it. The tree-reading cascade stays in `runtime/resolve.ts` for the
    schemaless `penv/config` compat entry, with its tests moved to `runtime/resolve.test.ts`.
11. **The missing-pull refusal moved from the bridge to `penv run`.** The bridge cannot know whether
    an environment has anywhere to pull *from* — that is config. `penv run`'s `prepare` already made
    the same refusal and its sealed copy is asserted verbatim in `cli/src/commands/run.test.ts`. The
    direct-start refusal stays at the bridge, copy unchanged, asserted verbatim in
    `runtime/src/bridge.test.ts`. `MissingMaterializationError` stays exported from the runtime
    barrel: it is still thrown, by the CLI, and it is part of core's error taxonomy.
12. **The environment a bridge refusal names** is `options.environment`, then `PENV_ENV` (which
    `penv run` pins), then `NODE_ENV`, then `development`. The last is a message, never a decision
    that writes anything — invariant 21 is about `init` inventing deployment environments, and
    nothing here writes config.
13. **Acceptance grep.** `grep -ri "penv.snapshot" packages/` matches the CHANGELOG entries that
    announced the retired module and the `PENV_SNAPSHOT` variable the new path reads (`.` matches
    `_`). Read as intended — `penv.snapshot.ts` in package sources — it is zero: the only matches are
    two tests asserting the file's absence and one docstring naming what the artifact replaced.
