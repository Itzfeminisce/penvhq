/**
 * The ambient mirror's contract, each property with its firing and its quiet
 * case: it writes what the schema declares and resolves, deletes what the schema
 * declares but the tree does not have, leaves what the schema never declared
 * untouched, bends names through `override`, writes raw bytes rather than the
 * schema-coerced value, and refuses a collision before it touches the target.
 */

import type { PenvConfig } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { declaredRefs, mirror } from "./mirror.js";

const CONFIG: PenvConfig = {
  environments: ["production"],
  providers: { production: { type: "@penvhq/provider-filesystem" } },
};

const SCHEMA = z.object({
  databaseUrl: z.url(),
  workos: z.object({
    apiKey: z.string(),
    apiHostname: z.string().optional(),
  }),
});

/** A fresh env target so no test leaks into `process.env` or another test. */
function target(seed: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...seed };
}

describe("declaredRefs", () => {
  it("enumerates every leaf as a parameter and every object as a namespace", () => {
    const ids = declaredRefs(SCHEMA)
      .map((ref) => [...ref.namespace, ref.name].join("/"))
      .sort();
    expect(ids).toEqual(["database-url", "workos/api-key", "workos/api-hostname"].sort());
  });

  it("includes an optional parameter — the delete rule needs to see it", () => {
    const ids = declaredRefs(SCHEMA).map((ref) => [...ref.namespace, ref.name].join("/"));
    expect(ids).toContain("workos/api-hostname");
  });
});

describe("mirror", () => {
  it("writes each declared, resolved parameter under its generated variable", () => {
    const env = target();
    const result = mirror(
      SCHEMA,
      CONFIG,
      [
        { ref: { namespace: [], name: "database-url" }, value: "postgres://prod" },
        { ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" },
      ],
      env,
    );

    expect(env.DATABASE_URL).toBe("postgres://prod");
    expect(env.WORKOS_API_KEY).toBe("sk_live");
    expect(result.written).toBe(2);
  });

  it("deletes a declared parameter the tree did not resolve — nothing configures the SDK behind @env's back", () => {
    // The exclusivity property: WORKOS_API_HOSTNAME is declared (optional) and
    // has no value, so a stray ambient one is removed.
    const env = target({ WORKOS_API_HOSTNAME: "https://evil.example" });
    const result = mirror(
      SCHEMA,
      CONFIG,
      [
        { ref: { namespace: [], name: "database-url" }, value: "postgres://prod" },
        { ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" },
      ],
      env,
    );

    expect("WORKOS_API_HOSTNAME" in env).toBe(false);
    expect(result.deleted).toBe(1);
  });

  it("leaves a variable the schema never declared untouched", () => {
    const env = target({ SOME_OTHER_TOOL: "keep-me" });
    mirror(
      SCHEMA,
      CONFIG,
      [{ ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" }],
      env,
    );
    expect(env.SOME_OTHER_TOOL).toBe("keep-me");
  });

  it("overwrites a declared variable already present — the schema is authoritative over what it names", () => {
    const env = target({ WORKOS_API_KEY: "sk_stale" });
    mirror(
      SCHEMA,
      CONFIG,
      [{ ref: { namespace: ["workos"], name: "api-key" }, value: "sk_fresh" }],
      env,
    );
    expect(env.WORKOS_API_KEY).toBe("sk_fresh");
  });

  it("bends the variable name through an override", () => {
    const config: PenvConfig = {
      ...CONFIG,
      override: { "workos/api-key": "NEXT_PUBLIC_WORKOS_KEY" },
    };
    const env = target();
    mirror(
      SCHEMA,
      config,
      [{ ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" }],
      env,
    );
    expect(env.NEXT_PUBLIC_WORKOS_KEY).toBe("sk_live");
    expect(env.WORKOS_API_KEY).toBeUndefined();
  });

  it("writes the raw bytes, never the schema-coerced value", () => {
    const schema = z.object({ port: z.coerce.number() });
    const env = target();
    mirror(schema, CONFIG, [{ ref: { namespace: [], name: "port" }, value: "5432" }], env);
    // process.env is strings; the SDK re-parses. A coerced `5432` here would be a bug.
    expect(env.PORT).toBe("5432");
  });

  it("refuses a collision before touching the target", () => {
    // Two declared parameters that generate one variable — first-write-wins would
    // drop one silently, so the mirror throws before writing anything.
    const schema = z.object({ apiKey: z.string(), api: z.object({ key: z.string() }) });
    const config: PenvConfig = {
      ...CONFIG,
      override: { "api-key": "API_KEY", "api/key": "API_KEY" },
    };
    const env = target();
    expect(() =>
      mirror(
        schema,
        config,
        [
          { ref: { namespace: [], name: "api-key" }, value: "a" },
          { ref: { namespace: ["api"], name: "key" }, value: "b" },
        ],
        env,
      ),
    ).toThrow();
    expect(Object.keys(env)).toEqual([]);
  });

  it("reports counts for a report to render", () => {
    const env = target({ WORKOS_API_HOSTNAME: "stale" });
    const result = mirror(
      SCHEMA,
      CONFIG,
      [
        { ref: { namespace: [], name: "database-url" }, value: "postgres://prod" },
        { ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" },
      ],
      env,
    );
    expect(result).toEqual({ written: 2, deleted: 1 });
  });
});
