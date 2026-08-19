---
"@penvhq/launcher": patch
"@penvhq/runtime": patch
"@penvhq/core": patch
"@penvhq/cli": patch
---

Five things a real 0.9.4 adoption found, and one documentation line that was still wrong.

`PENV_DELIVERY` was load-bearing for platform delivery and appeared nowhere in the
documentation. It is the parameter-to-variable map `penv run` writes, and the bridge cannot
work the names out for itself because `override` bends them — so a project with an `override`
deploying to a platform that starts the process itself had every value present and heard
"missing required parameter". The managed-serverless section now sets it out as part of the
platform setup, with the command that captures the contract from penv rather than by hand.
The refusal moved with it: a process carrying `PENV_ENV` without `PENV_DELIVERY` is an
environment something other than `penv run` delivered, and it now names the variable penv
actually read and asks for the map, instead of recommending a command the platform will
never run.

`penv run` left `PENV_HOME` in the application's child. The launcher sets it for the engine,
the engine's child inherited it, and PRD §4 says penv removes its internal control variables
before the application starts. It is stripped now. `PENV_ENV`, `PENV_DELIVERY` and `PENV_RUN`
stay, deliberately — each has a reader downstream — and the documentation says which reader,
rather than claiming everything internal is taken out. One consequence worth knowing: a penv
command run from inside an application started by `penv run` resolves `$PENV_HOME` afresh
rather than inheriting the parent's.

The refusal an application developer is most likely to meet arrived as a raw Node stack dump,
because nobody catches it. A `PenvError` now renders itself: its `stack` opens with the
message and the remedy behind the same arrow every command prints, and carries the caller's
frames instead of penv's path down to the throw.

A repository that develops a provider could not use it. Extensions resolved only through
`penv add`, which needs a published release, so a workspace package named in `penv.config.ts`
made every command refuse — including development-scope ones. `penv add --local <package>`
is the path with no release behind it: it resolves the package from the project's own
`node_modules`, writes the same type-only declaration, and records the name in
`.penv/state/local-extensions.json` — committed, names only. The manifest is not opened,
because it pins bytes and a package being written in this checkout has none to pin. Nothing
about the arrangement is silent: `penv doctor` reports every local extension with the `?`
verdict, CI refuses one and names `penv add <package>`, and the flags that describe a release
are refused rather than ignored.

`penv doctor` reported all green over a tree whose meta declared no secrecy at all.
Encryption is policy-driven, so with no policy the encryption checks passed vacuously — over
plaintext values holding real credentials. A parameter whose meta declares secrecy neither
way is now the `?` verdict, summarized once, naming the meta file that answers it. A project
that has declared either way for everything stays green.

The RFC still called the launcher a small executable that only finds an engine. It carries
one; the same correction the Install section already had.
