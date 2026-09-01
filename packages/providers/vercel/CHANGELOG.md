# @penvhq/provider-vercel

## 0.14.0

### Minor Changes

- fca6bbb: The workspace scan reaches `@penvhq/core`, and the Vercel declaration stops
  claiming a check it cannot make.

  **`penv upgrade` moves a workspace package's own `@penvhq/core`.** The scan that
  correctly found a second `@penvhq/penv` below the root looked for `@penvhq/core`
  only in the root it was writing to. A repository with two members declaring
  `^0.8.0` came out of a 0.13.0 upgrade holding two copies of the interfaces every
  committed provider declaration augments, five minor versions apart, under one
  engine pin. Every `package.json` that declares either package now moves — in the
  block that package chose, in its own step, under the same one consent — and the
  diff names each file, so a member that would not typecheck against the newer core
  is a decline away.

  **The Vercel declaration's header no longer overclaims.** It said that writing
  the real shape out is what stops "a misspelled target **and** a target keyed by
  an environment that does not exist". The first half is true; the second could
  never be, because `ProviderConfigMap["@penvhq/provider-vercel"]` is a fixed
  interface with no access to the `environments` the config declares, and widening
  the provider contract so one provider could see them is not a trade penv makes.
  The provider refuses the key at construction instead, naming the offending key
  and the environments the project declares, and the header says that. `penv add`
  copies this declaration verbatim, so an already-adopted project gets the
  corrected header the next time it adds the provider.

  **An unknown field in a provider entry says which field and whose config.** The
  whole diagnostic was `Type 'number' is not assignable to type 'never'` — the
  right line and column, and nothing about why, beside a targets error in the same
  file that lists all three legal values. The excess key now maps to a type whose
  single member is the sentence, which TypeScript prints:
  `"retries is not a field @penvhq/provider-vercel declares"`.

  **Two honesty bugs in `penv upgrade`'s output.** The consent diff rendered the
  `@penvhq/core` step as though it were creating a `devDependencies` block, into
  root manifests that already had one with fourteen entries — the one
  nesting-shorthand line in an otherwise literal `-`/`+` diff, and so the one a
  reader would go and check by hand. An existing block now shows as the context it
  is. And the closing `✓` lines confirmed both `@penvhq/penv` declarations and the
  manifest pin while never mentioning `@penvhq/core`, the one change the previous
  release introduced. They now name every package that landed, per file.

## 0.13.0

## 0.12.0

### Minor Changes

- ca2fa13: Published provider extensions install and load.

  Every official provider now publishes self-contained: `@penvhq/core` and the zod
  it reaches for are bundled into the tarball rather than declared as dependencies.
  Nothing on the install path resolves a dependency — `penv add` unpacks one
  tarball into `$PENV_HOME` and stops — so a provider that shipped a bare
  `import "@penvhq/core"` died on its first line, and no published extension could
  be loaded at all.

  `penv install` now imports every extension it installs, the same check `penv add`
  runs, so a store that will not load fails at install time with the file and the
  cause instead of at the first provider operation days later.

  A refusal thrown by an extension is built from that extension's own copy of the
  error classes, so `instanceof PenvError` is false for all of it. Core gains
  `isPenvErrorLike`, and the CLI's renderer asks it: a provider's refusal now
  prints as the same two-line block as the engine's, without the stack frames it
  used to dump underneath.

  `@penvhq/provider-vercel`, `-github`, `-vault`, `-ssm` and `-kubernetes` each ship
  a `penv.types` declaration, so the file `penv add` commits carries the provider's
  real config shape — a misspelled Vercel target, or a key the provider never
  reads, is now a compile error in `penv.config.ts` instead of a push-time failure.

## 0.11.0

### Patch Changes

- Updated dependencies [8786e21]
  - @penvhq/core@0.11.0

## 0.10.0

### Minor Changes

- 2605975: Push penv parameters straight into a Vercel project's environment-variable store.

  `@penvhq/provider-vercel` is a projection-holding destination: `penv push --production` resolves your tree the way a deploy would read it and writes each variable into the project over Vercel's REST API, so a production cutover is one command instead of a settings form.

  Which Vercel target an environment deploys to is declared, never guessed — `targets: { production: "production", staging: "preview" }` — and an environment with no entry is refused by name before penv opens a connection. Your environment scope lands on that one target; the unscoped default covers all three, which is the breadth Vercel actually has. A parameter that would be one target's own value _and_ the shared default at once has no representation in a store with no override axis, so penv refuses that push and names the collision rather than silently picking a meaning.

  The access token arrives as the ambient `VERCEL_TOKEN` the package declares in `penv.credentials` — never a config field, never in the manifest — and `penv run` strips it before your application starts.

### Patch Changes

- Updated dependencies [1aa9a87]
  - @penvhq/core@0.10.0
