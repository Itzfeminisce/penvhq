/**
 * The scanner reads what `penv init` writes, and `penv init` writes a worked
 * example in a comment. Every fixture here is config text a real project has on
 * disk, not text written to suit the scanner.
 */

import { describe, expect, it } from "vitest";
import { readEnvironmentProviders, setEnvironmentProvider } from "./config-edit.js";

/** The scaffold `renderConfigModule` writes when no environment was named. */
const SCAFFOLD = `import { defineConfig } from "@penvhq/penv";

export default defineConfig({
  // Environments are a whitelist, and each entry is that environment's whole
  // declaration: which provider holds it, in that provider's own words, and
  // which key seals it. A segment is an environment only if it is named here.
  // It starts empty because which environments you deploy is not something penv
  // can read off your codebase, and an environment you do not have is worse
  // than one you have not declared yet. Name yours:
  //   environments: {
  //     development: "@penvhq/provider-filesystem",
  //     production: { provider: "@penvhq/provider-vault", path: "penv", keySource: "env" },
  //   },
  environments: {},

  schemaFile: "src/env.ts",
});
`;

const FILLED = SCAFFOLD.replace(
  "environments: {},",
  `environments: {
    development: "@penvhq/provider-filesystem",
    production: { provider: "@penvhq/provider-filesystem" },
  },`,
);

describe("reading the environments block", () => {
  it("reads nothing out of the example `penv init` writes in a comment", () => {
    expect(readEnvironmentProviders(SCAFFOLD)).toEqual([]);
  });

  it("reads the real entries past that comment, and never a sibling key", () => {
    expect(readEnvironmentProviders(FILLED)).toEqual([
      { environment: "development", provider: "@penvhq/provider-filesystem" },
      { environment: "production", provider: "@penvhq/provider-filesystem" },
    ]);
  });
});

describe("repointing one environment", () => {
  it("replaces the provider of the entry it was asked for", () => {
    const next = setEnvironmentProvider(FILLED, "production", "@penvhq/provider-vault");
    expect(next).toContain('production: { provider: "@penvhq/provider-vault" }');
    expect(next).toContain('development: "@penvhq/provider-filesystem"');
  });

  it("refuses a key that is not an environment, whatever the comment above says", () => {
    expect(
      setEnvironmentProvider(SCAFFOLD, "schemaFile", "@penvhq/provider-vault"),
    ).toBeUndefined();
    expect(
      setEnvironmentProvider(SCAFFOLD, "environments", "@penvhq/provider-vault"),
    ).toBeUndefined();
  });
});
