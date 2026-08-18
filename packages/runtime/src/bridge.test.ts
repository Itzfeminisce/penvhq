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

import { DeliveryContractMissingError, DirectStartError, ValidationError } from "@penvhq/core";
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
      load(schema, { env: { DATABASE_URL: "postgres://local/app", REDIS_HOST: "127.0.0.1" } }).redis
        .host,
    ).toBe("127.0.0.1");
  });
});

/**
 * The platform case: values in `process.env`, `PENV_ENV` set by hand, and no
 * contract — so penv reads the default generated name and an `override` has bent
 * it somewhere else. The two variables are written one line apart by `penv run`,
 * so one without the other is the finding.
 */
describe("an environment a platform delivered, with no contract", () => {
  const PLATFORM = { ...AMBIENT, [ENVIRONMENT_VARIABLE]: "development" };

  it("names the variable penv read and points at PENV_DELIVERY", () => {
    const error = loadFails({ ...PLATFORM });

    expect(error).toBeInstanceOf(DeliveryContractMissingError);
    const refusal = error as DeliveryContractMissingError;
    expect(refusal.parameter).toBe("redis.host");
    expect(refusal.variable).toBe("REDIS_HOST");
    expect(refusal.summary).toBe(
      "Missing required parameter redis.host for environment development: penv read REDIS_HOST, " +
        "and this process carries PENV_ENV without the PENV_DELIVERY map that goes with it",
    );
    expect(refusal.remedy).toContain("Set PENV_DELIVERY beside the values");
    expect(refusal.remedy).toContain(
      'penv run --env development -- node -e "console.log(process.env.PENV_DELIVERY)"',
    );
  });

  /**
   * The quiet half. Under `penv run` the contract is always there, so this copy
   * must never reach the reader who did start penv properly — they would be told
   * to set a variable penv had just set for them.
   */
  it("is not what a process penv started hears", () => {
    const error = loadFails(started(AMBIENT));

    expect(error).not.toBeInstanceOf(DeliveryContractMissingError);
    expect(error).toBeInstanceOf(ValidationError);
  });

  /** Nor a plain direct start: nothing pinned an environment, so nothing delivered one. */
  it("is not what a direct start hears", () => {
    const error = loadFails({ ...AMBIENT });

    expect(error).not.toBeInstanceOf(DeliveryContractMissingError);
    expect(error).toBeInstanceOf(DirectStartError);
  });
});

/**
 * penv cannot own the application's exception handler, so it owns the error. A
 * default uncaught-exception print shows `stack`, and what that must open with
 * is the refusal itself.
 */
describe("what an uncaught bridge refusal prints", () => {
  it("opens with the message and the arrowed remedy", () => {
    process.argv = ["/usr/bin/node", "index.js"];
    const refusal = loadFails({ ...AMBIENT }) as DirectStartError;

    expect(refusal.stack?.startsWith(`DirectStartError: ${refusal.summary}`)).toBe(true);
    expect(refusal.stack).toContain(`\n  → ${refusal.remedy}`);
    expect(String(refusal)).toBe(`DirectStartError: ${refusal.summary}\n  → ${refusal.remedy}`);
  });

  it("keeps the caller's frames and drops penv's own", () => {
    const refusal = loadFails({ ...AMBIENT }) as DirectStartError;
    const frames = (refusal.stack ?? "")
      .split("\n")
      .filter((line) => line.trim().startsWith("at "));

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => /load\.ts/.test(frame))).toBe(false);
    expect(frames[0]).toContain("bridge.test.ts");
  });

  /** A schema failure inside `penv run` is the same error object, formatted the same way. */
  it("formats the plain validation refusal identically", () => {
    const refusal = loadFails(started(AMBIENT)) as ValidationError;

    expect(refusal.stack?.startsWith(`ValidationError: ${refusal.summary}`)).toBe(true);
    expect(refusal.stack).toContain(`\n  → ${refusal.remedy}`);
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
