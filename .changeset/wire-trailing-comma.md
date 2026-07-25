---
"@penvhq/cli": patch
"@penvhq/penv": patch
---

`penv snapshot` no longer writes a double comma when wiring an `env.ts` whose `load` options end with a trailing comma (a multi-line `inject` list). The trailing comma is stripped before `snapshot` is appended.
