/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never
 * learns Vault vocabulary and the provider never parses config.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createVaultProvider } from "./vault.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-vault": {
      /**
       * The KV v2 base path penv maps records onto, mount-relative —
       * `penv/staging`. Defaults to `penv`. The mount itself comes from
       * `VAULT_MOUNT` (default `secret`), because which mount to talk to is a
       * property of the Vault deployment, not of one project's config.
       */
      readonly location?: string;
    };
  }
}

/** Builds the Vault provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  return createVaultProvider({ path: context.providerConfig?.location ?? "penv" });
}
