/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never
 * learns SSM vocabulary and the provider never parses config.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createSsmProvider } from "./ssm.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the SSM provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  return createSsmProvider({ path: context.providerConfig?.location ?? "penv" });
}
