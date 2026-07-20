/**
 * The env-injection contract, each property with its firing and its quiet case:
 * it writes what the schema declares and resolves, injects a schema default the
 * tree did not set (rather than deleting it), deletes what the schema declares
 * but has no value at all, leaves what the schema never declared untouched, bends
 * names through `override`, writes raw bytes rather than the schema-coerced value,
 * enumerates a union's branch fields, and refuses a collision before it touches
 * the target.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { declaredRefs, inject } from "./inject.js";

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

/** A `{ ref, value }` pair from a slash id, so the fixtures read like the tree. */
function val(id: string, value: string): { ref: ParameterRef; value: string } {
  const segments = id.split("/");
  return {
    ref: { namespace: segments.slice(0, -1), name: segments[segments.length - 1] as string },
    value,
  };
}

const ids = (refs: ParameterRef[]): string[] =>
  refs.map((ref) => [...ref.namespace, ref.name].join("/")).sort();

describe("declaredRefs", () => {
  it("enumerates every leaf as a parameter and every object as a namespace", () => {
    expect(ids(declaredRefs(SCHEMA))).toEqual(
      ["database-url", "workos/api-key", "workos/api-hostname"].sort(),
    );
  });

  it("includes an optional parameter — the delete rule needs to see it", () => {
    expect(ids(declaredRefs(SCHEMA))).toContain("workos/api-hostname");
  });

  it("enumerates every branch field of a discriminated union, deduping the discriminator", () => {
    // A union at a namespace position: penv must own every field any branch could
    // declare, so a stray value for the branch that did not resolve can be deleted.
    const schema = z.object({
      db: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("pg"), host: z.string() }),
        z.object({ kind: z.literal("url"), url: z.string() }),
      ]),
    });
    expect(ids(declaredRefs(schema))).toEqual(["db/host", "db/kind", "db/url"].sort());
  });

  it("enumerates both members of an intersection", () => {
    const schema = z.object({
      creds: z.intersection(z.object({ id: z.string() }), z.object({ secret: z.string() })),
    });
    expect(ids(declaredRefs(schema))).toEqual(["creds/id", "creds/secret"].sort());
  });

  it("treats a nullable leaf as one parameter, not a null branch", () => {
    const schema = z.object({ token: z.string().nullable() });
    expect(ids(declaredRefs(schema))).toEqual(["token"]);
  });
});

