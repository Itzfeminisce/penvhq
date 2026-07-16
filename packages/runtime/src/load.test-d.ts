/**
 * The v0.2 type-level gate. One schema drives both a failing `penv validate` and
 * the compile errors below — if `load` ever stopped returning `z.infer<T>`, the
 * type-safety claim would collapse silently rather than fail here.
 *
 * Nothing in this file runs; `toEqualTypeOf` is invariant, so any widening to
 * `any` or `unknown` fails it.
 */

import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { load } from "./load.js";

const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({ password: z.string().optional() }),
});

describe("load", () => {
  it("returns exactly the shape the schema describes", () => {
    expectTypeOf(load(schema)).toEqualTypeOf<{
      databaseUrl: string;
      redis: { password?: string | undefined };
    }>();
  });

  it("returns the inferred schema type itself, with no duplicated declaration", () => {
    expectTypeOf(load(schema)).toEqualTypeOf<z.infer<typeof schema>>();
  });

  it("types each nested member from the schema", () => {
    expectTypeOf(load(schema).databaseUrl).toEqualTypeOf<string>();
    expectTypeOf(load(schema).redis.password).toEqualTypeOf<string | undefined>();
  });

  it("rejects a key the schema does not declare", () => {
    const env = load(schema);
    // @ts-expect-error `port` is not in the schema, so reading it cannot compile.
    void env.port;
  });

  it("rejects a string parameter used as a number", () => {
    const env = load(schema);
    // @ts-expect-error `databaseUrl` is a string; a number annotation cannot compile.
    const port: number = env.databaseUrl;
    void port;
  });
});
