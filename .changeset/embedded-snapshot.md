---
"@penvhq/core": minor
"@penvhq/runtime": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

Add a committed `penv.snapshot.ts` so `load()` resolves in a bundled or serverless runtime.

A compiled bundle — a Next.js middleware chunk, a Vercel `/var/task` function — has no `penv.config.ts` and no `.penv/` tree to walk to, so `load()` threw `No penv.config.ts found…`. `penv snapshot` now generates a committed data module at the project root that embeds the evaluated config and every committed sealed (`.enc`) value, and wires your `env.ts` to pass it to `load()`. On disk, file discovery still comes first and a live edit wins; only in a bundle does `load()` fall back to the snapshot, decrypting under the same `PENV_KEY_*`.

The snapshot embeds sealed records only — never plaintext, at any scope, nor `.local` values — so the committed ciphertext in `penv.snapshot.ts` is the same ciphertext a git clone already carries (the `.enc` value files are gitignored, so the snapshot is where a bundle reads them). `penv doctor snapshot-stale` guards the pair, and the mutating commands refresh it automatically. `penv doctor bundle-invisible-plaintext` flags a team-scope plaintext value a bundle cannot see: seal it to ship it. New projects scaffold the snapshot and a pre-wired `env.ts` from `penv init`.
