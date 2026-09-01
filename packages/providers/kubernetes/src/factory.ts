/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The entry is written in Kubernetes' own vocabulary — the
 * Secret and the cluster namespace are two facts in two fields — so the factory
 * reads them straight through, with nothing packed into one string.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { createKubernetesProvider } from "./kubernetes.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Builds the Kubernetes provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  const namespace = text(context.providerConfig?.namespace);
  return createKubernetesProvider({
    secretName: text(context.providerConfig?.secret) ?? "penv",
    // Left off entirely when undeclared, so `kubectl` uses the current context's namespace.
    ...(namespace === undefined ? {} : { namespace }),
  });
}
