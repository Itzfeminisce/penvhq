import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { checkVercelNames } from "./names.js";

const CONFIG: PenvConfig = { environments: ["production"], providers: {} };

function ref(namespace: readonly string[], name: string): ParameterRef {
  return { namespace, name };
}

describe("checkVercelNames", () => {
  it("passes the names penv normally generates", () => {
    expect(checkVercelNames([ref([], "api-key"), ref(["redis"], "password")], CONFIG)).toEqual([]);
  });

  it("refuses an overridden name outside Vercel's charset, naming the override block", () => {
    const config: PenvConfig = { ...CONFIG, override: { "api-key": "API-KEY" } };
    const [error] = checkVercelNames([ref([], "api-key")], config);
    expect(error?.reason).toBe("charset");
    expect(error?.variable).toBe("API-KEY");
    expect(error?.parameters).toEqual(["api-key"]);
    expect(error?.remedy).toMatch(/override/);
  });

  it("refuses a name longer than Vercel's 256 characters", () => {
    const config: PenvConfig = { ...CONFIG, override: { "api-key": "A".repeat(257) } };
    const [error] = checkVercelNames([ref([], "api-key")], config);
    expect(error?.reason).toBe("length");
  });

  it("accepts a name of exactly 256 characters", () => {
    const config: PenvConfig = { ...CONFIG, override: { "api-key": "A".repeat(256) } };
    expect(checkVercelNames([ref([], "api-key")], config)).toEqual([]);
  });

  it("keeps names that differ only in case apart — Vercel keys are case-sensitive", () => {
    const config: PenvConfig = { ...CONFIG, override: { "api-key": "TOKEN", token: "token" } };
    expect(checkVercelNames([ref([], "api-key"), ref([], "token")], config)).toEqual([]);
  });

  it("collects every violation at once, in variable order", () => {
    const config: PenvConfig = {
      ...CONFIG,
      override: { "api-key": "B-BAD", token: "A-BAD" },
    };
    const errors = checkVercelNames([ref([], "api-key"), ref([], "token")], config);
    expect(errors.map((error) => error.variable)).toEqual(["A-BAD", "B-BAD"]);
  });
});
