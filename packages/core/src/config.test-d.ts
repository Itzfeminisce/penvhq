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

import { describe, it } from "vitest";
import { defineConfig } from "./config.js";

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
