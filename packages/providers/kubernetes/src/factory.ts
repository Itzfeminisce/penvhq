/**
 * The plugin seam: what the penv CLI calls when an `environments.*.provider`
 * names this package. The entry is written in Kubernetes' own vocabulary — the
 * Secret and the cluster namespace are two facts in two fields — so the factory
 * reads them straight through, with nothing packed into one string.
 */

import type { Provider, ProviderFactoryContext } from "@penvhq/core";
import { PenvError } from "@penvhq/core";
import { createKubernetesProvider } from "./kubernetes.js";

// The config shape this factory reads is declared once, in `penv.d.ts` — the
// file `penv.types` ships and `penv add` commits into the project.

/**
 * A declared field, or nothing. An empty string is neither: it is what an
 * interpolated value that came up empty leaves behind, and taking it for
 * "undeclared" would write this environment's whole record tree into the default
 * Secret the config never named.
 */
function declared(field: string, value: unknown, remedy: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new PenvError(
    "PROVIDER_FIELD_EMPTY",
    `\`${field}\` in this environment's penv.config.ts entry is not a name`,
    remedy,
  );
}

/** Builds the Kubernetes provider for one environment's declared source of truth. */
export function penvProviderFactory(context: ProviderFactoryContext): Provider {
  const namespace = declared(
    "namespace",
    context.providerConfig?.namespace,
    "Name the namespace this environment lives in, or leave `namespace` out and kubectl uses the current context's.",
  );
  const secret = declared(
    "secret",
    context.providerConfig?.secret,
    "Name the Secret this environment lives in, or leave `secret` out and penv uses `penv`.",
  );
  return createKubernetesProvider({
    secretName: secret ?? "penv",
    // Left off entirely when undeclared, so `kubectl` uses the current context's namespace.
    ...(namespace === undefined ? {} : { namespace }),
  });
}
