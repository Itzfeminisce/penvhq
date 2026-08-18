/**
 * Turning dotenv variables into penv records — the checks that must pass before
 * a single value file is written, and the write itself.
 *
 * Two commands adopt: `penv import` takes one file, `penv init` takes a whole
 * cascade in one all-or-nothing cutover. They share this module because the two
 * names that fail here fail *destructively* — a reserved name bricks every later
 * command, and a lossy name renames the user's variable behind their back — and
 * two implementations of "is this variable adoptable" would eventually let one
 * command write what the other refuses.
 *
 * Import creates flat parameters. `refFromVariable` never infers a namespace,
 * because a flat `.env` carries no structure to read: `REDIS_PASSWORD` cannot say
 * whether it came from `redis/password` or `redis-password`. Namespacing is a
 * deliberate refactor afterwards, not a guess made during adoption.
 */

import type { DotenvEntry, Meta, ParameterRef, PenvConfig, Scope } from "@penvhq/core";
import {
  checkNameCollisions,
  isReservedToken,
  PenvError,
  ReservedTokenError,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "@penvhq/core";
import type { FilesystemProvider } from "@penvhq/provider-filesystem";

/**
 * Filenames are split on `.`, so a variable that becomes a dotted name would
 * parse back as a scope segment rather than the parameter it came from.
 */
function assertImportable(ref: ParameterRef, variable: string): void {
  if (!ref.name.includes(".")) {
    return;
  }
  throw new PenvError(
    "IMPORT_UNPARSEABLE_NAME",
    `The variable ${variable} becomes the parameter \`${ref.name}\`, whose \`.\` would be read as a scope`,
    `Filenames are split on \`.\`. Rename ${variable} in the source file, then import it again.`,
  );
}

/**
 * Invariant 11: `enc`, `json`, `toml`, `yml`, `local`, and every declared
 * environment are reserved, and a collision is an error rather than a warning.
 *
 * A written `.penv/state/records/enc` does not merely import badly — it re-parses as a scope
 * segment, so every later `list()` throws and `get`, `generate`, `validate`, and
 * even `remove` stop working. The project can only be repaired by deleting the
 * file by hand, which is why this runs before anything is written rather than
 * leaving `penv validate` to report the wreckage afterwards.
 *
 * The error names the *variable*, not the parameter: the user is reading their
 * `.env`, where the line says `ENC=`, and `enc` is penv's word for it.
 */
function assertNotReserved(
  ref: ParameterRef,
  variable: string,
  where: string,
  config: PenvConfig,
): void {
  if (isReservedToken(ref.name, config)) {
    throw new ReservedTokenError("parameter", variable, where);
  }
}

/**
 * The v0.1 gate: every variable survives `import` then `generate` unchanged,
 * *modulo declared name overrides*.
 *
 * `MY-VAR` imports to the parameter `my-var` and regenerates as `MY_VAR`, so the
 * application's `process.env["MY-VAR"]` reads `undefined` after a round trip. A
 * flat `.env` cannot tell `MY-VAR` from `MY_VAR` once both collapse to one
 * parameter, so no escape scheme rescues it — the honest move is to refuse. An
 * explicit `override` entry is the exception the gate allows: it makes the
 * generated name a stated decision instead of an accident. Silence does not.
 */
function assertRoundTrips(ref: ParameterRef, variable: string, config: PenvConfig): void {
  if (roundTripsCleanly(variable)) {
    return;
  }
  // The declared override the gate's "modulo" clause means. Checked against the
  // real transform, so an override that does not actually restore the variable
  // is not mistaken for one that does.
  if (variableName(ref, config) === variable) {
    return;
  }
  const generated = variableName(ref, config);
  throw new PenvError(
    "IMPORT_LOSSY_NAME",
    `The variable ${variable} becomes the parameter \`${ref.name}\`, which regenerates as ${generated}`,
    `\`penv generate\` would write ${generated}, so anything reading ` +
      `\`process.env["${variable}"]\` would read \`undefined\`. Declare the name you want in the ` +
      `\`override\` block of penv.config.ts — \`override: { "${ref.name}": "${variable}" }\` — then ` +
      `import it again. Nothing was imported.`,
  );
}

/**
 * Every entry's parameter, with every name check already passed — or the first
 * refusal, thrown before anything is written. `where` is the source as the user
 * typed it, because that is the file they will go and edit.
 */
export function refsForEntries(
  entries: readonly DotenvEntry[],
  where: string,
  config: PenvConfig,
): ParameterRef[] {
  const refs: ParameterRef[] = [];
  for (const entry of entries) {
    const ref = refFromVariable(entry.key);
    assertImportable(ref, entry.key);
    assertNotReserved(ref, entry.key, where, config);
    assertRoundTrips(ref, entry.key, config);
    refs.push(ref);
  }
  return refs;
}

/** Invariant 12: two parameters mapping to one variable is an error, never last-write-wins. */
export function assertNoCollisions(refs: readonly ParameterRef[], config: PenvConfig): void {
  const first = checkNameCollisions(refs, config)[0];
  if (first !== undefined) {
    throw first;
  }
}

/**
 * Writes one file's variables into the tree at `scope`, with each attached
 * comment becoming that parameter's meta description so `penv generate` can
 * re-emit it.
 */
export function writeEntries(
  tree: FilesystemProvider,
  entries: readonly DotenvEntry[],
  refs: readonly ParameterRef[],
  scope: Scope,
): void {
  for (const [index, entry] of entries.entries()) {
    const ref = refs[index];
    if (ref === undefined) {
      continue;
    }
    tree.writeSync(
      { namespace: ref.namespace, name: ref.name, scope, encrypted: false },
      entry.value,
    );
    if (entry.description !== undefined) {
      const meta: Meta = { ...tree.readMetaSync(ref), description: entry.description };
      tree.writeMetaSync(ref, meta);
    }
  }
}
