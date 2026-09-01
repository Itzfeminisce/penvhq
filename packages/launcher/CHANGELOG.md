# penv

## 0.15.0

### Minor Changes

- eb93f50: One `environments` record holds each environment's whole declaration, and every
  provider gets its own vocabulary back.

  **Three top-level structures become one.** `environments: string[]`, `providers`,
  and `keys` all described the same thing — what an environment _is_ — from three
  places, so reading one environment meant reading three. They merge into
  `environments: Record<string, string | EnvironmentEntry>`, whose entry names the
  provider that holds the environment, the fields that provider declares, and the
  `keySource` that seals it. The record's keys are still the whitelist: a key is a
  declaration, not an inference, so nothing about how an environment name is
  recognised has moved. An environment whose provider needs no fields is written as
  the package name alone — `development: "@penvhq/provider-filesystem"`.

  **`location` is deleted, and each provider takes its own field names.** One generic
  address field meant five stores answering to penv's word instead of their own:
  `location` for what Vercel calls a project, for what Vault and SSM call a path, for
  a `namespace/secretName` pair Kubernetes keeps as two separate facts. Entries now
  read like the store's own documentation — Vercel's `project` and `teamId`, Vault's
  and SSM's `path`, Kubernetes' `secret` and `namespace`, GitHub's `repository` —
  typed by each package's committed declaration, so a field a provider does not
  declare is a compile error rather than a silently ignored key. `type` becomes
  `provider` for the same reason: the value was always a package name.

  **Vercel's `targets` record becomes a singular `target`, defaulting to the
  environment's own name.** A per-environment entry only ever mapped one environment,
  so `targets: { production: "production" }` restated its own key back at itself. A
  `production` environment now needs nothing; a `staging` environment declares
  `target: "preview"`, because Vercel has no staging target and a guess between
  production and preview is a guess about which deployment reads the secret. An
  environment that is neither a Vercel target nor carrying an explicit one is refused
  at construction, naming both remedies.

  **Keys move into the entry they belong to, byte-compatibly.** `keys.<env>` becomes
  `keySource`, and its id defaults to the environment's name — so `keySource: "env"`
  on `production` is exactly the old `{ source: "env", id: "production" }`, seals
  under the same `PENV_KEY_PRODUCTION`, and stamps artifacts with the same
  `env:production` identifier. A config migrated one-for-one produces identical
  artifact bytes. The object form is still there for a rotation that gives the key a
  name of its own. Nothing about key resolution changed: an unrecognised or
  unavailable source still refuses rather than falling back.

  **One migration error teaches the whole move, and there is no compat shim.** A
  config whose `environments` is an array, or that carries a top-level `providers` or
  `keys` key, fails at load with `CONFIG_ENVIRONMENTS_MERGED` before anything else is
  reported, because every other complaint would be a consequence of the same one
  fact. The message names each move — `type` to `provider`, `location` to the field
  the provider declares, `targets` to `target`, `keys.<env>` to `keySource` — and
  prints the old entry beside its rewrite, so the fix is a copy rather than a
  reading. Every remedy string that used to teach the old shape teaches the new one.

  **`penv push --destination` and `--location` are gone.** They let a push land
  somewhere the config never declared, which is a seam of exactly the kind penv
  exists to close, and with provider-specific field names there is no generic slot
  left for a place. A push goes to the provider its environment's entry declares, and
  `NO_DESTINATION` teaches the config edit — the same edit ongoing use needs anyway.

  The provider contract is untouched. Field names are config surface; `capabilities`,
  `holds`, `readsValues`, and the shared contract suite are the same for every
  provider as they were.

### Patch Changes

- Updated dependencies [eb93f50]
  - @penvhq/core@0.15.0
  - @penvhq/cli@0.15.0

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

### Patch Changes

- Updated dependencies [fca6bbb]
  - @penvhq/core@0.14.0
  - @penvhq/cli@0.14.0

## 0.13.0

### Minor Changes

