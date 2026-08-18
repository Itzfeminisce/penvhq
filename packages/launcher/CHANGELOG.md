# penv

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
