/**
 * The `import "penv/config"` compatibility entry: populates `process.env`,
 * dotenv-shaped, so penv can be adopted without changing existing code.
 *
 * ESM ordering caveat: this module must run before any module that reads
 * `process.env`. ES imports are hoisted and evaluated before the importing
 * module's body, but sibling imports evaluate in source order — so a module
 * imported above this one, and reading `process.env` at its top level, reads it
 * before penv has populated it. This is the same hazard `dotenv/config` carries.
 * The typed `import { env } from "@env"` surface has no ordering hazard and is
 * the recommended path.
 */

import { checkNameCollisions, variableName } from "@penv/core";
import { resolveSync } from "./resolve.js";

const { config, values } = resolveSync(process.cwd());

// Invariant 12, enforced where the loss would happen: two parameters mapping to
// one variable would otherwise resolve first-write-wins, dropping the second
// silently. That is the same sin as last-write-wins, so throw before touching
// process.env — a half-populated environment is worse than none.
const collision = checkNameCollisions(
  values.map(({ ref }) => ref),
  config,
)[0];
if (collision !== undefined) {
  throw collision;
}

for (const { ref, value } of values) {
  const variable = variableName(ref, config);
  // dotenv semantics: an already-set variable is the caller's deliberate
  // override and is never clobbered.
  if (process.env[variable] === undefined) {
    process.env[variable] = value;
  }
}
