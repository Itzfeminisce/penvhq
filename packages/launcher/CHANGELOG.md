# penv

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
