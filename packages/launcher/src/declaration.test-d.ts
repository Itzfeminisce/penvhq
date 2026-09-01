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

import {
  defineConfig,
  type KeySourceDeclaration,
  type ProviderConfig,
  type ProviderConfigMap,
  type ValidatedEnvironmentEntry,
} from "@penvhq/core";
import { describe, expectTypeOf, it } from "vitest";

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

  /** The open shape widens what the provider declares, never what core writes beside it. */
  it("still carries the fields core owns on every entry", () => {
    expectTypeOf<
      ValidatedEnvironmentEntry<{ readonly provider: "@acme/provider-generated" }>
    >().toEqualTypeOf<
      ProviderConfigMap["@acme/provider-generated"] & {
        readonly provider: "@acme/provider-generated";
        readonly keySource?: KeySourceDeclaration;
      }
    >();
  });
});
