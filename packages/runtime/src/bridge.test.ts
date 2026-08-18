/**
 * The refusal the typed bridge is responsible for, and its copy.
 *
 * It is sealed in the PRD (friction item 10) because it is one of the two a
 * newcomer meets first: someone starting an adopted app the way they always
 * started it. The strings are asserted verbatim here, so changing them is a
 * deliberate act rather than a refactor's side effect.
 *
 * The *other* sealed refusal — a teammate who cloned and has not pulled — is
 * `penv run`'s now, not the bridge's, and its copy is asserted where it fires
 * (`cli/src/commands/run.test.ts`). The bridge validates the injected
 * environment and never opens a tree, so it cannot know whether an environment
 * has anywhere to pull *from*; `penv run` does, and it refuses before the
 * application starts at all.
 */

import { DirectStartError, ValidationError } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DELIVERY_VARIABLE, ENVIRONMENT_VARIABLE, RUN_MARKER, resetDelivery } from "./child-env.js";
import { load } from "./load.js";

const originalArgv = process.argv;
const originalMarker = process.env[RUN_MARKER];

const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({ host: z.string(), password: z.string().optional() }),
});

/**
 * A process nothing prepared, carrying one variable a shell happened to export.
 * `REDIS_PASSWORD` keeps the namespace present, so the schema reports the leaf
 * `redis.host` rather than the whole of `redis`.
 */
const AMBIENT: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgres://local/app",
  REDIS_PASSWORD: "hunter2",
};

/** The same values, in a process `penv run --env development` started. */
function started(variables: Readonly<Record<string, string>>): Record<string, string | undefined> {
  return {
    ...variables,
    [ENVIRONMENT_VARIABLE]: "development",
    [DELIVERY_VARIABLE]: JSON.stringify({
      "database-url": "DATABASE_URL",
      "redis.host": "REDIS_HOST",
      "redis.password": "REDIS_PASSWORD",
    }),
    [RUN_MARKER]: "penv run --env development -- node index.js",
  };
}

function loadFails(env: Record<string, string | undefined>): unknown {
  try {
    load(schema, { env, environment: "development" });
  } catch (error) {
    return error;
  }
  throw new Error("expected load to refuse");
}

afterEach(() => {
  resetDelivery();
  if (originalMarker === undefined) {
    delete process.env[RUN_MARKER];
  } else {
    process.env[RUN_MARKER] = originalMarker;
  }
  process.argv = originalArgv;
});

describe("a direct start, outside penv run", () => {
  /** Sealed copy: the missing parameter, and the exact `penv run --` shape. */
  it("names the missing parameter and the command to start it with", () => {
    process.argv = ["/usr/bin/node", "index.js"];
    const error = loadFails({ ...AMBIENT });

    expect(error).toBeInstanceOf(DirectStartError);
    const refusal = error as DirectStartError;
    expect(refusal.message.split("\n")[0]).toBe(
      "Missing required parameter redis.host for environment development, " +
        "and this process was not started by `penv run`",
    );
    expect(refusal.remedy).toBe("Start it with `penv run -- node index.js`.");
  });

  /** It is still the validation failure it always was, issues and all. */
  it("carries the schema issues, so nothing downstream loses them", () => {
    const error = loadFails({ ...AMBIENT });

    expect((error as DirectStartError).issues.map((issue) => issue.parameter)).toEqual([
      "redis.host",
    ]);
  });

  /**
   * Inside `penv run` the environment was prepared by penv, so a failure there is
   * about the values — telling that reader to use `penv run` would be telling
   * them to do what they just did.
   */
  it("is not what a process penv started hears", () => {
    const error = loadFails(started(AMBIENT));

    expect(error).not.toBeInstanceOf(DirectStartError);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toContain("does not match the schema");
  });

  /** A value the schema rejects is not a missing one, whoever started the process. */
  it("is not what an invalid value gets", () => {
    const error = loadFails({ DATABASE_URL: "not-a-url", REDIS_HOST: "127.0.0.1" });

    expect(error).not.toBeInstanceOf(DirectStartError);
  });

  /**
   * The negative case that keeps the refusal honest: an environment that
   * satisfies the schema is one penv has nothing to say about, however the
   * process was started.
   */
  it("is not what a complete environment gets", () => {
    expect(
      load(schema, { env: { DATABASE_URL: "postgres://local/app", REDIS_HOST: "127.0.0.1" } })
        .redis.host,
    ).toBe("127.0.0.1");
  });
});

describe("penv's own channels, from the application's side", () => {
  /**
   * The ordering the seal asks for, seen from the other end: a nested penv finds
   * the marker because it checks before anything loads, and the application never
   * does because loading is its first act. The delivery contract goes with it —
   * both are penv talking to penv.
   */
  it("are gone from the environment once the bridge has read them", () => {
    const env = started({ DATABASE_URL: "postgres://local/app", REDIS_HOST: "127.0.0.1" });

    load(schema, { env, environment: "development" });

    expect(env[RUN_MARKER]).toBeUndefined();
    expect(env[DELIVERY_VARIABLE]).toBeUndefined();
  });
});