- faf7b71: Committed provider declarations now bind.

  **`penv init` and `penv upgrade` declare `@penvhq/core` as a devDependency.**
  This is the half without which nothing else works. `penv add` commits a
  `declare module "@penvhq/core"` block, and TypeScript resolves that specifier
  from the project's own files — so under pnpm's strict layout, where a transitive
  dependency is not at the project root, the specifier resolves to nothing. An
  augmentation whose module cannot be found is not an error: it silently degrades
  to an _ambient_ declaration, and no diagnostic anywhere says so. It is `dev`
  because that is the whole of what it is — a type-only augmentation target that no
  application code imports, so the one runtime dependency is still one. It joins
  the plan under the same one consent, and a project that already declares it at
  any version is left alone. An upgrade carries it into a project adopted before
  it, which is the migration for every repository holding declarations today.

  **`@penvhq/penv` takes `@penvhq/core` as a real dependency**, so the map it
  holds config against is the one every provider is told to augment. It bundled
  the declaration types, so its `dist/index.d.ts` carried its own inlined copy of
  `interface ProviderConfigMap` and imported nothing from `@penvhq/core`: two
  interfaces shared a name, and the augmentation landed on the one `defineConfig`
  never consulted.

  The last release's claim that a misspelled Vercel target is a compile error was
  false in the published artifact: `targets: { production: "producton" }` compiled
  clean under `--strict`, an undeclared field on a provider entry compiled clean,
  and no diagnostic pointed at the dead augmentation. It is true now.
  `@penvhq/penv`'s declarations import the config types from `@penvhq/core`, and
  core's runtime is external in both outputs rather than a second copy in the
  bundle. Everything else `@penvhq/penv` uses is still bundled in.

  The artifact smoke suite grew the three-way proof that would have caught it
  before publishing: a packed `@penvhq/penv` and `@penvhq/core` installed into a
  scratch project, and `tsc --noEmit --strict` over a `penv.config.ts` plus a
  committed-style declaration — the well-typed config compiles, the typo fails, and
  an undeclared field fails, which is what separates "bound" from "the map is still
  empty".

  **`penv add` no longer advises wiring up a provider the config already names.**
  The unattended line printed _Add `type: "@penvhq/provider-vercel"` to an
  environment in penv.config.ts_ into repositories whose `production` had declared
  exactly that for releases. It now names the environments already pointed and
  advises only about the rest, or says nothing when there is nothing to advise.

### Patch Changes

- Updated dependencies [faf7b71]
  - @penvhq/cli@0.13.0
  - @penvhq/core@0.13.0

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

### Patch Changes

- 5acbbe8: `upgrade` finishes in a workspace, `add` runs unattended when it has nothing to ask, and penv's own releases carry provenance

  `penv upgrade` shelled `pnpm add` without `-w`, which a pnpm workspace root refuses, and then printed that same command as the remedy. The install plan now detects the workspace root, and no failure remediation repeats the command that just failed. It also moved only the root `package.json`: every workspace package declaring `@penvhq/penv` is now in the one consent diff, named line by line, because a package holding its own older copy is an older bridge running under the pin.

  `penv add` refused every unattended run before discovering it had nothing to ask — an `@penvhq/*` add takes no trust decision, so the gate stopped a run that would have been silent. It now refuses only for the trust ceremony, whose one field is a sentence no flag can write, and takes `--yes` to say nobody is here to be asked. Its `penv.config.ts` offer is one question naming every environment it would repoint, not one question per environment.

  penv's own packages shipped with no npm provenance attestation while the official trust tier rests on one: pnpm 11 publishes natively and reads no `npm_config_*`, so the release workflow's `NPM_CONFIG_PROVENANCE` reached nobody, and no published `package.json` carried the `repository` npm's provenance check requires. Both are fixed, the launcher's own publish states `--provenance` outright, and the release verifier warns loudly when the registry records no attestation.

- Updated dependencies [ca2fa13]
- Updated dependencies [5acbbe8]
  - @penvhq/core@0.12.0
  - @penvhq/cli@0.12.0

## 0.11.0

### Minor Changes

- 8786e21: `penv upgrade [version]` moves the engine pin and the runtime dependency together

  Moving the pinned engine used to mean hand-editing `.penv/state/manifest.json` — a version _and_ an 88-character integrity hash fetched from the registry by hand — on the one file whose whole purpose is that its bytes are verified. `penv upgrade` is that edit, made by penv: it resolves the release (no version means `latest`), takes the integrity from the registry's `dist.integrity`, installs the engine into `$PENV_HOME`, and moves the project's `@penvhq/penv` to the same exact version through the detected package manager. Both file changes are shown before either happens and one answer covers both, so a decline leaves the manifest and `package.json` untouched. `--yes` answers in advance; an unattended run needs it _and_ an explicit version. Extensions keep their own pins.

  The engine publishes its dependency-install plan at `@penvhq/cli/install`, so `init` and `upgrade` write that `@penvhq/penv` line through one implementation rather than two.

### Patch Changes

- Updated dependencies [8786e21]
  - @penvhq/cli@0.11.0
  - @penvhq/core@0.11.0

## 0.10.0

### Patch Changes

