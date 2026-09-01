/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The entry is written in Vault's own vocabulary, so the
 * factory reads `path` straight through — there is no generic address field left
 * to translate.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { createVaultProvider } from "./vault.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/** Builds the Vault provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  const path = context.providerConfig?.path;
  if (path === undefined) {
    return createVaultProvider({ path: "penv" });
  }
  // An empty `path` is what an interpolated value that came up empty leaves
  // behind, and it is not the same declaration as leaving the field out.
  if (typeof path !== "string" || path.trim() === "") {
    throw new PenvError(
      "PROVIDER_FIELD_EMPTY",
      "`path` in this environment's penv.config.ts entry is not a path",
      "Give `path` the mount and prefix this environment's secrets live under, or leave it out and penv uses `penv`.",
    );
  }
  return createVaultProvider({ path });
}
