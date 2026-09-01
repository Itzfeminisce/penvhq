/**
 * The type-level gate for environment-entry typing. Each installed provider
 * package merges its config shape into `ProviderConfigMap`, and `defineConfig`
 * holds a known `provider`'s entry to that declaration — exact fields — while an
 * unknown package keeps the open base shape. The augmentations below stand in for
 * two provider packages: one that needs a field, one that needs none.
 *
 * Nothing in this file runs; if the validation ever silently widened, the
 * `@ts-expect-error` lines would fail here rather than in a user's editor.
 */

import { describe, expectTypeOf, it } from "vitest";
import { defineConfig } from "./config.js";
import type {
  KeySourceDeclaration,
  ProviderConfigMap,
  ValidatedEnvironmentEntry,
} from "./types.js";

declare module "./types.js" {
  interface ProviderConfigMap {
    "@test/penv-provider-typed": {
      readonly project: string;
      /** Unit-typed, because a wrong literal is the case that used to take the whole entry down. */
      readonly target?: "production" | "preview";
      readonly teamId?: string;
    };
    /** Config-free, so the bare package name is a complete declaration. */
    "@test/penv-provider-free": {
      readonly path?: string;
    };
  }
}

describe("defineConfig entry typing", () => {
  it("accepts a known provider with its declared fields", () => {
    defineConfig({
      environments: {
        production: { provider: "@test/penv-provider-typed", project: "acme-web" },
      },
    });
  });

  it("accepts core's own fields beside the provider's", () => {
    defineConfig({
      environments: {
        production: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          keySource: "env",
        },
        staging: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          keySource: { source: "keychain", id: "staging-2026" },
        },
      },
    });
  });

  it("rejects a field the known provider never declared", () => {
    defineConfig({
      environments: {
        production: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          // @ts-expect-error `repo` is not a field `@test/penv-provider-typed` declares.
          repo: "acme/api",
        },
      },
    });
  });

  it("names the field and the provider in what it rejects an excess field against", () => {
    expectTypeOf<
      ValidatedEnvironmentEntry<{
        readonly provider: "@test/penv-provider-typed";
        readonly repo: string;
      }>
    >().toEqualTypeOf<{
      readonly repo: { readonly "repo is not a field @test/penv-provider-typed declares": never };
    }>();
  });

  it("leaves a sound entry's own fields intact — no rejection shape anywhere in it", () => {
    expectTypeOf<
      ValidatedEnvironmentEntry<{
        readonly provider: "@test/penv-provider-typed";
        readonly project: string;
      }>
    >().toEqualTypeOf<
      ProviderConfigMap["@test/penv-provider-typed"] & {
        readonly provider: "@test/penv-provider-typed";
        readonly keySource?: KeySourceDeclaration;
      }
    >();
  });

  it("rejects a declared field of the wrong type", () => {
    defineConfig({
      environments: {
        // @ts-expect-error `project` is a string, not a number.
        production: { provider: "@test/penv-provider-typed", project: 7 },
      },
    });
  });

  /**
   * The one field, and only it. A wrong literal in a unit-typed field used to
   * collapse the whole entry to `never`, and every field of it — including the
   * correct ones — then reported against `never` while none named the typo.
   */
  it("rejects a misspelled unit-typed value at the field that carries it", () => {
    defineConfig({
      environments: {
        production: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          // @ts-expect-error `producton` is not one of the targets this provider declares.
          target: "producton",
        },
      },
    });
  });

  /**
   * `keySource` is core's own field, and a wrong one used to break the config
   * against `PenvConfig` itself — which took `defineConfig` to its constraint and
   * produced a second error on a *correct* sibling, naming a provider package the
   * config never mentioned.
   */
  it("rejects a wrong `keySource` at `keySource`, leaving its siblings alone", () => {
    defineConfig({
      environments: {
        production: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          // @ts-expect-error `keychian` is not a key source.
          keySource: "keychian",
        },
        staging: {
          provider: "@test/penv-provider-typed",
          project: "acme-web",
          // @ts-expect-error a key id is a string.
          keySource: { source: "env", id: 7 },
        },
      },
    });
  });

  /**
   * Core reserves `provider`, `keySource`, `key` and `keyId`, so none of them is
   * ever reported as a field the provider does not declare. `penv add` is what
   * refuses a `penv.types` declaring one — a collision is made impossible where
   * the shape enters, not re-checked on every config.
   */
  it("never reads a reserved field as one the provider does not declare", () => {
    expectTypeOf<
      ValidatedEnvironmentEntry<{
        readonly provider: "@test/penv-provider-typed";
        readonly project: string;
        readonly keySource: "env";
      }>
    >().toEqualTypeOf<
      ProviderConfigMap["@test/penv-provider-typed"] & {
        readonly provider: "@test/penv-provider-typed";
        readonly keySource?: KeySourceDeclaration;
      }
    >();
  });

  it("keeps the open base shape for a provider core has no declaration for", () => {
    defineConfig({
      environments: {
        production: { provider: "@acme/penv-provider-doppler", project: "web", config: "apps" },
      },
    });
  });
});

describe("the string shorthand", () => {
  it("is legal for a provider whose declared shape has no required fields", () => {
    defineConfig({
      environments: {
        development: "@test/penv-provider-free",
        production: { provider: "@test/penv-provider-typed", project: "acme-web" },
      },
    });
  });

  it("is legal for a package core has no declaration for", () => {
    defineConfig({ environments: { development: "@acme/penv-provider-doppler" } });
  });

  it("is illegal for a provider that declares a required field", () => {
    defineConfig({
      environments: {
        // @ts-expect-error `@test/penv-provider-typed` needs `project`, so it needs the object form.
        production: "@test/penv-provider-typed",
      },
    });
  });

  it("says why, rather than failing against a bare `never`", () => {
    expectTypeOf<ValidatedEnvironmentEntry<"@test/penv-provider-typed">>().toEqualTypeOf<{
      readonly "@test/penv-provider-typed declares required fields, so this environment needs the object form": never;
    }>();
  });

  it("leaves a config-free provider's shorthand as the name itself", () => {
    expectTypeOf<
      ValidatedEnvironmentEntry<"@test/penv-provider-free">
    >().toEqualTypeOf<"@test/penv-provider-free">();
  });
});
