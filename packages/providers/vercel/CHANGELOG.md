# @penvhq/provider-vercel

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
