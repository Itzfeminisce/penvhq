/**
 * The declaration `penv add` writes for a package that ships none of its own,
 * reproduced here exactly as {@link renderDeclaration} emits it.
 *
 * Nothing here runs. It exists because the generated file lands in someone
 * else's repository, where a form that does not compile is discovered by them
 * rather than by us — and because the open shape has one job: make the provider
 * name a checked value in `penv.config.ts` without pretending penv knows fields
 * the package never declared.
 */

import { defineConfig, type ProviderConfig } from "@penvhq/core";
import { describe, it } from "vitest";

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@acme/provider-generated": ProviderConfig & { readonly type: "@acme/provider-generated" };
  }
}

describe("the generated open shape", () => {
  it("accepts the provider it names, with the fields only the provider knows", () => {
    defineConfig({
      environments: ["production"],
      providers: {
        production: { type: "@acme/provider-generated", location: "secret/app", datacenter: "eu" },
      },
    });
  });

  it("still holds the fields every provider entry shares", () => {
    defineConfig({
      environments: ["production"],
      // @ts-expect-error `location` is a string on every provider entry.
      providers: { production: { type: "@acme/provider-generated", location: 7 } },
    });
  });
});
