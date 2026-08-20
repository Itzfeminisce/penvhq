/**
 * The type-level gate for provider config typing. Each installed provider
 * package merges its config shape into `ProviderConfigMap`, and `defineConfig`
 * holds a known `type`'s entry to that declaration — exact fields — while an
 * unknown `type` keeps the open base shape. The augmentation below stands in
 * for a provider package doing exactly what `@penvhq/provider-vault` does.
 *
 * Nothing in this file runs; if the validation ever silently widened, the
 * `@ts-expect-error` lines would fail here rather than in a user's editor.
 */

import { describe, expectTypeOf, it } from "vitest";
import { defineConfig } from "./config.js";
import type { ProviderConfigMap, ValidatedProviderEntry } from "./types.js";

declare module "./types.js" {
  interface ProviderConfigMap {
    "@test/penv-provider-typed": {
      readonly location?: string;
    };
  }
}

describe("defineConfig provider typing", () => {
  it("accepts a known provider with its declared fields", () => {
    defineConfig({
      environments: ["production"],
      providers: {
        production: { type: "@test/penv-provider-typed", location: "secret/app" },
      },
    });
  });

  it("rejects a field the known provider never declared", () => {
    defineConfig({
      environments: ["production"],
      providers: {
        // @ts-expect-error `repo` is not a field `@test/penv-provider-typed` declares.
        production: { type: "@test/penv-provider-typed", repo: "acme/api" },
      },
    });
  });

  it("names the field and the provider in what it rejects an excess field against", () => {
    expectTypeOf<
      ValidatedProviderEntry<{ readonly type: "@test/penv-provider-typed"; readonly repo: string }>
    >().toEqualTypeOf<{
      readonly repo: { readonly "repo is not a field @test/penv-provider-typed declares": never };
    }>();
  });

  it("leaves a sound entry's own fields intact — no rejection shape anywhere in it", () => {
    expectTypeOf<
      ValidatedProviderEntry<{
        readonly type: "@test/penv-provider-typed";
        readonly location: string;
      }>
    >().toEqualTypeOf<
      ProviderConfigMap["@test/penv-provider-typed"] & {
        readonly type: "@test/penv-provider-typed";
      }
    >();
  });

  it("rejects a declared field of the wrong type", () => {
    defineConfig({
      environments: ["production"],
      providers: {
        // @ts-expect-error `location` is a string, not a number.
        production: { type: "@test/penv-provider-typed", location: 7 },
      },
    });
  });

  it("keeps the open base shape for a provider core has no declaration for", () => {
    defineConfig({
      environments: ["production"],
      providers: {
        production: { type: "@acme/penv-provider-doppler", project: "web", location: "apps" },
      },
    });
  });
});
