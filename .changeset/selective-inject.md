---
"@penvhq/runtime": minor
"@penvhq/penv": minor
---

`load(schema, { inject })` now accepts an allowlist as well as a boolean. Pass an
array of parameter ids to inject only those into `process.env`, leaving every
other declared parameter untouched — never written, never deleted. Use it when
the schema also holds secrets that must not reach `process.env` (database URLs,
cloud credentials), while a subset (WorkOS keys, a public redirect) must:

```ts
export const env = load(schema, {
  inject: ["workos/api-key", "workos/client-id", "workos/redirect-uri"],
});
```

The allowlist is typed to the schema's own parameter ids at the `load` call
site — the ids autocomplete and a typo is a compile error. `inject: true` still
injects the whole schema. Off by default.
