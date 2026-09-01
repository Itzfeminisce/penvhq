/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The entry is written in SSM's own vocabulary, so the
 * factory reads `path` straight through — there is no generic address field left
 * to translate.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createSsmProvider } from "./ssm.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the SSM provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  const path = context.providerConfig?.path;
  return createSsmProvider({ path: typeof path === "string" ? path : "penv" });
}
