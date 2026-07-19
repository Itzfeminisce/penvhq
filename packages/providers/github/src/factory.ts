/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options, so the config never
 * learns GitHub vocabulary and the provider never parses config.
 */

import type { ProjectionProvider, ProviderFactoryContext } from "@penvhq/core";
import { createGithubProvider } from "./github.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-github": {
      /**
       * The repository penv maps the projection onto — `owner/repo`. Left
       * unset, `gh` resolves it from the working directory.
       */
      readonly location?: string;
    };
  }
}

/** Builds the GitHub provider for one environment's declared destination. */
export function penvProviderFactory(context: ProviderFactoryContext): ProjectionProvider {
  const location = context.providerConfig?.location;
  return createGithubProvider(location === undefined ? {} : { repo: location });
}
