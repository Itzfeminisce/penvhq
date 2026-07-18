---
"@penvhq/cli": minor
---

Add `penv fill` and guard the write path against non-canonical parameter keys.

`penv fill` prompts for each declared parameter the tree has no value for, deriving the value-file name from the schema so you never translate a camelCase schema key to its kebab file yourself. On the write path, `penv set` and the `penv mv` destination now refuse a non-canonical key and point you at the canonical lower-case hyphenated name.
