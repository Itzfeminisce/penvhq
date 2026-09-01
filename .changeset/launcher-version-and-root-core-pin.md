---
"@penvhq/launcher": patch
"@penvhq/cli": patch
---

**`penv --version` now names a launcher that is behind the pin, and `penv install` holds the project's own `@penvhq/core` to it.** Two things a real 0.15.0 adoption found, both of which let a stale version sit unnoticed.

`add` and `upgrade` run from the launcher rather than the pinned engine, but `--version` answered with the engine alone — so a launcher three releases old printed the pin's number and quietly ran old code for both commands, down to advising a config field the release had retired. It says so now, with the command that moves it, and stays quiet for a launcher *ahead* of the pin: running a project's older pinned engine is the whole model, not a problem.

`planInstall` treated any declared `@penvhq/core` at the project root as satisfied, however old, while holding every workspace member's copy to the pin exactly. A root left behind checks `penv.config.ts` against a shape the engine no longer has, and the committed provider declarations augment interfaces that moved under them — so the root is held to the pin now, like its members always were.
