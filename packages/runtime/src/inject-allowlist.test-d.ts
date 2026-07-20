/**
 * The type-level gate for the `inject` allowlist. Because `load` binds the schema
 * type, the allowlist narrows to that schema's own parameter ids — so an id the
 * schema declares compiles, and a typo does not. Nothing here runs.
 */

import { describe, it } from "vitest";
import { z } from "zod";
import { type LoadOptions, load } from "./load.js";

const schema = z.object({
  databaseUrl: z.url(),
  workos: z.object({ apiKey: z.string(), redirectUri: z.url() }),
});

describe("the inject allowlist type", () => {
  it("accepts true, and parameter ids the schema declares (camelCase kebab-cased)", () => {
    load(schema, { inject: true });
    load(schema, { inject: ["workos/api-key", "workos/redirect-uri", "database-url"] });
  });

  it("rejects an id the schema does not declare", () => {
    // @ts-expect-error `workos/redirect-url` is a typo — the schema declares `redirect-uri`.
    load(schema, { inject: ["workos/redirect-url"] });
  });

  it("rejects a namespace used as if it were a parameter", () => {
    // @ts-expect-error `workos` is a namespace, not a parameter id.
    load(schema, { inject: ["workos"] });
  });

  it("still forwards a `LoadOptions`-typed value — the base type is assignable", () => {
    // A wrapper that types its options against the schema-agnostic `LoadOptions`
    // (whose `inject` is a plain boolean) must still pass them to `load`.
    const forward = (options: LoadOptions) => load(schema, options);
    forward({ inject: true });
  });
});
