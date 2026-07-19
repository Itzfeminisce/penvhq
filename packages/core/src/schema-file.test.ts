/**
 * The schema's location is a committed fact: `penv.config.ts` is checked in, so
 * a path that only resolves on the machine that wrote it resolves nowhere else.
 * These tests are mostly about the paths penv refuses, because the default is
 * the easy case and the refusals are what keep a config portable.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMA_FILE,
  isPublicVariable,
  schemaFileOf,
  schemaInsideTree,
  validatePublicPrefixes,
  validateSchemaFile,
} from "./schema-file.js";
import type { PenvConfig } from "./types.js";

const base: PenvConfig = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

function withSchema(schemaFile: string): PenvConfig {
  return { ...base, schemaFile };
}

describe("schemaFileOf", () => {
  it("answers the default when the project does not say", () => {
    expect(schemaFileOf(base)).toBe(DEFAULT_SCHEMA_FILE);
    expect(DEFAULT_SCHEMA_FILE).toBe(".penv/env.ts");
  });

  it("answers the declared path", () => {
    expect(schemaFileOf(withSchema("src/env.ts"))).toBe("src/env.ts");
  });

  /** A config written on Windows has to mean the same thing on a Linux runner. */
  it("reads a backslash path as the POSIX path it means", () => {
    expect(schemaFileOf(withSchema("src\\lib\\env.ts"))).toBe("src/lib/env.ts");
  });

  it("treats a blank path as unsaid rather than as a path to nowhere", () => {
    expect(schemaFileOf(withSchema("   "))).toBe(DEFAULT_SCHEMA_FILE);
  });
});

/**
 * The grammar reads every file in the tree as a parameter, so a schema inside
 * the tree must be excluded by name. A schema outside it has nothing to exclude
 * — which is the quiet argument for moving it out.
 */
describe("schemaInsideTree", () => {
  it("names the schema's path within the tree when it lives there", () => {
    expect(schemaInsideTree(base)).toBe("env.ts");
    expect(schemaInsideTree(withSchema(".penv/schema.ts"))).toBe("schema.ts");
  });

  it("answers undefined when the schema lives outside the tree", () => {
    expect(schemaInsideTree(withSchema("src/env.ts"))).toBeUndefined();
    expect(schemaInsideTree(withSchema("env.ts"))).toBeUndefined();
  });

  /** `.penv-old/env.ts` is not in `.penv/`, and a prefix match would say it was. */
  it("does not mistake a directory that merely starts with .penv", () => {
    expect(schemaInsideTree(withSchema(".penv-old/env.ts"))).toBeUndefined();
  });
});

describe("validateSchemaFile", () => {
  it("accepts a relative path inside the project", () => {
    expect(validateSchemaFile(withSchema("src/env.ts"))).toEqual([]);
    expect(validateSchemaFile(withSchema(".penv/env.ts"))).toEqual([]);
    expect(validateSchemaFile(base)).toEqual([]);
  });

  /** The config is committed, so an absolute path is one machine's answer. */
  it("refuses an absolute path", () => {
    for (const path of ["/home/me/app/src/env.ts", "C:/Users/me/app/src/env.ts"]) {
      const errors = validateSchemaFile(withSchema(path));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/absolute path/);
    }
  });

  it("refuses a path that reaches outside the project", () => {
    const errors = validateSchemaFile(withSchema("../shared/env.ts"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/outside the project/);
  });

  it("refuses a file penv cannot evaluate", () => {
    const errors = validateSchemaFile(withSchema("src/env.json"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/cannot evaluate/);
  });

  it("accepts every extension penv evaluates", () => {
    for (const path of ["src/env.ts", "src/env.js", "src/env.mjs"]) {
      expect(validateSchemaFile(withSchema(path))).toEqual([]);
    }
  });

  /** Collected, not thrown: one run reports the whole config. */
  it("collects every problem with one path", () => {
    const errors = validateSchemaFile(withSchema("/etc/../env.json"));
    expect(errors.length).toBeGreaterThan(1);
  });

  it("refuses a non-string", () => {
    const errors = validateSchemaFile({ ...base, schemaFile: 42 } as unknown as PenvConfig);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/is not a path/);
  });
});

/**
 * A typo here is silent in the worst direction: `NEXT_PUBIC_` matches nothing,
 * so the check that exists to catch a secret reaching a browser passes without
 * ever having looked.
 */
describe("validatePublicPrefixes", () => {
  it("accepts the prefixes real frameworks use", () => {
    expect(validatePublicPrefixes({ ...base, publicPrefixes: ["NEXT_PUBLIC_"] })).toEqual([]);
    expect(validatePublicPrefixes({ ...base, publicPrefixes: ["VITE_", "PUBLIC_"] })).toEqual([]);
  });

  it("accepts a project that declares none", () => {
    expect(validatePublicPrefixes(base)).toEqual([]);
  });

  it("refuses a prefix that does not end in an underscore", () => {
    const errors = validatePublicPrefixes({ ...base, publicPrefixes: ["NEXT_PUBLIC"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/is not a variable prefix/);
  });

  it("refuses a lower-case prefix, which no generated variable can match", () => {
    expect(validatePublicPrefixes({ ...base, publicPrefixes: ["next_public_"] })).toHaveLength(1);
  });

  it("refuses a non-array", () => {
    const errors = validatePublicPrefixes({
      ...base,
      publicPrefixes: "NEXT_PUBLIC_",
    } as unknown as PenvConfig);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/is not an array/);
  });

  it("reports every bad prefix rather than the first", () => {
    expect(
      validatePublicPrefixes({ ...base, publicPrefixes: ["bad", "alsobad", "NEXT_PUBLIC_"] }),
    ).toHaveLength(2);
  });
});

describe("isPublicVariable", () => {
  const config: PenvConfig = { ...base, publicPrefixes: ["NEXT_PUBLIC_", "VITE_"] };

  it("recognises a variable a declared prefix would put in a browser", () => {
    expect(isPublicVariable("NEXT_PUBLIC_LANDING_ORIGIN", config)).toBe(true);
    expect(isPublicVariable("VITE_API_URL", config)).toBe(true);
  });

  it("leaves a variable no prefix matches alone", () => {
    expect(isPublicVariable("DATABASE_URL", config)).toBe(false);
  });

  /**
   * A project that declared no prefixes has told penv nothing, so nothing is
   * public *as far as penv knows* — which is why the caller has to say it cannot
   * tell rather than reporting a clean check.
   */
  it("answers false for every variable when no prefix is declared", () => {
    expect(isPublicVariable("NEXT_PUBLIC_LANDING_ORIGIN", base)).toBe(false);
  });
});
