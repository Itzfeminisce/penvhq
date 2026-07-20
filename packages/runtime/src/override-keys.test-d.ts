/**
 * The type-level gate for schema-typed `override` keys.
 *
 * `OverrideKeysOf` is the transform the scaffolded `.penv/env.ts` wires into
 * config typing when it registers the schema's shape on `PenvSchemaShape` —
 * so these assertions gate what a user's editor accepts and refuses. The
 * registration itself is deliberately NOT exercised here: module augmentation
 * is global to a TypeScript program, and this monorepo typechecks as one, so
 * an augmentation in any test would narrow every other package's fixtures.
 * The three-line conditional that reads the registration is covered by the
 * un-registered default asserted last.
 */

import type { OverrideKey, OverrideKeysOf } from "@penvhq/core";
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { z as zod } from "zod";

const schema = zod.object({
  databaseUrl: zod.url(),
  workos: zod.object({
    apiKey: zod.string(),
    redirectUri: zod.url(),
  }),
});

type Shape = z.infer<typeof schema>;

describe("OverrideKeysOf", () => {
  it("maps the schema's shape to exactly its parameter ids, camelCase kebab-cased", () => {
    expectTypeOf<OverrideKeysOf<Shape>>().toEqualTypeOf<
      "database-url" | "workos/api-key" | "workos/redirect-uri"
    >();
  });

  it("treats an optional leaf as a parameter, not a namespace", () => {
    expectTypeOf<OverrideKeysOf<{ apiKey?: string; nested: { maxAge?: number } }>>().toEqualTypeOf<
      "api-key" | "nested/max-age"
    >();
  });

  it("keeps arrays and dates as leaves rather than descending into them", () => {
    expectTypeOf<OverrideKeysOf<{ allowedHosts: string[]; expiresAt: Date }>>().toEqualTypeOf<
      "allowed-hosts" | "expires-at"
    >();
  });

  it("stays the open string type while no schema shape is registered", () => {
    // The wiring `PenvSchemaShape` → `OverrideKey` falls back to `string` when
    // nothing registered a shape — which is this program's state, on purpose.
    expectTypeOf<OverrideKey>().toEqualTypeOf<string>();
  });
});