describe("inject", () => {
  it("writes each declared, resolved parameter under its generated variable", () => {
    const env = target();
    const result = inject({
      schema: SCHEMA,
      config: CONFIG,
      values: [val("database-url", "postgres://prod"), val("workos/api-key", "sk_live")],
      target: env,
    });

    expect(env.DATABASE_URL).toBe("postgres://prod");
    expect(env.WORKOS_API_KEY).toBe("sk_live");
    expect(result.written).toBe(2);
  });

  it("deletes a declared parameter with no value — nothing configures the SDK behind @env's back", () => {
    // WORKOS_API_HOSTNAME is declared (optional) and has neither a tree value nor
    // a default, so a stray ambient one is removed.
    const env = target({ WORKOS_API_HOSTNAME: "https://evil.example" });
    const result = inject({
      schema: SCHEMA,
      config: CONFIG,
      values: [val("database-url", "postgres://prod"), val("workos/api-key", "sk_live")],
      target: env,
    });

    expect("WORKOS_API_HOSTNAME" in env).toBe(false);
    expect(result.deleted).toBe(1);
  });

  it("injects a schema default the tree did not set, rather than deleting it", () => {
    // The tree has no `port`, but the schema defaults it — so process.env must
    // carry the default, matching what @env reports, not lose it to the delete rule.
    const schema = z.object({ port: z.string().default("5432") });
    const env = target({ PORT: "stale" });
    const result = inject({
      schema,
      config: CONFIG,
      values: [],
      validated: { port: "5432" },
      target: env,
    });
    expect(env.PORT).toBe("5432");
    expect(result).toEqual({ written: 1, deleted: 0 });
  });

  it("injects every resolved branch field of a union and deletes the strays", () => {
    const schema = z.object({
      db: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("pg"), host: z.string() }),
        z.object({ kind: z.literal("url"), url: z.string() }),
      ]),
    });
    // The `pg` branch resolved; a stale DB_URL from the other branch must go.
    const env = target({ DB_URL: "postgres://stale" });
    inject({
      schema,
      config: CONFIG,
      values: [val("db/kind", "pg"), val("db/host", "10.0.0.1")],
      target: env,
    });
    expect(env.DB_KIND).toBe("pg");
    expect(env.DB_HOST).toBe("10.0.0.1");
    expect("DB_URL" in env).toBe(false);
  });

  it("leaves a variable the schema never declared untouched", () => {
    const env = target({ SOME_OTHER_TOOL: "keep-me" });
    inject({
      schema: SCHEMA,
      config: CONFIG,
      values: [val("workos/api-key", "sk_live")],
      target: env,
    });
    expect(env.SOME_OTHER_TOOL).toBe("keep-me");
  });

  describe("an allowlist", () => {
    // A schema holding a secret that must NOT reach process.env, next to one that must.
    const MIXED = z.object({
      databaseUrl: z.url(),
      workos: z.object({ apiKey: z.string(), apiHostname: z.string().optional() }),
    });

    it("injects only the listed parameters and leaves every other one alone", () => {
      // DATABASE_URL is a declared secret the allowlist omits — it must never be written,
      // even though the tree resolved it.
      const env = target();
      const result = inject({
        schema: MIXED,
        config: CONFIG,
        only: ["workos/api-key"],
        values: [
          { ref: { namespace: [], name: "database-url" }, value: "postgres://prod" },
          { ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" },
        ],
        target: env,
      });

      expect(env.WORKOS_API_KEY).toBe("sk_live");
      expect("DATABASE_URL" in env).toBe(false);
      expect(result.written).toBe(1);
    });

    it("does not delete an excluded parameter, even when it is declared and valueless", () => {
      // A stray DATABASE_URL is left alone because the allowlist omits it — exclusivity
      // is scoped to the allowlist, so inject never touches a parameter it was not asked to.
      const env = target({ DATABASE_URL: "from-the-platform", WORKOS_API_HOSTNAME: "stray" });
      inject({
        schema: MIXED,
        config: CONFIG,
        only: ["workos/api-key", "workos/api-hostname"],
        values: [{ ref: { namespace: ["workos"], name: "api-key" }, value: "sk_live" }],
        target: env,
      });

      // The listed-but-valueless optional is deleted; the excluded secret is untouched.
      expect("WORKOS_API_HOSTNAME" in env).toBe(false);
      expect(env.DATABASE_URL).toBe("from-the-platform");
    });

    it("still catches a collision across the whole schema, not just the allowlist", () => {
      const schema = z.object({ apiKey: z.string(), api: z.object({ key: z.string() }) });
      expect(() =>
        inject({
          schema,
          config: { ...CONFIG, override: { "api-key": "API_KEY", "api/key": "API_KEY" } },
          only: ["api-key"],
          values: [val("api-key", "a")],
          target: target(),
        }),
      ).toThrow();
    });
  });

  it("overwrites a declared variable already present — the schema is authoritative over what it names", () => {
    const env = target({ WORKOS_API_KEY: "sk_stale" });
    inject({
      schema: SCHEMA,
      config: CONFIG,
      values: [val("workos/api-key", "sk_fresh")],
      target: env,
    });
    expect(env.WORKOS_API_KEY).toBe("sk_fresh");
  });

  it("bends the variable name through an override", () => {
    const env = target();
    inject({
      schema: SCHEMA,
      config: { ...CONFIG, override: { "workos/api-key": "NEXT_PUBLIC_WORKOS_KEY" } },
      values: [val("workos/api-key", "sk_live")],
      target: env,
    });
    expect(env.NEXT_PUBLIC_WORKOS_KEY).toBe("sk_live");
    expect(env.WORKOS_API_KEY).toBeUndefined();
  });

  it("writes the raw bytes, never the schema-coerced value", () => {
    const env = target();
    inject({
      schema: z.object({ port: z.coerce.number() }),
      config: CONFIG,
      values: [val("port", "5432")],
      target: env,
    });
    // process.env is strings; the SDK re-parses. A coerced `5432` here would be a bug.
    expect(env.PORT).toBe("5432");
  });

  it("refuses a collision before touching the target", () => {
    // Two declared parameters that generate one variable — first-write-wins would
    // drop one silently, so it throws before writing anything.
    const env = target();
    expect(() =>
      inject({
        schema: z.object({ apiKey: z.string(), api: z.object({ key: z.string() }) }),
        config: { ...CONFIG, override: { "api-key": "API_KEY", "api/key": "API_KEY" } },
        values: [val("api-key", "a"), val("api/key", "b")],
        target: env,
      }),
    ).toThrow();
    expect(Object.keys(env)).toEqual([]);
  });

  it("reports counts for a report to render", () => {
    const env = target({ WORKOS_API_HOSTNAME: "stale" });
    const result = inject({
      schema: SCHEMA,
      config: CONFIG,
      values: [val("database-url", "postgres://prod"), val("workos/api-key", "sk_live")],
      target: env,
    });
    expect(result).toEqual({ written: 2, deleted: 1 });
  });
});
