/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never learns
 * Vercel vocabulary beyond the one thing it must declare — which target each
 * environment deploys to — and the provider never parses config.
 */

import type { ProjectionProvider, ProviderFactoryContext } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import type { VercelTarget, VercelTargetMap } from "./vercel.js";
import { createVercelProvider, resolveTarget } from "./vercel.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-vercel": {
      /** The Vercel project penv writes into — its id (`prj_…`) or its name. */
      readonly location: string;
      /** Which Vercel target each environment deploys to. penv never guesses this. */
      readonly targets: Readonly<Record<string, VercelTarget>>;
      /** The team owning the project. Only an account-wide token needs to name one. */
      readonly teamId?: string;
    };
  }
}

function asTargetMap(value: unknown): VercelTargetMap | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as VercelTargetMap)
    : undefined;
}

/** Builds the Vercel provider for one environment's declared destination. */
export function penvProviderFactory(context: ProviderFactoryContext): ProjectionProvider {
  const project = context.providerConfig?.location;
  if (typeof project !== "string" || project.trim() === "") {
    throw new PenvError(
      "VERCEL_PROJECT_MISSING",
      "The Vercel provider has no project to write to",
      "Set `location` in the provider entry to the project's id (`prj_…`) or its name — " +
        '`{ type: "@penvhq/provider-vercel", location: "prj_…", targets: { production: "production" } }` — ' +
        "or pass `--location` with a one-shot `--destination` push.",
    );
  }

  const targets = asTargetMap(context.providerConfig?.["targets"]);
  // Refused here, before `verify` opens a connection: an environment with no
  // declared target has no safe place to land, and the config key that fixes it
  // is named in the refusal.
  if (context.environment !== undefined) {
    resolveTarget(targets, context.environment);
  }

  const teamId = context.providerConfig?.["teamId"];
  return createVercelProvider({
    project,
    targets: targets ?? {},
    ...(typeof teamId === "string" && teamId !== "" ? { teamId } : {}),
  });
}
