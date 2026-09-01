/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The factory reads the entry's `repository` and hands the
 * provider its options, so the provider never parses config.
 */

import type { ProjectionProvider, ProviderFactoryContext } from "@penvhq/core";
import { createGithubProvider } from "./github.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the GitHub provider for one environment's declared destination. */
export function penvProviderFactory(context: ProviderFactoryContext): ProjectionProvider {
  const repository = context.providerConfig?.["repository"];
  // Optional: unset, the provider asks `gh` once for the repo this directory is in.
  return createGithubProvider(typeof repository === "string" ? { repo: repository } : {});
}
