import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type NameCollisionError, PenvError, ValidationError } from "@penv/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { load } from "./load.js";

const created: string[] = [];
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};

/**
 * A real project root: `penv.config.ts` plus a `.penv/` tree. Keys are paths
 * relative to `.penv/`, so `"redis/password.production"` writes the namespace.
 */
function makeProject(files: Readonly<Record<string, string>>, config: unknown = CONFIG): string {
  const root = mkdtempSync(join(tmpdir(), "penv-load-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
    "utf8",
  );
  for (const [name, value] of Object.entries(files)) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  }
  return root;
}

const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({
    host: z.string(),
    password: z.string().optional(),
  }),
});

/** Every scope of `database-url` present at once, so precedence is observable. */
const FULL_TREE: Readonly<Record<string, string>> = {
  "database-url": "postgres://default/app",
  "database-url.production": "postgres://production/app",
  "database-url.local": "postgres://local/app",
  "redis/host": "127.0.0.1",
  "redis/password.production": "prod-secret",
};

afterEach(() => {
  setEnv("PENV_ENV", originalPenvEnv);
  setEnv("NODE_ENV", originalNodeEnv);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("load", () => {
  it("loads and validates values for the target environment", () => {
    const cwd = makeProject({
      "database-url": "postgres://default/app",
      "redis/host": "127.0.0.1",
    });

    const env = load(schema, { cwd, environment: "development" });

    expect(env.databaseUrl).toBe("postgres://default/app");
    expect(env.redis.host).toBe("127.0.0.1");
  });

  it("reads a nested namespace as a nested object", () => {
    const cwd = makeProject(FULL_TREE);

    const env = load(schema, { cwd, environment: "production" });

    expect(env.redis).toEqual({ host: "127.0.0.1", password: "prod-secret" });
    expect(env.redis.password).toBe("prod-secret");
  });

  it("leaves an optional parameter undefined rather than crashing", () => {
    const cwd = makeProject({
      "database-url": "postgres://default/app",
      "redis/host": "127.0.0.1",
    });

    const env = load(schema, { cwd, environment: "development" });

    expect(env.redis.password).toBeUndefined();
  });

  describe("the cascade", () => {
    it("prefers .local over .<env> over the unscoped default", () => {
      const cwd = makeProject(FULL_TREE);

      expect(load(schema, { cwd, environment: "production" }).databaseUrl).toBe(
        "postgres://local/app",
      );
    });

    it("falls back to .<env> when there is no .local", () => {
      const { "database-url.local": _local, ...withoutLocal } = FULL_TREE;
      const cwd = makeProject(withoutLocal);

      expect(load(schema, { cwd, environment: "production" }).databaseUrl).toBe(
        "postgres://production/app",
      );
    });

    it("falls back to the unscoped default when there is no scoped value", () => {
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "1.2.3.4",
      });

      expect(load(schema, { cwd, environment: "production" }).databaseUrl).toBe(
        "postgres://default/app",
      );
    });

    it("skips .local entirely in the test environment", () => {
      const cwd = makeProject(FULL_TREE);

      // The same tree that resolves to `.local` for production must not in test.
      expect(load(schema, { cwd, environment: "test" }).databaseUrl).toBe("postgres://default/app");
    });
  });

  describe("environment selection", () => {
    it("reads PENV_ENV", () => {
      const cwd = makeProject(FULL_TREE);
      setEnv("PENV_ENV", "test");

      expect(load(schema, { cwd }).databaseUrl).toBe("postgres://default/app");
    });

    it("reads NODE_ENV when PENV_ENV is unset", () => {
      const cwd = makeProject(FULL_TREE);
      setEnv("PENV_ENV", undefined);
      setEnv("NODE_ENV", "test");

      expect(load(schema, { cwd }).databaseUrl).toBe("postgres://default/app");
    });

    it("prefers PENV_ENV over NODE_ENV", () => {
      const cwd = makeProject({
        "database-url.test": "postgres://test/app",
        "database-url.production": "postgres://production/app",
        "redis/host": "127.0.0.1",
      });
      setEnv("PENV_ENV", "test");
      setEnv("NODE_ENV", "production");

      expect(load(schema, { cwd }).databaseUrl).toBe("postgres://test/app");
    });
  });

  describe("validation", () => {
    it("throws ValidationError naming the parameter and the environment", () => {
      const cwd = makeProject({
        "database-url.production": "not-a-url",
        "redis/host": "127.0.0.1",
      });

      let thrown: unknown;
      try {
        load(schema, { cwd, environment: "production" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ValidationError);
      const error = thrown as ValidationError;
      expect(error.environment).toBe("production");
      expect(error.issues.map((issue) => issue.parameter)).toEqual(["databaseUrl"]);
      expect(error.message).toContain("databaseUrl");
      expect(error.message).toContain("production");
    });

    it("surfaces a missing required parameter as a ValidationError", () => {
      // `redis/host` has no value file at any scope; `redis/password` keeps the
      // namespace present, so the issue names `redis.host` rather than `redis`.
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/password.production": "prod-secret",
      });

      let thrown: unknown;
      try {
        load(schema, { cwd, environment: "production" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ValidationError);
      const error = thrown as ValidationError;
      expect(error.environment).toBe("production");
      expect(error.issues.map((issue) => issue.parameter)).toEqual(["redis.host"]);
      expect(error.message).toContain("redis.host");
    });
  });

  describe("declared providers", () => {
    const VAULT_CONFIG = {
      environments: ["development", "production"],
      providers: {
        development: { type: "filesystem" },
        production: { type: "vault", path: "secret/app" },
      },
    };

    it("reads the tree for a vault-declared environment, because a provider is a sync target", () => {
      // A provider is where an environment's source of truth lives, not where
      // the runtime reads from: `penv pull` materialises the tree, and `load`
      // reads what is on disk. So a vault-declared environment resolves through
      // exactly the path a filesystem-declared one does — that identity is what
      // makes changing provider a config change rather than a rewrite, and it is
      // why `load` never inspects `providers.*.type`.
      const cwd = makeProject(
        {
          "database-url.production": "postgres://production/app",
          "redis/host": "127.0.0.1",
          "redis/password.production": "pulled-from-vault",
        },
        VAULT_CONFIG,
      );

      const env = load(schema, { cwd, environment: "production" });

      expect(env.databaseUrl).toBe("postgres://production/app");
      expect(env.redis.password).toBe("pulled-from-vault");
    });

    it("still serves a filesystem-declared environment from the same project", () => {
      const cwd = makeProject(
        {
          "database-url": "postgres://default/app",
          "redis/host": "127.0.0.1",
        },
        VAULT_CONFIG,
      );

      const env = load(schema, { cwd, environment: "development" });

      expect(env.databaseUrl).toBe("postgres://default/app");
      expect(env.redis.host).toBe("127.0.0.1");
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

    it("throws NameCollisionError rather than silently dropping a parameter", async () => {
      // Both files map to REDIS_PASSWORD. First-write-wins would boot the
      // process with one of them and say nothing — invariant 12.
      const cwd = makeProject({
        "redis/password": "from-namespaced",
        "redis-password": "from-flat",
        "redis/host": "127.0.0.1",
      });
      setEnv("PENV_ENV", "development");
      const before = process.env.REDIS_PASSWORD;

      let thrown: unknown;
      try {
        await importCompat(cwd);
      } catch (error) {
        thrown = error;
      }

      // `vi.resetModules()` gives the compat module its own copy of @penv/core,
      // so the thrown class is not identity-equal to the one imported here.
      // Assert the contract the caller actually sees instead.
      const error = thrown as NameCollisionError;
      expect(error.name).toBe("NameCollisionError");
      expect(error.code).toBe("NAME_COLLISION");
      expect(error.variable).toBe("REDIS_PASSWORD");
      expect(error.parameters).toEqual(["redis-password", "redis.password"]);

      // Nothing is populated when the tree is ambiguous.
      expect(process.env.REDIS_PASSWORD).toBe(before);
    });

    it("populates process.env for a clean tree", async () => {
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      setEnv("PENV_ENV", "development");
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };

      try {
        await importCompat(cwd);
        expect(process.env.DATABASE_URL).toBe("postgres://default/app");
        expect(process.env.REDIS_HOST).toBe("127.0.0.1");
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });
  });
});
