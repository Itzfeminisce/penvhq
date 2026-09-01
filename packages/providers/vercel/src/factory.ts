/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The factory reads the entry's Vercel-named fields and
 * resolves the one target this environment lands on, so the provider never
 * parses config and the config never learns anything but Vercel's own words.
 */

import type { ProjectionProvider, ProviderFactoryContext } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { createVercelProvider, resolveTarget } from "./vercel.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the Vercel provider for one environment's declared destination. */
export function penvProviderFactory(context: ProviderFactoryContext): ProjectionProvider {
  const environment = context.environment;
  const project = context.providerConfig?.["project"];
  // Core cannot know a provider's required fields, so the entry that names no
  // project — object form or the expanded string shorthand — is refused here.
  if (typeof project !== "string" || project.trim() === "") {
    throw new PenvError(
      "VERCEL_PROJECT_MISSING",
      environment === undefined
        ? "The Vercel provider entry names no `project` to write to"
        : `Environment ${environment} names no \`project\` for the Vercel provider`,
      "Set `project` in the entry to the Vercel project's id (`prj_…`) or its name. The bare " +
        "string shorthand cannot carry one, so this environment needs the object form: " +
        '`{ provider: "@penvhq/provider-vercel", project: "prj_…" }`.',
    );
  }

  // Refused before `verify` opens a connection: an environment with no target to
  // land on has no safe place for its values.
  const target = resolveTarget(context.providerConfig?.["target"], environment);

  const teamId = context.providerConfig?.["teamId"];
  return createVercelProvider({
    project,
    target,
    ...(typeof teamId === "string" && teamId !== "" ? { teamId } : {}),
  });
}
