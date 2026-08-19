# penv

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
