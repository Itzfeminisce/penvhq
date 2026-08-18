/**
 * The child environment `penv run` owns.
 *
 * Ownership is the claim under test, and it has four halves: a declared
 * parameter is written even over a value the shell already had, a declared
 * parameter the schema excuses and the tree does not hold is *deleted* rather
 * than left standing, an undeclared variable is untouched, and penv's own —
 * keys, provider credentials, control channels — never reach the child at all.
 *
 * The fifth is order. The marker is stamped after the strip, or the strip would
 * take it back out and a nested `penv run` would see nothing.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { childEnvironment, RUN_MARKER, strippedVariables } from "./child-env.js";

const CONFIG = {
  environments: ["development"],
  providers: { development: { type: "@penvhq/provider-filesystem" } },
};

const VAULT_CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-vault", location: "secret/app" },
  },
};

const schema = z.object({
  databaseUrl: z.string(),
  redis: z.object({ host: z.string(), password: z.string().optional() }),
});

const ref = (name: string, ...namespace: string[]) => ({ namespace, name });

const VALUES = [
  { ref: ref("database-url"), value: "postgres://local/app" },
  { ref: ref("host", "redis"), value: "127.0.0.1" },
];

function build(
  host: Record<string, string | undefined>,
  config: unknown = CONFIG,
  values = VALUES,
): ReturnType<typeof childEnvironment> {
  return childEnvironment({
    host,
    config: config as typeof CONFIG,
    environment: "development",
    schema,
    values,
    invocation: "penv run -- pnpm dev",
  });
}

describe("the variables penv declares", () => {
  it("writes every resolved parameter under its generated name", () => {
    const { env, written } = build({ PATH: "/usr/bin" });

    expect(env.DATABASE_URL).toBe("postgres://local/app");
    expect(env.REDIS_HOST).toBe("127.0.0.1");
    expect(written).toBe(2);
  });

  it("overwrites a value the host environment already had", () => {
    const { env } = build({ DATABASE_URL: "postgres://stale/app" });

    expect(env.DATABASE_URL).toBe("postgres://local/app");
  });

  /**
   * The deletion is the half a "merge my values in" implementation would miss:
   * `redis/password` is optional and absent, so a stale export must not stand in
   * for the value penv resolved to nothing.
   */
  it("deletes an optional parameter the tree has no value for", () => {
    const { env, deleted } = build({ REDIS_PASSWORD: "left-over-from-yesterday" });

    expect(env.REDIS_PASSWORD).toBeUndefined();
    expect(deleted).toBe(1);
  });

  it("leaves a variable the schema never declared exactly as it was", () => {
    const { env } = build({ PATH: "/usr/bin", HOME: "/home/dev", TERM: "xterm" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.TERM).toBe("xterm");
  });

  it("writes a schema default the tree did not set", () => {
    const withDefault = z.object({ region: z.string().default("us-east-1") });
    const { env } = childEnvironment({
      host: {},
      config: CONFIG,
      environment: "development",
      schema: withDefault,
      values: [],
      validated: { region: "us-east-1" },
      invocation: "penv run -- node index.js",
    });

    expect(env.REGION).toBe("us-east-1");
  });
});

describe("the variables penv strips", () => {
  it("removes exported key material", () => {
    const { env, stripped } = build({ PENV_KEY_DEV: "not-for-the-app", PATH: "/usr/bin" });

    expect(env.PENV_KEY_DEV).toBeUndefined();
    expect(stripped).toContain("PENV_KEY_DEV");
  });

  it("removes the credentials of a provider the config declares", () => {
    const { env } = build({ VAULT_TOKEN: "hvs.abc", VAULT_ADDR: "https://vault" }, VAULT_CONFIG);

    expect(env.VAULT_TOKEN).toBeUndefined();
    expect(env.VAULT_ADDR).toBeUndefined();
  });

  /** The negative case: a project that never names Vault keeps its own `VAULT_TOKEN`. */
  it("leaves those same variables alone when no provider declares them", () => {
    const { env } = build({ VAULT_TOKEN: "the-app-talks-to-vault-itself" });

    expect(env.VAULT_TOKEN).toBe("the-app-talks-to-vault-itself");
  });

  it("removes penv's internal control variables", () => {
    const { env } = build({ PENV_SCHEMA_HARVEST: "1", PENV_SNAPSHOT: "/tmp/artifact.json" });

    expect(env.PENV_SCHEMA_HARVEST).toBeUndefined();
    expect(env.PENV_SNAPSHOT).toBeUndefined();
  });

  it("names what it would strip without needing the host to carry it", () => {
    expect(strippedVariables({}, VAULT_CONFIG)).toContain("VAULT_TOKEN");
    expect(strippedVariables({}, CONFIG)).not.toContain("VAULT_TOKEN");
  });
});

describe("the run marker", () => {
  it("carries this invocation, so a nested run can name the wrapper", () => {
    const { env } = build({});

    expect(env[RUN_MARKER]).toBe("penv run -- pnpm dev");
  });

  /**
   * The ordering seal. An inherited marker is stripped with the rest of penv's
   * variables and the new one stamped after — so the child never carries a stale
   * outer invocation, and the strip never eats the marker this run just set.
   */
  it("replaces an inherited marker rather than keeping or losing it", () => {
    const { env } = build({ [RUN_MARKER]: "penv run -- an-older-wrapper" });

    expect(env[RUN_MARKER]).toBe("penv run -- pnpm dev");
  });

  it("pins the environment penv resolved", () => {
    const { env } = build({ PENV_ENV: "production" });

    expect(env.PENV_ENV).toBe("development");
  });
});
