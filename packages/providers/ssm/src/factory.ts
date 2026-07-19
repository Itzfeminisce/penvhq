/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never
 * learns SSM vocabulary and the provider never parses config.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createSsmProvider } from "./ssm.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-ssm": {
      /**
       * The Parameter Store base path penv maps records under — `/penv/prod`.
       * Defaults to `penv` (stored as `/penv`). Every parameter name becomes
       * `<location>/<value-filename>`.
       */
      readonly location?: string;
    };
  }
}

/** Builds the SSM provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  return createSsmProvider({ path: context.providerConfig?.location ?? "penv" });
}
