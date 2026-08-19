---
"@penvhq/provider-vercel": minor
---

Push penv parameters straight into a Vercel project's environment-variable store.

`@penvhq/provider-vercel` is a projection-holding destination: `penv push --production` resolves your tree the way a deploy would read it and writes each variable into the project over Vercel's REST API, so a production cutover is one command instead of a settings form.

Which Vercel target an environment deploys to is declared, never guessed — `targets: { production: "production", staging: "preview" }` — and an environment with no entry is refused by name before penv opens a connection. Your environment scope lands on that one target; the unscoped default covers all three, which is the breadth Vercel actually has. A parameter that would be one target's own value *and* the shared default at once has no representation in a store with no override axis, so penv refuses that push and names the collision rather than silently picking a meaning.

The access token arrives as the ambient `VERCEL_TOKEN` the package declares in `penv.credentials` — never a config field, never in the manifest — and `penv run` strips it before your application starts.
