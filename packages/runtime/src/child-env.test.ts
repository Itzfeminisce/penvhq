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

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DeclaredCredentials } from "./child-env.js";
import {
  childEnvironment,
  DELIVERY_VARIABLE,
  ENVIRONMENT_VARIABLE,
  LAUNCHER_HOME,
  RUN_MARKER,
  strippedVariables,
} from "./child-env.js";

const CONFIG = {
  environments: { development: "@penvhq/provider-filesystem" },
};

const VAULT_CONFIG = {
  environments: {
    development: "@penvhq/provider-filesystem",
    production: { provider: "@penvhq/provider-vault", path: "secret/app" },
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
  credentials?: DeclaredCredentials,
): ReturnType<typeof childEnvironment> {
  return childEnvironment({
    host,
    config: config as typeof CONFIG,
    environment: "development",
    schema,
    values,
    ...(credentials === undefined ? {} : { credentials }),
    invocation: "penv run -- pnpm dev",
  });
}

const originalPlatform = process.platform;

/** The platform whose environment-name rules apply, so both are tested on either. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Every spelling of one variable the child carries — the question Windows asks. */
function spellings(env: Readonly<Record<string, string>>, name: string): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
}

afterEach(() => {
  onPlatform(originalPlatform);
});

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

  it("removes the launcher's own PENV_HOME", () => {
    const { env, stripped } = build({ [LAUNCHER_HOME]: "/home/dev/.penv", PATH: "/usr/bin" });

    expect(env[LAUNCHER_HOME]).toBeUndefined();
    expect(stripped).toContain(LAUNCHER_HOME);
  });

  /**
   * The quiet half of the same claim. Three variables are the deliberate control
   * channel and each has a reader — the bridge takes the delivery contract and
   * the marker back out itself, and a nested `penv run` needs the marker to see
   * the wrapper it is inside.
   */
  it("keeps the three channels a reader downstream depends on", () => {
    const { env } = build({ [LAUNCHER_HOME]: "/home/dev/.penv" });

    expect(env[ENVIRONMENT_VARIABLE]).toBe("development");
    expect(JSON.parse(env[DELIVERY_VARIABLE] ?? "")).toMatchObject({
      "database-url": "DATABASE_URL",
    });
    expect(env[RUN_MARKER]).toBe("penv run -- pnpm dev");
  });

  it("names what it would strip without needing the host to carry it", () => {
    expect(strippedVariables({}, VAULT_CONFIG)).toContain("VAULT_TOKEN");
    expect(strippedVariables({}, CONFIG)).not.toContain("VAULT_TOKEN");
    expect(strippedVariables({}, CONFIG)).toContain(LAUNCHER_HOME);
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

/**
 * Windows' environment block matches names case-insensitively, so `Database_Url`
 * and `DATABASE_URL` are one variable there and two on POSIX. Every case below
 * is asserted on both platforms, because getting one right by losing the other
 * is not a fix: a delete that misses hands the child a stale value, and a delete
 * that over-reaches removes a variable a POSIX application legitimately owns.
 */
describe("names, as the platform reads them", () => {
  it("strips an inherited key whatever case the host spelled it in", () => {
    onPlatform("win32");
    const { env, stripped } = build({ penv_key_prod: "not-for-the-app", PATH: "/usr/bin" });

    expect(spellings(env, "PENV_KEY_PROD")).toEqual([]);
    expect(stripped).toContain("penv_key_prod");
  });

  it("leaves that same spelling alone where names are exact", () => {
    onPlatform("linux");
    const { env } = build({ penv_key_prod: "an-application-variable" });

    expect(env.penv_key_prod).toBe("an-application-variable");
  });

  /** The optional-absent delete, which is the half a case-sensitive match misses. */
  it("deletes a valueless parameter under the spelling the host used", () => {
    onPlatform("win32");
    const { env, deleted } = build({ Redis_Password: "left-over-from-yesterday" });

    expect(spellings(env, "REDIS_PASSWORD")).toEqual([]);
    expect(deleted).toBe(1);
  });

  it("keeps a differently-cased variable where names are exact", () => {
    onPlatform("linux");
    const { env, deleted } = build({ Redis_Password: "an-application-variable" });

    expect(env.Redis_Password).toBe("an-application-variable");
    expect(deleted).toBe(0);
  });

  it("overwrites a resolved parameter once, not beside itself", () => {
    onPlatform("win32");
    const { env } = build({ Database_Url: "postgres://stale/app" });

    expect(spellings(env, "DATABASE_URL")).toEqual(["Database_Url"]);
    expect(env.Database_Url).toBe("postgres://local/app");
  });

  it("strips a declared provider's credentials whatever case they arrived in", () => {
    onPlatform("win32");
    const { env } = build({ Vault_Token: "hvs.abc", vault_addr: "https://vault" }, VAULT_CONFIG);

    expect(spellings(env, "VAULT_TOKEN")).toEqual([]);
    expect(spellings(env, "VAULT_ADDR")).toEqual([]);
  });

  it("takes back an inherited control channel and stamps its own once", () => {
    onPlatform("win32");
    const { env } = build({
      Penv_Run: "penv run -- an-older-wrapper",
      penv_delivery: '{"stale":"CONTRACT"}',
      Penv_Snapshot: "/tmp/artifact.json",
    });

    expect(spellings(env, "PENV_SNAPSHOT")).toEqual([]);
    expect(spellings(env, "PENV_RUN")).toEqual(["PENV_RUN"]);
    expect(env.PENV_RUN).toBe("penv run -- pnpm dev");
    expect(spellings(env, "PENV_DELIVERY")).toEqual(["PENV_DELIVERY"]);
    expect(JSON.parse(env.PENV_DELIVERY ?? "{}")).toMatchObject({
      "database-url": "DATABASE_URL",
    });
  });
});

/**
 * A stranger's credentials are the ones penv cannot know, so the extension names
 * them itself and penv strips exactly what was named — no more, which is the
 * half that matters to an application legitimately reading a variable that
 * happens to start with the same word.
 */
describe("an extension's declared credentials", () => {
  const CONSUL_CONFIG = {
    environments: {
      development: "@penvhq/provider-filesystem",
      production: "@acme/provider-consul",
    },
  };

  const DECLARED: DeclaredCredentials = { "@acme/provider-consul": ["CONSUL_HTTP_TOKEN"] };

  it("never reach the child", () => {
    const { env } = build(
      { CONSUL_HTTP_TOKEN: "for-penv-to-authenticate-with" },
      CONSUL_CONFIG,
      VALUES,
      DECLARED,
    );

    expect(env.CONSUL_HTTP_TOKEN).toBeUndefined();
  });

  it("are the only ones taken — a variable it did not declare survives", () => {
    const { env } = build(
      { CONSUL_HTTP_ADDR: "http://consul:8500", UNRELATED: "kept" },
      CONSUL_CONFIG,
      VALUES,
      DECLARED,
    );

    expect(env.CONSUL_HTTP_ADDR).toBe("http://consul:8500");
    expect(env.UNRELATED).toBe("kept");
  });

  it("are absent when the extension declares none, and the first-party four still are not", () => {
    const { env } = build({ CONSUL_HTTP_TOKEN: "undeclared" }, CONSUL_CONFIG);

    expect(env.CONSUL_HTTP_TOKEN).toBe("undeclared");
    expect(strippedVariables({}, VAULT_CONFIG)).toContain("VAULT_TOKEN");
  });
});

/**
 * The control stamp runs last and wins, so a parameter that generated one of
 * penv's own names would be written by the injection, overwritten a line later,
 * and still claimed as delivered by the contract. It is refused instead.
 */
describe("a parameter in penv's own namespace", () => {
  const reserved = z.object({ penvRun: z.string() });
  const nearby = z.object({ penvRunner: z.string() });

  const withSchema = (shape: z.ZodType, name: string): ReturnType<typeof childEnvironment> =>
    childEnvironment({
      host: {},
      config: CONFIG,
      environment: "development",
      schema: shape,
      values: [{ ref: ref(name), value: "a-value" }],
      invocation: "penv run -- pnpm dev",
    });

  it("is refused before anything is written", () => {
    expect(() => withSchema(reserved, "penv-run")).toThrowError(
      expect.objectContaining({ code: "DELIVERY_NAME_RESERVED" }),
    );
  });

  it("is only the exact names — a parameter beside one is delivered", () => {
    expect(withSchema(nearby, "penv-runner").env.PENV_RUNNER).toBe("a-value");
  });
});