- 1aa9a87: The engine now reads `$PENV_HOME`, so an extension `penv add` installed is one a command can use.

  `penv add <package>` installed the extension into `$PENV_HOME` and pinned it in the manifest, and the engine then resolved providers only from the project's `node_modules` — so the shipped flow ended at `UNKNOWN_PROVIDER`. An extension is now found in one documented order: the local-extension list, then the project's own `node_modules`, then `$PENV_HOME` at the version the manifest pins. A pinned extension missing from the store refuses naming `penv install`.

  Three refusals that were harder to act on than they had to be:

  - `penv add` imports the package once before it records anything, so a provider whose `exports` point at TypeScript source is refused at add time instead of failing days later from an unrelated command.
  - A provider that resolves and will not import now reports what it threw and the file it tried, rather than discarding both.
  - `penv --help` lists `install` and `add`, and `penv add --help` and `penv install --help` print usage instead of being refused.

- Updated dependencies [1aa9a87]
  - @penvhq/core@0.10.0
  - @penvhq/cli@0.10.0

## 0.9.5

### Patch Changes

- 5815a93: Five things a real 0.9.4 adoption found, and one documentation line that was still wrong.

  `PENV_DELIVERY` was load-bearing for platform delivery and appeared nowhere in the
  documentation. It is the parameter-to-variable map `penv run` writes, and the bridge cannot
  work the names out for itself because `override` bends them — so a project with an `override`
  deploying to a platform that starts the process itself had every value present and heard
  "missing required parameter". The managed-serverless section now sets it out as part of the
  platform setup, with the command that captures the contract from penv rather than by hand.
  The refusal moved with it: a process carrying `PENV_ENV` without `PENV_DELIVERY` is an
  environment something other than `penv run` delivered, and it now names the variable penv
  actually read and asks for the map, instead of recommending a command the platform will
  never run.

  `penv run` left `PENV_HOME` in the application's child. The launcher sets it for the engine,
  the engine's child inherited it, and PRD §4 says penv removes its internal control variables
  before the application starts. It is stripped now. `PENV_ENV`, `PENV_DELIVERY` and `PENV_RUN`
  stay, deliberately — each has a reader downstream — and the documentation says which reader,
  rather than claiming everything internal is taken out. One consequence worth knowing: a penv
  command run from inside an application started by `penv run` resolves `$PENV_HOME` afresh
  rather than inheriting the parent's.

  The refusal an application developer is most likely to meet arrived as a raw Node stack dump,
  because nobody catches it. A `PenvError` now renders itself: its `stack` opens with the
  message and the remedy behind the same arrow every command prints, and carries the caller's
  frames instead of penv's path down to the throw.

  A repository that develops a provider could not use it. Extensions resolved only through
  `penv add`, which needs a published release, so a workspace package named in `penv.config.ts`
  made every command refuse — including development-scope ones. `penv add --local <package>`
  is the path with no release behind it: it resolves the package from the project's own
  `node_modules`, writes the same type-only declaration, and records the name in
  `.penv/state/local-extensions.json` — committed, names only. The manifest is not opened,
  because it pins bytes and a package being written in this checkout has none to pin. Nothing
  about the arrangement is silent: `penv doctor` reports every local extension with the `?`
  verdict, CI refuses one and names `penv add <package>`, and the flags that describe a release
  are refused rather than ignored.

  `penv doctor` reported all green over a tree whose meta declared no secrecy at all.
  Encryption is policy-driven, so with no policy the encryption checks passed vacuously — over
  plaintext values holding real credentials. A parameter whose meta declares secrecy neither
  way is now the `?` verdict, summarized once, naming the meta file that answers it. A project
  that has declared either way for everything stays green.

  The RFC still called the launcher a small executable that only finds an engine. It carries
  one; the same correction the Install section already had.

- Updated dependencies [5815a93]
  - @penvhq/core@0.9.5
  - @penvhq/cli@0.9.5

## 0.9.4

### Patch Changes

