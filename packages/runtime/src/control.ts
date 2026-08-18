/**
 * penv's own names in the environment, and the one rule that keeps a delivered
 * variable from being one of them.
 *
 * They live here rather than beside the assembly that stamps them because both
 * halves need them and neither may import the other: `inject` writes the
 * delivered names, `childEnvironment` stamps the control names one line later,
 * and the check that they never overlap has to run before either.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { checkNameCollisions, PenvError, SCHEMA_HARVEST_ENV, variableName } from "@penvhq/core";

/**
 * The variable a `penv run` leaves in its child so a nested `penv run` can see
 * it. Its value is the outer invocation, which is what makes the nested refusal
 * able to name both.
 *
 * It is penv talking to penv. The application never reads it — the bridge takes
 * it out of `process.env` on the first `load` (see `consumeDelivery`), while a
 * nested penv, which never loads a schema before checking, still finds it.
 */
export const RUN_MARKER = "PENV_RUN";

/** The environment `run` pins for the child, so the bridge reads what penv resolved. */
export const ENVIRONMENT_VARIABLE = "PENV_ENV";

/**
 * The delivery contract this run wrote: parameter id → the variable it was
 * written under, as JSON.
 *
 * Names only, never values — it is the one thing the application's bridge cannot
 * work out for itself. The bridge validates the *injected* environment, so it
 * must know which variable each schema parameter arrived in, and an `override`
 * in `penv.config.ts` makes that unguessable. A container running from an
 * artifact has no config to read, so the map travels with the environment
 * instead. Like {@link RUN_MARKER}, it is penv talking to penv and the bridge
 * takes it back out of `process.env` on the first `load`.
 */
export const DELIVERY_VARIABLE = "PENV_DELIVERY";

/** Where a `--source snapshot` run reads its artifact from. Read once, in the parent. */
export const SNAPSHOT_VARIABLE = "PENV_SNAPSHOT";

/**
 * penv's internal channels. They are penv's business with itself, and an
 * application that inherited one would be reading a message addressed to
 * somewhere else — `PENV_SNAPSHOT` above all, whose whole point is that the
 * artifact is opened once, in the parent, and never again.
 */
export const CONTROL_VARIABLES = [
  RUN_MARKER,
  DELIVERY_VARIABLE,
  SCHEMA_HARVEST_ENV,
  SNAPSHOT_VARIABLE,
] as const;

/**
 * Every name penv keeps for itself, control channels plus the environment it
 * pins. `PENV_ENV` is not stripped — the bridge is meant to read it — but it is
 * still penv's to write, so a parameter may not be delivered under it either.
 */
const RESERVED_VARIABLES: readonly string[] = [...CONTROL_VARIABLES, ENVIRONMENT_VARIABLE];

/**
 * The two rules a set of delivery names satisfies before anything is written.
 *
 * Both refuse *before* delivery rather than after, and for the same reason: what
 * they prevent is silent. Two parameters under one variable deliver last-wins
 * and drop the other; a parameter under one of penv's own names is written by
 * the injection and overwritten by the control stamp one line later, while the
 * delivery contract still claims it arrived. Every path that decides delivery
 * names — `penv run`, `load({ inject })`, `penv artifact build` — calls this one
 * function, because two implementations of "these names are deliverable" would
 * eventually disagree about one of them.
 */
export function assertDeliverableNames(refs: readonly ParameterRef[], config: PenvConfig): void {
  const collision = checkNameCollisions(refs, config)[0];
  if (collision !== undefined) {
    throw collision;
  }
  for (const ref of refs) {
    const variable = variableName(ref, config);
    if (RESERVED_VARIABLES.includes(variable)) {
      throw reservedName([...ref.namespace, ref.name].join("/"), variable);
    }
  }
}

function reservedName(parameter: string, variable: string): PenvError {
  return new PenvError(
    "DELIVERY_NAME_RESERVED",
    `${parameter} maps to ${variable}, which is penv's own channel rather than a variable it can deliver`,
    `Rename the parameter, or point it somewhere else with \`override\` in penv.config.ts — ${RESERVED_VARIABLES.join(", ")} are how penv talks to itself.`,
  );
}
