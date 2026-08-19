/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never
 * learns GitHub vocabulary and the provider never parses config.
 */

import type { ProjectionProvider, ProviderFactoryContext } from "@penvhq/core";
import { createGithubProvider } from "./github.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the GitHub provider for one environment's declared destination. */
export function penvProviderFactory(context: ProviderFactoryContext): ProjectionProvider {
  const location = context.providerConfig?.location;
  return createGithubProvider(location === undefined ? {} : { repo: location });
}