- 568866e: Four defects that broke the first-user journey — all four on Windows, two of them everywhere.

  `penv run -- pnpm dev` could not start on Windows at all. pnpm, npm, npx and every
  `node_modules/.bin` tool install an extensionless POSIX shell script beside their `.CMD` shim,
  and executable resolution tried the bare name first: it matched the script, which is not a
  `.cmd`, so the cmd.exe wrapper was skipped and the spawn failed with ENOENT. PATHEXT now leads
  and the bare name goes last. A spawn penv makes on its own behalf also stops borrowing run's
  "check the command after `--`" remedy, which init has no `--` for.

  `penv init` could never finish on a clean project. The `penv.schema.ts` it scaffolds imports
  zod, which is a peerDependency of `@penvhq/penv` that pnpm does not hoist to the project root,
  so loading the draft failed with "Cannot find module 'zod'". zod is now in the install plan
  beside `@penvhq/penv`, both shown in the exact-diff consent. That failure is also reported as
  what it is — the schema never evaluated, so saying the imported values did not satisfy it
  claimed a check penv never ran — and the scaffold is rolled back, so the re-run the refusal
  asks for starts clean instead of on top of a half-adopted project.

  A successful init closed with `penv run -- pnpm dev`, and that exact command refused: nothing
  had installed the pinned engine into `$PENV_HOME`. The launcher now ensures it right after it
  writes the manifest, with one consent line; declined or with nobody at the terminal, it prints
  the `penv install` next step, so the closing message is never a command that does not work.

  The Install section of the documentation claimed the CLI engine lives only in the launcher's
  cache and called the launcher small. The launcher carries a current engine as a dependency, so
  `penv init` works before any project exists; the docs now say that, and say where a project's
  pinned engine and extensions really live.

- Updated dependencies [568866e]
  - @penvhq/cli@0.9.4
  - @penvhq/core@0.9.4

## 0.9.3

### Patch Changes

- cd2d376: The launcher's engine pin is taken from the registry, not predicted. Tarball bytes proved
  non-reproducible across packers and machines — 0.9.1 and 0.9.2 both pinned bytes npm does not
  hold, and the release's own verification refused them. The release now publishes the engine
  first, reads back the integrity npm recorded, and only then builds and publishes the launcher,
  so the pin is true by construction.
- Updated dependencies [cd2d376]
  - @penvhq/cli@0.9.3
  - @penvhq/core@0.9.3

## 0.9.2

### Patch Changes

- 6dce6c4: The 0.9.1 launcher pinned engine bytes npm does not hold — the release rebuilt between packing and
  publishing, and the release's own verification caught it. Pack and publish now share one build:
  the embed step packs the engine, rewrites the pin, rebuilds only the launcher, and publish uploads
  the dist it packed.
- Updated dependencies [6dce6c4]
  - @penvhq/cli@0.9.2
  - @penvhq/core@0.9.2

## 0.9.1

### Patch Changes

- c19b3d6: The launcher's download path works against what npm actually serves. The engine's bin now builds
  as one self-contained file, so the tarball the launcher extracts into `$PENV_HOME` runs with no
  `node_modules` — with `@napi-rs/keyring` staying native and the keychain key source refusing by
  name when it is absent. And a published launcher now carries a real engine pin: the release embeds
  `@penvhq/cli`'s tarball integrity before publishing and verifies it against the registry after, so
  `penv init` can write a manifest that `penv install` can actually satisfy.
- Updated dependencies [c19b3d6]
  - @penvhq/cli@0.9.1
  - @penvhq/core@0.9.1

## 0.9.0

### Minor Changes

- aa70ff0: **New:** adopting a project now leaves the manifest that makes it a project.

  After `penv init` or `penv migrate` succeeds in a directory that has none, the launcher writes `.penv/state/manifest.json` pinning the exact engine that just ran — its version and the npm integrity of its tarball, which the launcher carries from release time because adoption never touches the network. Extensions start empty; `penv add` fills them in. A manifest that is already there is never rewritten, and a command that failed, or that only previewed, leaves nothing behind.

  `penv migrate` now runs outside a project, which is where a project on the old layout is: the manifest is the marker, and that is the file it did not have yet.

- ba3029e: **New:** `penv` is a launcher, and the engine it runs is the one your project pins.

  Install it once — `npm install -g penv` — and it stays put. Inside a project it reads `.penv/state/manifest.json`, finds that exact engine and those exact extensions in `$PENV_HOME` (`~/.penv` unless you move it), checks them against the integrity the manifest records, and hands your command to them with the arguments, streams, exit code and signals untouched. Outside a project it runs `init` on the engine it shipped with. There is one version to read: `penv --version` prints the pinned engine inside a project and the bundled one outside.

  Missing bytes are a refusal, not a surprise download. In CI, in production, or under `--no-download`, penv names `penv install` — the preinstall step that materializes exactly what the manifest pins — and stops. At an interactive terminal it offers to download once, from the registry the manifest records, and verifies the tarball before a single file is written.

  `@penvhq/cli` now publishes a `penv-engine` bin, which is what the launcher spawns.

### Patch Changes

- Updated dependencies [7ad42ba]
- Updated dependencies [d36fbf4]
- Updated dependencies [0a1601d]
- Updated dependencies [6917016]
- Updated dependencies [ba3029e]
  - @penvhq/core@0.9.0
  - @penvhq/cli@0.9.0
