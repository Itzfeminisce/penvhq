---
"@penvhq/core": minor
"@penvhq/runtime": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

`penv run -- <command>` is how an adopted project starts.

It resolves the parameter tree, checks it against your schema, builds a child environment penv owns, and starts the exact command after `--` — argument boundaries, pipes, `pre*`/`post*` hooks, exit code and signals all stay the child's. `--source` defaults to `project`, so the daily command is `penv run -- pnpm dev`; `snapshot` names the sealed artifact and is always spelled out. A run contacts no provider: what is already materialised locally is the whole input, and `--watch` is the one opt-in mode allowed to sync, where a failed pull or a failed check leaves the running child exactly where it was.

The child environment is penv's: every schema-declared parameter is written under its generated name, or deleted when the schema excuses it and nothing resolved, so a stale export cannot stand in for a value penv resolved to nothing. Unrelated variables are untouched; penv's keys, the declared providers' credentials, and its own control variables never reach the child. An outer `penv run` meeting an in-script one is refused, naming both.

`penv.config.ts` takes a new `defaultEnvironment`, checked against the environment whitelist, that `run`, `pull`, `push`, `set` and every other environment-taking command fall back to when `--env` is absent. It is a declared decision, never inference — CI still names `--env`. With neither the flag nor the key, the refusal names both.

Two refusals are new, and both name one next command: an application started outside `penv run` is told the missing parameter and the `penv run --` line to start it with, and an environment whose provider holds values nothing has pulled yet is told `Run: penv pull`.
