import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { checkGithubNames } from "./names.js";

const base: PenvConfig = {
  environments: ["production"],
  providers: { production: { type: "@penvhq/provider-filesystem" } },
};

function withNames(names: Record<string, string>): PenvConfig {
  return { ...base, names };
}

const ref = (name: string, namespace: readonly string[] = []): ParameterRef => ({
  namespace,
  name,
});

describe("checkGithubNames", () => {
  it("passes ordinary generated variables", () => {
    expect(checkGithubNames([ref("api-url"), ref("password", ["redis"])], base)).toEqual([]);
  });

  it("refuses a variable that GitHub reserves — githubToken → GITHUB_TOKEN", () => {
    const errors = checkGithubNames([ref("github-token")], base);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("reserved-prefix");
    expect(errors[0]?.variable).toBe("GITHUB_TOKEN");
    expect(errors[0]?.code).toBe("GITHUB_NAME");
  });

  it("refuses a leading digit — 1password → 1PASSWORD", () => {
    const errors = checkGithubNames([ref("1password")], base);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("leading-digit");
    expect(errors[0]?.variable).toBe("1PASSWORD");
  });

  it("refuses a name override that introduces an illegal character", () => {
    const errors = checkGithubNames([ref("api-key")], withNames({ "api-key": "API-KEY" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("charset");
    expect(errors[0]?.variable).toBe("API-KEY");
  });

  it("catches a case collision two overrides can express — the gap core cannot see", () => {
    const config = withNames({ a: "Foo", b: "foo" });
    const errors = checkGithubNames([ref("a"), ref("b")], config);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("case-collision");
    expect(errors[0]?.parameters).toEqual(["a", "b"]);
  });

  it("validates the override's output, not the parameter name", () => {
    // A fine parameter name whose override reaches GitHub verbatim and is reserved.
    const errors = checkGithubNames([ref("token")], withNames({ token: "GITHUB_TOKEN" }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe("reserved-prefix");
  });

  it("collects every offender at once, deterministically", () => {
    const errors = checkGithubNames([ref("github-token"), ref("1password")], base);
    expect(errors.map((error) => error.variable)).toEqual(["1PASSWORD", "GITHUB_TOKEN"]);
  });
});
