---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/provider-github": minor
"@penvhq/penv": minor
---

Everything is a provider (v0.7, part two — breaking): sinks are unified into providers, and push/pull work against every store.

- The `sinks` config key is removed; a config still carrying one is refused with the exact rewrite. `@penvhq/sink-github` is now `@penvhq/provider-github`, declared like any provider: `providers: { production: { type: "@penvhq/provider-github", location: "acme/api" } }`.
- What a store can do is a declared capability on the contract, not a separate concept: `holds: "records" | "projection"` and `readsValues`. Vault/SSM/Kubernetes/filesystem are unchanged record-holders and still pass the same contract suite; GitHub declares a projection that withholds values and satisfies the new `ProjectionProvider` contract.
- `penv push` targets the environment's declared provider: a record-holder receives the tree mirrored verbatim (sealed values cross byte-for-byte, no key needed); a projection-holder receives the resolved projection exactly as before (`.local` skipped, names judged first, all or nothing, `--allow-decrypt` for sealed values). `--destination`/`--dest`/`-d` with `--location`/`-l` pushes once to a provider the config does not name, persisting nothing.
- A missing destination environment is created on approval: the push prompts, `--yes` pre-approves for CI, and a refusal names the remedy (`MISSING_TARGET`).
- `penv pull` from a value-withholding provider materialises what the store honestly has — secret names as flat parameters with meta stubs, values left absent — and `penv validate` names every gap. Pull names, fill values, push anywhere: that loop is the migration path between stores.
- `penv doctor`'s sink checks are now capability-driven (`projection-*` findings): names exact, hand-edits caught by timestamp, values permanently `unknown` — against the environment's provider, no second config key.
- Whitelisted environments work as bare flags: `penv pull --production`. Real flags always win (`doctor` warns when an environment name shadows one), two environment flags are a hard error, and `--env` stays canonical.
