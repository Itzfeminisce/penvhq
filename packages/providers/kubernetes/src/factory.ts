/**
 * The plugin seam: what the penv CLI calls when a `providers.*.type` names this
 * package. The factory owns the translation from the config's provider-agnostic
 * surface (`location`) to this provider's own options — including the
 * `namespace/secretName` split, which is this package's business and nobody
 * else's: `ProviderConfig` has no namespace field, and must not grow one.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createKubernetesProvider } from "./kubernetes.js";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-kubernetes": {
      /**
       * The Secret penv maps the tree onto: `<namespace>/<secretName>`, or just
       * `<secretName>` to use the current `kubectl` context's namespace.
       * Defaults to a Secret named `penv`.
       */
      readonly location?: string;
    };
  }
}

/**
 * Splits `location` into the provider's own options. `team-ns/penv-secrets`
 * addresses a Secret in a non-default namespace; a bare `penv-secrets` leaves
 * the namespace to the current `kubectl` context.
 */
function kubernetesOptions(location: string | undefined): {
  namespace?: string;
  secretName: string;
} {
  const path = location ?? "penv";
  const slash = path.indexOf("/");
  if (slash === -1) return { secretName: path };
  const namespace = path.slice(0, slash);
  const secretName = path.slice(slash + 1) || "penv";
  return namespace === "" ? { secretName } : { namespace, secretName };
}

/** Builds the Kubernetes provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  return createKubernetesProvider(kubernetesOptions(context.providerConfig?.location));
}
