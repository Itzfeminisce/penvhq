/**
 * The declaration `penv add` writes for a package that ships none of its own,
 * reproduced here exactly as {@link renderDeclaration} emits it.
 *
 * Nothing here runs. It exists because the generated file lands in someone
 * else's repository, where a form that does not compile is discovered by them
 * rather than by us — and because the open shape has one job: make the provider
 * name a checked value in `penv.config.ts` without pretending penv knows fields
 * the package never declared.
 *
 * Only resolution-robust assertions live here: the workspace-root `tsc` program
 * cannot see a cross-package `declare module "@penvhq/core"` augmentation (the
 * per-package programs can), so anything requiring the merged map is proven
 * elsewhere — core's config.test-d.ts holds the validated entry to core's
 * `provider`/`keySource`, and the artifact smoke test compiles a committed
 * declaration against the packed dist.
 */

import { defineConfig, type ProviderConfig } from "@penvhq/core";
import { describe, it } from "vitest";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@acme/provider-generated": ProviderConfig & { readonly provider: "@acme/provider-generated" };
  }
}

describe("the generated open shape", () => {
  it("accepts the provider it names, with the fields only the provider knows", () => {
    defineConfig({
      environments: {
        production: {
          provider: "@acme/provider-generated",
          cluster: "secret/app",
          datacenter: "eu",
          keySource: "env",
        },
      },
    });
  });
});
