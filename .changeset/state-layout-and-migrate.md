---
"@penvhq/core": minor
"@penvhq/runtime": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

**Breaking:** the parameter tree moves to `.penv/state/records/`, and penv reads only that layout.

`.penv/state/` is where penv keeps what it manages — the records, the committed `.gitignore` that draws the safety boundary, and the manifest and extension declarations that follow. `.penv/env.ts` stays yours, at the same path. Records keep their names, so the filename grammar, the cascade, meta and the AAD that binds a ciphertext to its address are all unchanged.

Run `penv migrate` to convert an existing project: it previews the move, converts on approval, and leaves `penv.schema.ts`, `penv.config.ts` and `.penv/env.ts` byte-identical. Running it twice is a no-op that says so. Until you run it, every command — and `load()` — refuses by name rather than reading an empty tree.

`ProviderFactoryContext.root` is now the project root rather than the `.penv/` directory, so a provider package that derives paths from it should re-derive them.
