---
"@penvhq/launcher": minor
"@penvhq/cli": minor
"@penvhq/core": minor
---

`penv upgrade [version]` moves the engine pin and the runtime dependency together

Moving the pinned engine used to mean hand-editing `.penv/state/manifest.json` — a version *and* an 88-character integrity hash fetched from the registry by hand — on the one file whose whole purpose is that its bytes are verified. `penv upgrade` is that edit, made by penv: it resolves the release (no version means `latest`), takes the integrity from the registry's `dist.integrity`, installs the engine into `$PENV_HOME`, and moves the project's `@penvhq/penv` to the same exact version through the detected package manager. Both file changes are shown before either happens and one answer covers both, so a decline leaves the manifest and `package.json` untouched. `--yes` answers in advance; an unattended run needs it *and* an explicit version. Extensions keep their own pins.

The engine publishes its dependency-install plan at `@penvhq/cli/install`, so `init` and `upgrade` write that `@penvhq/penv` line through one implementation rather than two.
