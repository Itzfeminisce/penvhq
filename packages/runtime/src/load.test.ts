/**
 * The typed bridge, as PRD §4 defines it: `load` validates the environment
 * `penv run` injected, and nothing else.
 *
 * Every fixture here is an environment, never a tree. That is the property under
 * test — a container started from a sealed artifact has no `penv.config.ts`, no
 * records and no key, and the bridge must not want any of them. So the tests
 * hand `load` a plain object and assert it reads, validates, and refuses off
 * that alone.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NameCollisionError,
  recordsDir,
  SCHEMA_HARVEST_ENV,
  ValidationError,
} from "@penvhq/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DELIVERY_VARIABLE, ENVIRONMENT_VARIABLE, RUN_MARKER, resetDelivery } from "./child-env.js";
import { load } from "./load.js";

const created: string[] = [];
const originalHarvest = process.env.PENV_SCHEMA_HARVEST;
const originalDebug = process.env.PENV_DEBUG;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({
    host: z.string(),
    password: z.string().optional(),
  }),
});

/** The invocation `penv run` stamps, which is what makes a process penv-started. */
const INVOCATION = "penv run --env development -- node index.js";

/**
 * The environment a `penv run --env development -- …` wrote: the values under
 * their generated names, the environment it resolved, the delivery contract, and
 * the marker. Exactly the four things a child is handed.
 */
function injected(
  variables: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin",
    [ENVIRONMENT_VARIABLE]: "development",
    [DELIVERY_VARIABLE]: JSON.stringify({
      "database-url": "DATABASE_URL",
      "redis.host": "REDIS_HOST",
      "redis.password": "REDIS_PASSWORD",
    }),
    [RUN_MARKER]: INVOCATION,
    ...variables,
    ...extra,
  };
}

const COMPLETE: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgres://default/app",
  REDIS_HOST: "127.0.0.1",
};

