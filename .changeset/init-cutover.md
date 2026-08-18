---
"@penvhq/core": minor
"@penvhq/cli": minor
"@penvhq/penv": minor
---

`penv init` is a complete dotenv cutover.

It lists the dotenv files it found, preselects the development cascade, and adopts the ones you choose — all of them or none. Selecting an environment-scoped file is what declares that environment; `.env` alone declares nothing, so init asks which environment those values are for rather than inventing one. The draft schema it writes is the weakest shape every adopted environment satisfies: a field all of them carry starts required, a field missing from any starts optional, and requiredness is never inferred per environment. When the development cascade is adopted, `defaultEnvironment: "development"` is written down, so the daily command is `penv run -- pnpm dev`.

Everything is preflighted before anything moves: the selection, the environments it declares, every framework-discoverable file in those cascades, every variable name, the generated variable each maps to, the draft, and the dependency install. A failed preflight changes nothing and never claims a partial migration. The runtime dependency is installed at the engine's exact version with the project's own package manager, and only after the exact `package.json` and lockfile change is shown; a declined or failed install performs no cutover. init then imports, validates every adopted environment, and only then moves the prior dotenv files into one ignored bundle under `.penv/state/rollback/dotenv/`, recorded in `.penv/state/cutover.json`.

`penv init undo` restores those files under their exact names. `penv cleanup` is the new command that closes the migration, removing the bundle and its cutover state and nothing else. A second migration refuses while a bundle is unresolved. After a cutover, `penv run` refuses a framework-active `.env`, `.env.local`, `.env.<environment>` or `.env.<environment>.local` that reappears, so a later edit cannot quietly recreate a second source of configuration; `.env.example` and its documentation siblings are excluded.

init never edits `package.json` scripts — it ends by showing the `penv run --` line to type — and it creates no keys, seals nothing, builds no artifact and authenticates with no provider.

`@penvhq/penv` no longer declares a `penv` bin. It is the typed runtime surface an adopted project depends on; the global `penv` is the launcher's.
