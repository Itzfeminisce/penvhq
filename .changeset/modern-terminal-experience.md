---
"@penvhq/cli": minor
---

A modern terminal experience across every command, and `penv fill` learns about optional parameters.

`fill` now asks for `.optional()` and `.default()` parameters too, after the required gaps, tagged `optional` with the schema's default shown when penv can read it — `? log-level · production · optional, Enter keeps "info" ›`. An answer writes an override through `penv set` as ever; Enter keeps what the schema declared, reported as "left to the schema's defaults" rather than skipped. Piped input no longer loses answers that arrive before the first prompt (`printf 'value\n' | penv fill` used to crash with `ERR_USE_AFTER_CLOSE`): early lines are buffered in order, and end-of-input cleanly skips whatever was not answered.

 Verdicts are colored at the glyph — green ✓ pass, yellow ⚠ warning, red ✗ failure, dim ? could-not-look — details and asides read dimmed, and every remedy is a cyan-arrowed tip in one shape the whole CLI shares. `doctor` and `validate` close with a counted, colored summary line; `list` gains column headers, a colored scope column, and an `encrypted` marker; `get --explain` highlights the winning file and dims the losers; interactive prompts (`fill`, `init`) wear one styled `?` shape. Errors print a red ✗ with the remedy as a tip. Color honors `NO_COLOR` and `FORCE_COLOR` and switches off automatically when output is piped, so scripts, CI logs, and tests see the exact plain bytes they always did.
