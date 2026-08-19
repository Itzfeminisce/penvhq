---
"@penvhq/core": patch
"@penvhq/cli": patch
"@penvhq/launcher": patch
---

The engine now reads `$PENV_HOME`, so an extension `penv add` installed is one a command can use.

`penv add <package>` installed the extension into `$PENV_HOME` and pinned it in the manifest, and the engine then resolved providers only from the project's `node_modules` — so the shipped flow ended at `UNKNOWN_PROVIDER`. An extension is now found in one documented order: the local-extension list, then the project's own `node_modules`, then `$PENV_HOME` at the version the manifest pins. A pinned extension missing from the store refuses naming `penv install`.

Three refusals that were harder to act on than they had to be:

- `penv add` imports the package once before it records anything, so a provider whose `exports` point at TypeScript source is refused at add time instead of failing days later from an unrelated command.
- A provider that resolves and will not import now reports what it threw and the file it tried, rather than discarding both.
- `penv --help` lists `install` and `add`, and `penv add --help` and `penv install --help` print usage instead of being refused.
