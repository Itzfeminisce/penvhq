---
"@penvhq/cli": patch
"@penvhq/launcher": patch
---

The launcher's download path works against what npm actually serves. The engine's bin now builds
as one self-contained file, so the tarball the launcher extracts into `$PENV_HOME` runs with no
`node_modules` — with `@napi-rs/keyring` staying native and the keychain key source refusing by
name when it is absent. And a published launcher now carries a real engine pin: the release embeds
`@penvhq/cli`'s tarball integrity before publishing and verifies it against the registry after, so
`penv init` can write a manifest that `penv install` can actually satisfy.
