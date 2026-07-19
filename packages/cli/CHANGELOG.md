# @penvhq/cli

## 0.3.1

### Patch Changes

- e20f411: A schema guarded with `import "server-only"` no longer stops the CLI from reading it.

  Next.js apps guard `.penv/env.ts` with `server-only` so the loaded config can never
  reach a client bundle — but that package's default export throws outside a React
  Server bundle, so `penv validate` / `penv fill` / `penv doctor` (which evaluate the
  schema module in plain Node) failed with "This module cannot be imported from a
  Client Component module" before ever seeing the `schema` export.

  penv's module loader now resolves `server-only` the way a React Server environment
  would: it probes the user's own installed `server-only` under the `react-server`
  resolution condition — the package's empty, no-throw variant — and pins the import
  there. Projects that don't depend on `server-only` resolve exactly as before, and
  the config loader (`penv.config.ts`) and the schema loader now share one loading
  path so both evaluate user modules identically.

- Updated dependencies [e20f411]
  - @penvhq/core@0.3.1
  - @penvhq/provider-filesystem@0.3.1
  - @penvhq/provider-kubernetes@0.3.1
  - @penvhq/provider-mock@0.3.1
  - @penvhq/provider-ssm@0.3.1
  - @penvhq/provider-vault@0.3.1
  - @penvhq/runtime@0.3.1
  - @penvhq/sink-github@0.3.1

## 0.3.0

### Minor Changes

- f02a21a: Add `penv fill` and guard the write path against non-canonical parameter keys.

  `penv fill` prompts for each declared parameter the tree has no value for, deriving the value-file name from the schema so you never translate a camelCase schema key to its kebab file yourself. On the write path, `penv set` and the `penv mv` destination now refuse a non-canonical key and point you at the canonical lower-case hyphenated name.

- 972a177: Add the AWS SSM Parameter Store and Kubernetes Secrets providers — v0.6, generalizing the portability proof from Vault's single adapter to three, with no change to the v0.5 provider contract.

  - **`@penvhq/provider-ssm`** — a `RetainingProvider`. Reads always decrypt (a `SecureString` read without `WithDecryption` returns ciphertext as the value); every value is stored behind a one-byte sentinel so an empty penv value satisfies SSM's non-empty `Value` rule while round-tripping byte-exactly; `readPrevious` reads `GetParameterHistory`; meta is a sibling parameter at its own name.
  - **`@penvhq/provider-kubernetes`** — a plain `Provider` that **declares retention absent** (Kubernetes Secrets keep no history, so `retainsPrevious` narrows it to `false` and a `dual-valid` rotation refuses it up front). penv's arbitrary-depth namespace flattens into one Secret's flat data keys via a reversible, collision-free escape — every byte outside the key alphabet `[A-Za-z0-9.-]` becomes `_` plus its two-hex UTF-8 byte — settling the flattening collision hazard for any name, including those with spaces or non-ASCII. The cluster namespace is configurable (`providers.*.path` is `<namespace>/<secret>`), defaulting to the current `kubectl` context.

  Both pass the `@penvhq/provider-contract` suite unchanged, and both register as `providers.*.type` — `ssm`, `kubernetes` — in the CLI. Each reaches its backend only through the backend's own CLI (`aws`, `kubectl`), so penv holds no cloud credential of its own; the contract proofs run against injected in-memory fakes.

### Patch Changes

- Updated dependencies [972a177]
  - @penvhq/provider-ssm@0.3.0
  - @penvhq/provider-kubernetes@0.3.0
  - @penvhq/core@0.3.0
  - @penvhq/provider-filesystem@0.3.0
  - @penvhq/provider-mock@0.3.0
  - @penvhq/provider-vault@0.3.0
  - @penvhq/runtime@0.3.0
  - @penvhq/sink-github@0.3.0

## 0.2.0

### Minor Changes

- 31171e9: Resolve an unregistered `providers.*.type` as a convention-loaded provider plugin.

  A `type` with no built-in entry (`filesystem`, `vault`, `mock`) is now loaded from the package `@penvhq/provider-<type>` — or the package a new optional `providers.*.module` field names — and validated against the `Provider` contract before it is trusted. This is the same shape ESLint uses for `eslint-plugin-<name>`: penv stays generic, and a private or third-party backend plugs in by being installed, with no change to penv itself.

  The open-time guarantee is unchanged. A provider that is neither built in nor installed still fails at `openProject`, now with an `npm i @penvhq/provider-<type>` hint. The check is a synchronous package-resolution probe that runs no plugin code, so `openProject` stays synchronous; the plugin's module is imported only when an environment's source of truth is actually built (`penv pull`, cross-provider `doctor`, `rotate`). The built-in providers and the static registry are untouched.

### Patch Changes

- Updated dependencies [31171e9]
  - @penvhq/core@0.2.0
  - @penvhq/provider-filesystem@0.2.0
  - @penvhq/provider-mock@0.2.0
  - @penvhq/provider-vault@0.2.0
  - @penvhq/runtime@0.2.0
  - @penvhq/sink-github@0.2.0

## 0.1.0

### Minor Changes

- 094bd3a: Filesystem core, schema and types — roadmap v0.1 and v0.2.

  v0.1 retires the risk that the many-files storage model is unworkable day to day: the
  filesystem provider, the filename grammar with reserved-token validation (`.enc` reserved
  from day one, though encrypt/decrypt lands at v0.3), the value cascade
  (`<name>.<env>.local` > `<name>.local` > `<name>.<env>` > `<name>`, flat override, both
  `.local` levels skipped in `test`, loud fallback surfacing) — the four levels Next.js and
  Vite use, matched so that an ordinary `.env.development.local` has somewhere to go —
  `init`/`import`/`generate`/`get`/`set`/`remove`/`list`, the runtime loader with its
  `process.env` compatibility path, and `.gitignore` automation.

  `penv import` reads the scope out of the source filename, and `--env` names it for a file
  whose name carries none. Both exist for one reason: flattening a scoped file to the
  unscoped default is not a lossy import, it is a scope-widening leak — the value becomes
  what every _other_ environment reads.

  v0.2 retires the risk that "type-safe" and "validated" are claims penv cannot back:
  `.penv/env.ts` scaffolding with the `@env` alias, the generic
  `load<T extends z.ZodType>(schema: T): z.infer<T>`, `penv validate`, `.json` meta with
  shallow base→env merge, the deterministic name transform with collision detection, and
  draft schema generation on import.

- 71c081e: First public release of the `@penvhq/*` packages: `@penvhq/penv` (the batteries-included package users install — carries the `penv` bin and re-exports `load`/`defineConfig`), plus `@penvhq/core`, `@penvhq/runtime`, `@penvhq/cli`, `@penvhq/provider-filesystem`, `@penvhq/provider-contract`, and `@penvhq/sink-github`.

  The `@penv` org and the unscoped `penv` name are both taken on npm, so everything publishes under `@penvhq`. The tool name, the `penv` command, `.penv/`, and `penv.config` are unchanged — only the npm namespace moves. `penv init` scaffolds imports from `@penvhq/penv`. The whole set is a fixed version group, so this one changeset bumps them together.

### Patch Changes

- Updated dependencies [094bd3a]
  - @penvhq/provider-filesystem@0.1.0
  - @penvhq/runtime@0.1.0
  - @penvhq/core@0.1.0
  - @penvhq/sink-github@0.1.0
