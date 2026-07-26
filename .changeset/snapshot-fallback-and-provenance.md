---
"@penvhq/core": minor
"@penvhq/runtime": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
"@penvhq/provider-mock": minor
"@penvhq/provider-kubernetes": minor
---

`load()` no longer throws when it finds a `penv.config.ts` with no `.penv/` tree beside it.

A serverless bundle that traced the config in — but not the tree, because nothing imports it — took the filesystem branch and failed, while the embedded snapshot that would have resolved perfectly was never consulted. A config with no tree is a bundling artifact rather than a project, so `load()` now resolves from the snapshot there, warning on stderr as it does.

Disk still comes first and the fallback is deliberately narrow. The tree check runs *before* the config is evaluated, so a broken config in a real project stays fatal: a syntax error, a missing default export, or an import that does not resolve all still fail the load rather than booting the app on committed snapshot values. Everything downstream is your data and is never fallen back from either — an undecryptable value, an undeclared environment, and an incomplete tree all still throw.

Also in this release:

- `load(schema, { source })` pins the read source: `"auto"` (default), `"disk"`, or `"snapshot"`. Each refuses the other rather than quietly resolving from it.
- The config search is bounded at the workspace root, so an unrelated `penv.config.ts` a layer above a container's `/var/task` is never picked up. A config just outside the boundary is named rather than skipped in silence.
- Snapshots carry a digest of the config and sealed values they project. `penv snapshot --check` recomputes it for CI (non-zero when stale), and `load()` warns when it holds a config file and a snapshot that no longer agree.
- **Fixed:** a parameter named `constructor`, `toString`, or `valueOf` resolved to a member of `Object.prototype` instead of to nothing, failing validation with `expected string, received function`. Every record penv indexes by a user-chosen name now looks the key up as an own property; the same fix covers the snapshot provider, the mock provider, the Kubernetes transport, and config, key, and meta resolution.
- `PENV_DEBUG=1` prints how a load resolved — environment, source and path, and the winning value file for every parameter — and `ValidationError` names the source it read.
- `jiti` is no longer in the runtime's static import graph. The config-file loader requires it at first use, so a bundle that resolves from a snapshot no longer carries a TypeScript loader it never invokes.

Upgrading: an existing `penv.snapshot.ts` carries no digest, so `penv doctor` reports it as stale until you run `penv snapshot` once. It still loads in the meantime — a snapshot without a digest is unverifiable, which is what the missing digest reports, not stale.
