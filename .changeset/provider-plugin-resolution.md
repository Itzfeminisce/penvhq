---
"@penvhq/core": minor
"@penvhq/cli": minor
---

Resolve an unregistered `providers.*.type` as a convention-loaded provider plugin.

A `type` with no built-in entry (`filesystem`, `vault`, `mock`) is now loaded from the package `@penvhq/provider-<type>` — or the package a new optional `providers.*.module` field names — and validated against the `Provider` contract before it is trusted. This is the same shape ESLint uses for `eslint-plugin-<name>`: penv stays generic, and a private or third-party backend plugs in by being installed, with no change to penv itself.

The open-time guarantee is unchanged. A provider that is neither built in nor installed still fails at `openProject`, now with an `npm i @penvhq/provider-<type>` hint. The check is a synchronous package-resolution probe that runs no plugin code, so `openProject` stays synchronous; the plugin's module is imported only when an environment's source of truth is actually built (`penv pull`, cross-provider `doctor`, `rotate`). The built-in providers and the static registry are untouched.