afterEach(() => {
  resetDelivery();
  setEnv("PENV_SCHEMA_HARVEST", originalHarvest);
  setEnv("PENV_DEBUG", originalDebug);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("load", () => {
  it("validates and returns the environment it was handed", () => {
    const env = load(schema, { env: injected(COMPLETE) });

    expect(env.databaseUrl).toBe("postgres://default/app");
    expect(env.redis.host).toBe("127.0.0.1");
  });

  it("reads a nested namespace as a nested object", () => {
    const env = load(schema, { env: injected({ ...COMPLETE, REDIS_PASSWORD: "prod-secret" }) });

    expect(env.redis).toEqual({ host: "127.0.0.1", password: "prod-secret" });
  });

  it("leaves an optional parameter undefined rather than crashing", () => {
    expect(load(schema, { env: injected(COMPLETE) }).redis.password).toBeUndefined();
  });

  /**
   * The one thing the bridge cannot work out for itself. `override` in
   * `penv.config.ts` bends a variable's name, the config never reaches the
   * container, so `penv run` writes the map down and this reads it back.
   */
  it("reads a renamed variable from the contract penv run wrote", () => {
    const env = load(schema, {
      env: {
        [ENVIRONMENT_VARIABLE]: "development",
        [DELIVERY_VARIABLE]: JSON.stringify({
          "database-url": "PGURL",
          "redis.host": "REDIS_HOST",
        }),
        [RUN_MARKER]: INVOCATION,
        PGURL: "postgres://renamed/app",
        REDIS_HOST: "127.0.0.1",
        // The default name is present and holds something else: the contract is
        // what decides, not the transform, or the rename would be silently ignored.
        DATABASE_URL: "postgres://wrong/app",
      },
    });

    expect(env.databaseUrl).toBe("postgres://renamed/app");
  });

  /**
   * The contract is penv's own channel, written one line before it is read, so a
   * contract that is not one was tampered with. What makes the refusal worth
   * testing twice is that reading it *consumes* it: a refusal that only fired
   * once would leave the second `load` with no contract at all, guessing the
   * default names and delivering whatever variable happened to match — the one
   * outcome this channel exists to prevent.
   */
  describe("a delivery contract that is not the one penv writes", () => {
    const refuses = (contract: string): void => {
      const env = { ...injected(COMPLETE), [DELIVERY_VARIABLE]: contract };

      expect(() => load(schema, { env })).toThrowError(
        expect.objectContaining({ code: "DELIVERY_CONTRACT_INVALID" }),
      );
    };

    it("is refused when it is not JSON", () => {
      refuses("not json");
    });

    it("is refused when it is a JSON array", () => {
      refuses('["database-url"]');
    });

    it("is refused when a mapping is not a variable name", () => {
      refuses('{"database-url":42}');
    });

    it("is refused again on the next load, not silently guessed", () => {
      const env = { ...injected(COMPLETE), [DELIVERY_VARIABLE]: "not json" };

      expect(() => load(schema, { env })).toThrowError(
        expect.objectContaining({ code: "DELIVERY_CONTRACT_INVALID" }),
      );
      expect(() => load(schema, { env })).toThrowError(
        expect.objectContaining({ code: "DELIVERY_CONTRACT_INVALID" }),
      );
    });

    it("stays quiet for the contract penv actually writes, read twice", () => {
      const env = injected(COMPLETE);

      expect(load(schema, { env }).databaseUrl).toBe("postgres://default/app");
      expect(load(schema, { env }).databaseUrl).toBe("postgres://default/app");
    });
  });

  /**
   * A contract names variables, and `constructor` is a variable name like any
   * other — read through the prototype it would deliver a function to the schema.
   */
  it("reads a delivered variable off the environment's own keys", () => {
    const optional = z.object({ databaseUrl: z.string().optional() });
    const env = {
      [ENVIRONMENT_VARIABLE]: "development",
      [DELIVERY_VARIABLE]: JSON.stringify({ "database-url": "constructor" }),
      [RUN_MARKER]: INVOCATION,
    };

    expect(load(optional, { env }).databaseUrl).toBeUndefined();
  });

  /**
   * The container property, stated directly: no config file, no records tree, no
   * key — and a full environment is still all `load` needs.
   */
  it("opens nothing on disk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "penv-container-"));
    created.push(cwd);
    const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    try {
      expect(load(schema, { env: injected(COMPLETE) }).databaseUrl).toBe("postgres://default/app");
    } finally {
      spy.mockRestore();
    }
  });

  describe("validation", () => {
    it("throws ValidationError naming the parameter and the environment", () => {
      let thrown: unknown;
      try {
        load(schema, {
          env: injected({ ...COMPLETE, DATABASE_URL: "not-a-url" }),
          environment: "production",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ValidationError);
      const error = thrown as ValidationError;
      expect(error.environment).toBe("production");
      expect(error.issues.map((issue) => issue.parameter)).toEqual(["databaseUrl"]);
    });

    it("surfaces a variable the run deleted as a missing required parameter", () => {
      // `penv run` deletes a declared variable it resolved to nothing, so the
      // schema sees an absence rather than a stale value from the shell.
      // `REDIS_PASSWORD` keeps the namespace present, so the issue names the
      // leaf `redis.host` rather than the whole of `redis`.
      const { REDIS_HOST: _deleted, ...withoutHost } = COMPLETE;

      let thrown: unknown;
      try {
        load(schema, { env: injected({ ...withoutHost, REDIS_PASSWORD: "hunter2" }) });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError).issues.map((issue) => issue.parameter)).toEqual([
        "redis.host",
      ]);
    });
  });

  describe("the environment a refusal names", () => {
    it("is the one penv run pinned", () => {
      const env = {
        ...injected({ ...COMPLETE, DATABASE_URL: "not-a-url" }),
        [ENVIRONMENT_VARIABLE]: "production",
      };

      expect(() => load(schema, { env })).toThrowError(/environment production/);
    });

    it("falls back to NODE_ENV in a process penv did not start", () => {
      expect(() =>
        load(schema, { env: { NODE_ENV: "staging", DATABASE_URL: "not-a-url" } }),
      ).toThrowError(/environment staging/);
    });
  });

  describe("the penv/config compat entry", () => {
    /** Imports the side-effecting compat module fresh, rooted at `cwd`. */
    async function importCompat(cwd: string): Promise<void> {
      vi.resetModules();
      const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        await import("./config.js");
      } finally {
        spy.mockRestore();
      }
    }

    function makeTree(files: Readonly<Record<string, string>>): string {
      const root = mkdtempSync(join(tmpdir(), "penv-compat-"));
      created.push(root);
      writeFileSync(
        join(root, "penv.config.ts"),
        `export default ${JSON.stringify({
          environments: { development: "@penvhq/provider-filesystem" },
        })};\n`,
        "utf8",
      );
      for (const [name, value] of Object.entries(files)) {
        const file = join(recordsDir(root), name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, value, "utf8");
      }
      return root;
    }

    it("throws NameCollisionError rather than silently dropping a parameter", async () => {
      // Both files map to REDIS_PASSWORD. First-write-wins would boot the
      // process with one of them and say nothing — invariant 12.
      const cwd = makeTree({
        "redis/password": "from-namespaced",
        "redis-password": "from-flat",
      });
      setEnv("PENV_ENV", "development");
      const before = process.env.REDIS_PASSWORD;

      let thrown: unknown;
      try {
        await importCompat(cwd);
      } catch (error) {
        thrown = error;
      } finally {
        setEnv("PENV_ENV", undefined);
      }

      // `vi.resetModules()` gives the compat module its own copy of @penvhq/core,
      // so the thrown class is not identity-equal to the one imported here.
      // Assert the contract the caller actually sees instead.
      const error = thrown as NameCollisionError;
      expect(error.name).toBe("NameCollisionError");
      expect(error.variable).toBe("REDIS_PASSWORD");

      // Nothing is populated when the tree is ambiguous.
      expect(process.env.REDIS_PASSWORD).toBe(before);
    });

    it("populates process.env for a clean tree", async () => {
      const cwd = makeTree({ "database-url": "postgres://default/app" });
      setEnv("PENV_ENV", "development");
      const before = process.env.DATABASE_URL;

      try {
        await importCompat(cwd);
        expect(process.env.DATABASE_URL).toBe("postgres://default/app");
      } finally {
        setEnv("PENV_ENV", undefined);
        setEnv("DATABASE_URL", before);
      }
    });
  });

  describe("environment injection", () => {
    it("populates process.env from the validated environment when inject is set", () => {
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };
      try {
        const env = load(schema, { env: injected(COMPLETE), inject: true });
        expect(env.databaseUrl).toBe("postgres://default/app");
        expect(process.env.DATABASE_URL).toBe("postgres://default/app");
        expect(process.env.REDIS_HOST).toBe("127.0.0.1");
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("does not touch process.env without the flag", () => {
      const before = process.env.DATABASE_URL;
      try {
        load(schema, { env: injected(COMPLETE) });
        expect(process.env.DATABASE_URL).toBe(before);
      } finally {
        setEnv("DATABASE_URL", before);
      }
    });

    it("with an allowlist, injects only the listed parameters", () => {
      // Both arrived, but only redis/host is allowlisted — database-url, a
      // secret, must not reach process.env.
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };
      try {
        load(schema, { env: injected(COMPLETE), inject: ["redis/host"] });
        expect(process.env.REDIS_HOST).toBe("127.0.0.1");
        expect(process.env.DATABASE_URL).toBe(before.url);
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("fails closed: a truthy non-array inject value does not inject the whole schema", () => {
      // Only `true` or an allowlist array injects. A JS caller (no compile check)
      // passing a truthy non-array — "false" read from an env var, say — must not
      // fall through to a whole-schema inject that would leak the secret.
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };
      try {
        load(schema, {
          env: injected(COMPLETE),
          inject: "false" as unknown as boolean,
        });
        expect(process.env.DATABASE_URL).toBe(before.url);
        expect(process.env.REDIS_HOST).toBe(before.host);
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("validates first: an environment that fails the schema writes nothing", () => {
      const { REDIS_HOST: _deleted, ...withoutHost } = COMPLETE;
      const before = process.env.DATABASE_URL;
      try {
        expect(() => load(schema, { env: injected(withoutHost), inject: true })).toThrow(
          ValidationError,
        );
        expect(process.env.DATABASE_URL).toBe(before);
      } finally {
        setEnv("DATABASE_URL", before);
      }
    });

    it("injects a schema default nothing delivered", () => {
      const withDefault = z.object({
        databaseUrl: z.url(),
        region: z.string().default("us-east-1"),
      });
      const before = { url: process.env.DATABASE_URL, region: process.env.REGION };
      try {
        const env = load(withDefault, {
          env: { DATABASE_URL: "postgres://default/app", [RUN_MARKER]: INVOCATION },
          inject: true,
        });
        expect(env.region).toBe("us-east-1");
        // The default reaches process.env too — it must not be lost to the delete rule.
        expect(process.env.REGION).toBe("us-east-1");
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REGION", before.region);
      }
    });

    it("never mutates process.env during the schema-harvest window", () => {
      // Under harvest the CLI reads the `schema` export; a concrete read that
      // materialises the deferred load must not trigger a process.env write.
      const before = process.env.DATABASE_URL;
      setEnv(SCHEMA_HARVEST_ENV, "1");
      try {
        const deferred = load(schema, { env: injected(COMPLETE), inject: true });
        expect(deferred.databaseUrl).toBe("postgres://default/app");
        expect(process.env.DATABASE_URL).toBe(before);
      } finally {
        setEnv(SCHEMA_HARVEST_ENV, undefined);
        setEnv("DATABASE_URL", before);
      }
    });
  });
});

/**
 * The schema-harvest window (see `SCHEMA_HARVEST_ENV` in core): while the CLI
 * imports `.penv/env.ts` to read its `schema` export, the module's own eager
 * `export const env = load(schema)` must not stop the module from evaluating.
 * Under the pin, `load` defers — and the deferred value still behaves like the
 * eager one on first real use, error and all.
 */
describe("load under the schema-harvest pin", () => {
  it("defers instead of throwing, then raises the same error on first access", () => {
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { env: { [RUN_MARKER]: INVOCATION } });

    setEnv("PENV_SCHEMA_HARVEST", undefined);
    expect(() => deferred.databaseUrl).toThrow(ValidationError);
  });

  it("resolves real values on access", () => {
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { env: injected(COMPLETE) });

    setEnv("PENV_SCHEMA_HARVEST", undefined);
    expect(deferred.databaseUrl).toBe("postgres://default/app");
  });

  it("stays inert against loader probes while the window is still open", () => {
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { env: { [RUN_MARKER]: INVOCATION } });

    // `then` and well-known symbols are what module machinery pokes at exported
    // values; during the window they answer undefined without forcing the load.
    expect((deferred as { then?: unknown }).then).toBeUndefined();
    expect((deferred as Record<PropertyKey, unknown>)[Symbol.toStringTag]).toBeUndefined();
  });

  it("is untouched when the pin is not set — eager, fail-fast", () => {
    expect(() => load(schema, { env: { [RUN_MARKER]: INVOCATION } })).toThrow(ValidationError);
  });
});

describe("the PENV_DEBUG account", () => {
  /** Collects what penv writes to stderr — warnings and the PENV_DEBUG summary. */
  function captureStderr(): { text: () => string; restore: () => void } {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    return { text: () => written.join(""), restore: () => spy.mockRestore() };
  }

  it("PENV_DEBUG=1 reports the environment and the variable each parameter arrived in", () => {
    setEnv("PENV_DEBUG", "1");
    const stderr = captureStderr();

    try {
      load(schema, { env: injected(COMPLETE) });
    } finally {
      stderr.restore();
    }

    expect(stderr.text()).toContain("environment development");
    expect(stderr.text()).toContain("database-url <- DATABASE_URL");
    expect(stderr.text()).toContain("redis.host <- REDIS_HOST");
  });

  it("says nothing without PENV_DEBUG", () => {
    setEnv("PENV_DEBUG", undefined);
    const stderr = captureStderr();

    try {
      load(schema, { env: injected(COMPLETE) });
    } finally {
      stderr.restore();
    }

    expect(stderr.text()).toBe("");
  });
});

/**
 * The confirmed prototype-inheritance bug: a schema key named after an
 * `Object.prototype` member, with nothing delivered for it, reached
 * `Object.prototype` and failed the schema with `expected string, received
 * function`.
 */
describe("a parameter named after an Object.prototype member", () => {
  it("reports the parameter as absent, not as a function", () => {
    let thrown: unknown;
    try {
      load(z.object({ constructor: z.string() }), { env: { [RUN_MARKER]: INVOCATION } });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ValidationError).issues[0]?.message).toContain("received undefined");
  });

  it("yields the same empty result an ordinary parameter name would", () => {
    const env = load(z.object({ constructor: z.string().optional() }), {
      env: { [RUN_MARKER]: INVOCATION },
    });

    expect(Object.hasOwn(env as object, "constructor")).toBe(false);
  });
});

describe("the runtime's dependency budget", () => {
  it("ships no keychain or native dependency", () => {
    // `load` runs in every deploy, and a native module in its dependency tree is
    // a build failure in someone's container. The keychain binding lives in the
    // CLI, never here.
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    const { dependencies, peerDependencies } = manifest as {
      dependencies: Readonly<Record<string, string>>;
      peerDependencies: Readonly<Record<string, string>>;
    };

    expect(Object.keys(dependencies)).toEqual(["@penvhq/core", "@penvhq/provider-filesystem"]);
    expect(Object.keys(peerDependencies)).toEqual(["zod"]);
  });
});
