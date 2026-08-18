---
"@penvhq/launcher": patch
"@penvhq/cli": patch
---

Four defects that broke the first-user journey — all four on Windows, two of them everywhere.

`penv run -- pnpm dev` could not start on Windows at all. pnpm, npm, npx and every
`node_modules/.bin` tool install an extensionless POSIX shell script beside their `.CMD` shim,
and executable resolution tried the bare name first: it matched the script, which is not a
`.cmd`, so the cmd.exe wrapper was skipped and the spawn failed with ENOENT. PATHEXT now leads
and the bare name goes last. A spawn penv makes on its own behalf also stops borrowing run's
"check the command after `--`" remedy, which init has no `--` for.

`penv init` could never finish on a clean project. The `penv.schema.ts` it scaffolds imports
zod, which is a peerDependency of `@penvhq/penv` that pnpm does not hoist to the project root,
so loading the draft failed with "Cannot find module 'zod'". zod is now in the install plan
beside `@penvhq/penv`, both shown in the exact-diff consent. That failure is also reported as
what it is — the schema never evaluated, so saying the imported values did not satisfy it
claimed a check penv never ran — and the scaffold is rolled back, so the re-run the refusal
asks for starts clean instead of on top of a half-adopted project.

A successful init closed with `penv run -- pnpm dev`, and that exact command refused: nothing
had installed the pinned engine into `$PENV_HOME`. The launcher now ensures it right after it
writes the manifest, with one consent line; declined or with nobody at the terminal, it prints
the `penv install` next step, so the closing message is never a command that does not work.

The Install section of the documentation claimed the CLI engine lives only in the launcher's
cache and called the launcher small. The launcher carries a current engine as a dependency, so
`penv init` works before any project exists; the docs now say that, and say where a project's
pinned engine and extensions really live.
