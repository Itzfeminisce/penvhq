import { describe, expect, it } from "vitest";
import { validateConfig } from "./config.js";
import { validateSinks } from "./sinks.js";
import type { PenvConfig } from "./types.js";

const base: PenvConfig = {
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
};

const declared: ReadonlySet<string> = new Set(["development", "production"]);

/** Casts once so a case can hand `validateSinks` the malformed config a user could write. */
function withSinks(sinks: unknown): PenvConfig {
  return { ...base, sinks } as PenvConfig;
}

describe("validateSinks", () => {
  it("accepts an absent sinks block", () => {
    expect(validateSinks(base, declared)).toEqual([]);
  });

  it("accepts a well-formed github sink", () => {
    expect(validateSinks(withSinks({ production: { type: "github" } }), declared)).toEqual([]);
  });

  it("accepts a sink that names a repo", () => {
    expect(
      validateSinks(withSinks({ production: { type: "github", repo: "org/app" } }), declared),
    ).toEqual([]);
  });

  it("rejects a sinks block that is not an object", () => {
    const errors = validateSinks(withSinks([]), declared);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CONFIG");
  });

  it("rejects a sink for an undeclared environment", () => {
    const errors = validateSinks(withSinks({ staging: { type: "github" } }), declared);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("staging");
  });

  it("rejects a sink entry that is not an object", () => {
    const errors = validateSinks(withSinks({ production: "github" }), declared);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("not a sink object");
  });

  it("rejects a sink with no type", () => {
    const errors = validateSinks(withSinks({ production: {} }), declared);
    expect(errors[0]?.message).toContain("no `type`");
  });

  it("rejects a non-string repo", () => {
    const errors = validateSinks(withSinks({ production: { type: "github", repo: 5 } }), declared);
    expect(errors[0]?.message).toContain("repo");
  });

  it("collects every problem in one pass", () => {
    const errors = validateSinks(
      withSinks({ production: {}, staging: { type: "github" } }),
      declared,
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateSinks wired into validateConfig", () => {
  it("surfaces a malformed sink through the whole-config check", () => {
    const config = withSinks({ production: { type: "" } });
    expect(validateConfig(config).some((error) => error.message.includes("no `type`"))).toBe(true);
  });

  it("leaves a valid config with a sink error-free", () => {
    expect(validateConfig(withSinks({ production: { type: "github" } }))).toEqual([]);
  });
});
