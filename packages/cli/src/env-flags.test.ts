/**
 * The environment shorthand rules, each with its firing and its quiet case: a
 * whitelisted bare flag names the environment, a real flag always wins, two
 * environment flags are a hard error, and a stranger flag is refused naming
 * what would have worked.
 */

import type { PenvConfig } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import {
  environmentFromShorthand,
  shadowedEnvironments,
  shorthandCandidates,
} from "./env-flags.js";

const CONFIG: PenvConfig = {
  environments: ["development", "staging", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    staging: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

describe("shorthandCandidates", () => {
  it("collects bare switches the command did not declare, and nothing else", () => {
    const args = {
      _: [],
      env: "production",
      yes: true,
      production: true,
      out: ".env",
      staging: false,
    };
    expect(shorthandCandidates(args, ["env", "yes", "out"])).toEqual(["production"]);
  });

  it("never surfaces a declared flag, so config cannot rebind one", () => {
    // An environment named `yes` collides with a real flag; the real flag wins
    // by construction — `yes` is in the declared set, so it is never a candidate.
    expect(shorthandCandidates({ _: [], yes: true }, ["env", "yes"])).toEqual([]);
  });
});

describe("environmentFromShorthand", () => {
  it("names the environment a whitelisted flag selects", () => {
    expect(environmentFromShorthand(CONFIG, ["production"], undefined)).toBe("production");
  });

  it("stays quiet when there is nothing to judge", () => {
    expect(environmentFromShorthand(CONFIG, [], undefined)).toBeUndefined();
  });

  it("hard-errors on two environment flags, never first-wins", () => {
    expect(() => environmentFromShorthand(CONFIG, ["production", "staging"], undefined)).toThrow(
      /name two environments at once/,
    );
  });

  it("hard-errors when a shorthand contradicts an explicit --env", () => {
    expect(() => environmentFromShorthand(CONFIG, ["staging"], "production")).toThrow(
      /--env production/,
    );
  });

  it("accepts a shorthand that agrees with --env", () => {
    expect(environmentFromShorthand(CONFIG, ["production"], "production")).toBe("production");
  });

  it("refuses a stranger flag, naming the environments that would have worked", () => {
    expect(() => environmentFromShorthand(CONFIG, ["prodction"], undefined)).toThrow(
      /--production/,
    );
  });
});

describe("shadowedEnvironments", () => {
  it("names an environment a real flag shadows", () => {
    const config: PenvConfig = {
      environments: ["yes", "production"],
      providers: {
        yes: { type: "@penvhq/provider-filesystem" },
        production: { type: "@penvhq/provider-filesystem" },
      },
    };
    expect(shadowedEnvironments(config)).toEqual(["yes"]);
  });

  it("stays quiet for ordinary names", () => {
    expect(shadowedEnvironments(CONFIG)).toEqual([]);
  });
});
