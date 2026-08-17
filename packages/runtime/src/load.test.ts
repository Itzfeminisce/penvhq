import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  createEnvKeySource,
  findConfigFile,
  KEY_BYTES,
  type NameCollisionError,
  PenvError,
  type PenvSnapshot,
  SCHEMA_HARVEST_ENV,
  sealValue,
  snapshotDigest,
  type UndecryptableValueError,
  ValidationError,
  type ValueFile,
} from "@penvhq/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { load } from "./load.js";

const created: string[] = [];
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;
const originalKey = process.env.PENV_KEY_DEV;
const originalHarvest = process.env.PENV_SCHEMA_HARVEST;
const originalDebug = process.env.PENV_DEBUG;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** A config file penv cannot evaluate: its import does not resolve. */
const UNRESOLVABLE_CONFIG = 'import "@penv/nothing-resolves-here";\n';

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    test: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
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

/** A directory with no `penv.config.ts` and no ancestor that has one — a bundle. */
function makeBundleDir(): string {
  const root = mkdtempSync(join(tmpdir(), "penv-bundle-"));
  created.push(root);
  // Guard the premise: a stray config in an ancestor of tmpdir would take the disk path.
  expect(findConfigFile(root)).toBeUndefined();
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

const KEY_ID = "dev";
const KEY_CONFIG = {
  ...CONFIG,
  keys: {
    development: { source: "env", id: KEY_ID },
    production: { source: "env", id: KEY_ID },
  },
};

/** Not a real key — a real one is 32 random bytes, and this only has to be 32. */
const KEY = Buffer.alloc(KEY_BYTES, 7).toString("base64");

const DATABASE_URL_ENC: ValueFile = {
  namespace: [],
  name: "database-url",
  scope: { kind: "unscoped" },
  encrypted: true,
};

/**
 * Seals a fixture the way `penv encrypt` would, through the same `sealValue`
 * `load` opens with. A hand-written envelope would be a second implementation of
 * the format, and it is the one that would still pass after the format changed.
 *
 * Sealing needs the key exported, so a test asserting what happens *without* it
 * unsets it after building its tree.
 */
function seal(file: ValueFile, value: string): string {
  setEnv("PENV_KEY_DEV", KEY);
  return sealValue(
    file,
    value,
    createEnvKeySource({ source: "env", id: KEY_ID }),
    file.name,
    "development",
  );
}

/** Collects what penv writes to stderr — warnings and the PENV_DEBUG summary. */
function captureStderr(): { text: () => string; restore: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  return { text: () => written.join(""), restore: () => spy.mockRestore() };
}

afterEach(() => {
  setEnv("PENV_ENV", originalPenvEnv);
  setEnv("NODE_ENV", originalNodeEnv);
  setEnv("PENV_KEY_DEV", originalKey);
  setEnv("PENV_SCHEMA_HARVEST", originalHarvest);
  setEnv("PENV_DEBUG", originalDebug);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const cwd = makeProject({}); // no values at all — the state `penv fill` exists to fix
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { cwd, environment: "development" });

    // The harvest window closes (the CLI restores the pin), and the first real
    // read performs the eager load — which fails exactly as it would have.
    setEnv("PENV_SCHEMA_HARVEST", undefined);
    expect(() => deferred.databaseUrl).toThrow(ValidationError);
  });

  it("resolves real values on access when the tree can satisfy the schema", () => {
    const cwd = makeProject({
      "database-url": "postgres://default/app",
      "redis/host": "127.0.0.1",
    });
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { cwd, environment: "development" });

    setEnv("PENV_SCHEMA_HARVEST", undefined);
    expect(deferred.databaseUrl).toBe("postgres://default/app");
    expect(deferred.redis.host).toBe("127.0.0.1");
  });

  it("stays inert against loader probes while the window is still open", () => {
    const cwd = makeProject({}); // resolving would throw — the probes must not resolve
    setEnv("PENV_SCHEMA_HARVEST", "1");

    const deferred = load(schema, { cwd, environment: "development" });

    // `then` and well-known symbols are what module machinery pokes at exported
    // values; during the window they answer undefined without forcing the load.
    expect((deferred as { then?: unknown }).then).toBeUndefined();
    expect((deferred as Record<PropertyKey, unknown>)[Symbol.toStringTag]).toBeUndefined();
  });

  it("is untouched when the pin is not set — eager, fail-fast", () => {
    const cwd = makeProject({});
    expect(() => load(schema, { cwd, environment: "development" })).toThrow(ValidationError);
  });
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
        development: { type: "@penvhq/provider-filesystem" },
        production: { type: "@penvhq/provider-vault", location: "secret/app" },
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

  describe("encrypted values", () => {
    it("decrypts an .enc unscoped default with the key exported", () => {
      // The documented tradeoff — "a developer must hold the decrypt key to run
      // locally" — is a tradeoff only if holding the key actually works. If this
      // fails, encrypting the unscoped default is a prohibition rather than a
      // choice about the scope of encryption.
      const cwd = makeProject(
        {
          "database-url.enc": seal(DATABASE_URL_ENC, "postgres://sealed/app"),
          "redis/host": "127.0.0.1",
        },
        KEY_CONFIG,
      );

      expect(load(schema, { cwd, environment: "development" }).databaseUrl).toBe(
        "postgres://sealed/app",
      );
    });

    it("throws VALUE_UNDECRYPTABLE naming the parameter and the file when no key is exported", () => {
      const cwd = makeProject(
        {
          "database-url.enc": seal(DATABASE_URL_ENC, "postgres://sealed/app"),
          "redis/host": "127.0.0.1",
        },
        KEY_CONFIG,
      );
      // The deploy that exports the key is the half that did not run.
      setEnv("PENV_KEY_DEV", undefined);

      let thrown: unknown;
      try {
        load(schema, { cwd, environment: "development" });
      } catch (error) {
        thrown = error;
      }

      const error = thrown as UndecryptableValueError;
      expect(error).toBeInstanceOf(PenvError);
      expect(error.code).toBe("VALUE_UNDECRYPTABLE");
      expect(error.parameter).toBe("database-url");
      expect(error.environment).toBe("development");
      expect(error.message).toContain("database-url.enc");
      expect(error.failure.reason).toBe("key-absent");
    });

    it("refuses rather than falling through to a plaintext twin at a lower scope", () => {
      // The load-bearing one. `database-url.production.enc` wins the cascade, and
      // it keeps winning when it does not open: treating "I cannot read this" as
      // "this is not here" would serve the unscoped default to production — a
      // secret silently widening its scope, which is the failure the cascade
      // exists to prevent, and it would do it at the moment the key is missing.
      const cwd = makeProject(
        {
          "database-url.production.enc": seal(
            { ...DATABASE_URL_ENC, scope: { kind: "environment", environment: "production" } },
            "postgres://sealed-production/app",
          ),
          "database-url": "postgres://default/app",
          "redis/host": "127.0.0.1",
        },
        KEY_CONFIG,
      );
      setEnv("PENV_KEY_DEV", undefined);

      // The lower-scope plaintext is really there, and really resolvable — this
      // test would pass vacuously against a tree that simply had no fallback.
      expect(readFileSync(join(cwd, ".penv", "database-url"), "utf8")).toBe(
        "postgres://default/app",
      );
      expect(load(schema, { cwd, environment: "development" }).databaseUrl).toBe(
        "postgres://default/app",
      );

      let thrown: unknown;
      try {
        load(schema, { cwd, environment: "production" });
      } catch (error) {
        thrown = error;
      }

      const error = thrown as UndecryptableValueError;
      expect(error.code).toBe("VALUE_UNDECRYPTABLE");
      expect(error.message).toContain("database-url.production.enc");
      expect(error.message).not.toContain("postgres://default/app");
    });

    it("ships no keychain or native dependency", () => {
      // The env key source exists so decryption costs the app nothing: `load`
      // runs in every deploy, and a native module in its dependency tree is a
      // build failure in someone's container. The keychain binding lives in the
      // CLI, never here; at runtime a keychain source finds no binding registered
      // and resolves to `unavailable`, so `load` still carries no native dep.
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

      // `vi.resetModules()` gives the compat module its own copy of @penvhq/core,
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

  describe("environment injection", () => {
    // The blessed surface end to end: `load(schema, { inject: true })` returns
    // the typed env *and* writes it onto process.env, after validation.
    it("populates process.env from the validated tree when inject is set", () => {
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };

      try {
        const env = load(schema, { cwd, environment: "development", inject: true });
        expect(env.databaseUrl).toBe("postgres://default/app");
        expect(process.env.DATABASE_URL).toBe("postgres://default/app");
        expect(process.env.REDIS_HOST).toBe("127.0.0.1");
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("does not touch process.env without the flag", () => {
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      const before = process.env.DATABASE_URL;
      try {
        load(schema, { cwd, environment: "development" });
        expect(process.env.DATABASE_URL).toBe(before);
      } finally {
        setEnv("DATABASE_URL", before);
      }
    });

    it("with an allowlist, injects only the listed parameters", () => {
      // The tree resolves both, but only redis/host is allowlisted — database-url,
      // a secret, must not reach process.env.
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };
      try {
        load(schema, { cwd, environment: "development", inject: ["redis/host"] });
        expect(process.env.REDIS_HOST).toBe("127.0.0.1");
        // The allowlist omits database-url, so its ambient value is exactly what it
        // was before the load — the secret never reached process.env.
        expect(process.env.DATABASE_URL).toBe(before.url);
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("fails closed: a truthy non-array inject value does not inject the whole schema", () => {
      // Only `true` or an allowlist array injects. A JS caller (no compile check)
      // passing a truthy non-array — "false" read from an env var, say — must not
      // fall through to a whole-schema inject that would leak the secret database-url.
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      const before = { url: process.env.DATABASE_URL, host: process.env.REDIS_HOST };
      try {
        load(schema, { cwd, environment: "development", inject: "false" as unknown as boolean });
        expect(process.env.DATABASE_URL).toBe(before.url);
        expect(process.env.REDIS_HOST).toBe(before.host);
      } finally {
        setEnv("DATABASE_URL", before.url);
        setEnv("REDIS_HOST", before.host);
      }
    });

    it("validates first: a tree that fails the schema writes nothing", () => {
      // `redis/host` is required by the schema and absent, so load throws — and
      // must throw before the injection writes database-url.
      const cwd = makeProject({ "database-url": "postgres://default/app" });
      const before = process.env.DATABASE_URL;
      try {
        expect(() => load(schema, { cwd, environment: "development", inject: true })).toThrow(
          ValidationError,
        );
        expect(process.env.DATABASE_URL).toBe(before);
      } finally {
        setEnv("DATABASE_URL", before);
      }
    });

    it("injects a schema default the tree did not set", () => {
      const withDefault = z.object({
        databaseUrl: z.url(),
        region: z.string().default("us-east-1"),
      });
      const cwd = makeProject({ "database-url": "postgres://default/app" });
      const before = { url: process.env.DATABASE_URL, region: process.env.REGION };
      try {
        const env = load(withDefault, { cwd, environment: "development", inject: true });
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
      const cwd = makeProject({
        "database-url": "postgres://default/app",
        "redis/host": "127.0.0.1",
      });
      const before = process.env.DATABASE_URL;
      setEnv(SCHEMA_HARVEST_ENV, "1");
      try {
        const deferred = load(schema, { cwd, environment: "development", inject: true });
        // Force materialisation while harvest is still active.
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
 * The bundled/serverless story: a compiled bundle has no `penv.config.ts` and no
 * `.penv/` tree, so `load` falls back to the committed snapshot `env.ts` passes
 * it. File discovery still comes first — on disk, a live edit wins — and the
 * snapshot carries sealed records only, decrypted at boot exactly as a filesystem
 * load would be. This reproduces the Vercel middleware crash and its fix.
 */
describe("load from a bundle (embedded snapshot)", () => {
  const bundleSchema = z.object({ databaseUrl: z.url() });

  /** A snapshot the way `penv snapshot` writes it: config plus sealed records only. */
  function snapshotWith(values: Readonly<Record<string, string>>): PenvSnapshot {
    // KEY_CONFIG is a plain test literal, so its `source` widens to string; the
    // cast is the same one `makeProject`'s `config: unknown` parameter makes.
    return { v: 1, config: KEY_CONFIG as unknown as PenvSnapshot["config"], values };
  }

  it("resolves and decrypts from the snapshot when no config is on disk", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app"); // exports PENV_KEY_DEV
    const cwd = makeBundleDir();

    const env = load(bundleSchema, {
      cwd,
      environment: "development",
      snapshot: snapshotWith({ "database-url.enc": sealed }),
    });

    expect(env.databaseUrl).toBe("postgres://sealed/app");
  });

  it("prefers the filesystem over the snapshot when a config is on disk", () => {
    // Both are present; a live edit to the tree must win, so the snapshot is a
    // fallback and never a shadow of what is really on disk.
    const cwd = makeProject({
      "database-url": "postgres://on-disk/app",
      "redis/host": "127.0.0.1",
    });
    const snapshot = snapshotWith({
      "database-url.enc": seal(DATABASE_URL_ENC, "postgres://snapshot/app"),
    });

    expect(load(schema, { cwd, environment: "development", snapshot }).databaseUrl).toBe(
      "postgres://on-disk/app",
    );
  });

  it("throws ValidationError naming a required parameter the snapshot omits", () => {
    // The snapshot carries database-url and redis/password (keeping the namespace
    // present), but not the required `redis.host` — so requiredness stays the
    // schema's call, no special-casing for a bundle.
    const redisPassword: ValueFile = {
      namespace: ["redis"],
      name: "password",
      scope: { kind: "unscoped" },
      encrypted: true,
    };
    const cwd = makeBundleDir();

    let thrown: unknown;
    try {
      load(schema, {
        cwd,
        environment: "development",
        snapshot: snapshotWith({
          "database-url.enc": seal(DATABASE_URL_ENC, "postgres://sealed/app"),
          "redis/password.enc": seal(redisPassword, "prod-secret"),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).issues.map((issue) => issue.parameter)).toEqual([
      "redis.host",
    ]);
  });

  it("loads fine when the only absent parameters are optional or defaulted", () => {
    const withOptional = z.object({
      databaseUrl: z.url(),
      region: z.string().default("us-east-1"),
      note: z.string().optional(),
    });
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app");
    const cwd = makeBundleDir();

    const env = load(withOptional, {
      cwd,
      environment: "development",
      snapshot: snapshotWith({ "database-url.enc": sealed }),
    });

    expect(env.databaseUrl).toBe("postgres://sealed/app");
    expect(env.region).toBe("us-east-1");
    expect(env.note).toBeUndefined();
  });

  it("throws ConfigError pointing at `penv snapshot` when there is no config and no snapshot", () => {
    const cwd = makeBundleDir();

    let thrown: unknown;
    try {
      load(bundleSchema, { cwd, environment: "development" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.message).toContain("No penv.config.ts found");
    // The extended remedy names the bundled-runtime escape hatch.
    expect(error.message).toContain("penv snapshot");
  });
});

/**
 * The disk branch is still first, always. What this covers is the one shape that
 * is not a project at all: a `penv.config.ts` that a bundler traced into
 * `/var/task` because a config key referenced it, with no `.penv/` tree beside
 * it because nothing imports the tree. That is the production outage — the
 * snapshot was valid, was passed, and was never consulted because a file had
 * been found.
 */
describe("load falls back from a config with no tree beside it", () => {
  const bundleSchema = z.object({ databaseUrl: z.url() });

  function snapshotWith(values: Readonly<Record<string, string>>): PenvSnapshot {
    return { v: 1, config: KEY_CONFIG as unknown as PenvSnapshot["config"], values };
  }

  /** Replaces a project's config with source that cannot be evaluated. */
  function breakConfig(root: string): void {
    writeFileSync(join(root, "penv.config.ts"), UNRESOLVABLE_CONFIG, "utf8");
  }

  it("resolves from the snapshot when the config was traced without its .penv/ tree", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app"); // exports PENV_KEY_DEV
    // `makeProject({})` writes the config and no tree — the bundle that traced
    // one file and not the other.
    const cwd = makeProject({});
    const stderr = captureStderr();

    try {
      const env = load(bundleSchema, {
        cwd,
        environment: "development",
        snapshot: snapshotWith({ "database-url.enc": sealed }),
      });
      expect(env.databaseUrl).toBe("postgres://sealed/app");
      // Never silent (invariant 13): the warning names the tree that is missing.
      expect(stderr.text()).toContain(".penv");
    } finally {
      stderr.restore();
    }
  });

  it("falls back before evaluating the config, so an untraced import cannot fail the load", () => {
    // The whole outage: the config's own imports do not resolve from the bundle
    // root. With no tree beside it, penv never evaluates it at all.
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app");
    const cwd = makeProject({});
    breakConfig(cwd);
    const stderr = captureStderr();

    try {
      expect(
        load(bundleSchema, {
          cwd,
          environment: "development",
          snapshot: snapshotWith({ "database-url.enc": sealed }),
        }).databaseUrl,
      ).toBe("postgres://sealed/app");
    } finally {
      stderr.restore();
    }
  });

  it("does NOT fall back for a broken config in a real project — a tree beside it is a project", () => {
    // The masking risk this narrowing exists to close: a developer who breaks
    // penv.config.ts must see it, not boot silently on the committed snapshot.
    const cwd = makeProject({ "database-url": "postgres://on-disk/app" });
    breakConfig(cwd);
    const snapshot = snapshotWith({
      "database-url.enc": seal(DATABASE_URL_ENC, "postgres://snapshot/app"),
    });

    expect(() => load(bundleSchema, { cwd, environment: "development", snapshot })).toThrow(
      ConfigError,
    );
  });

  it("does NOT fall back for a config whose default export is missing", () => {
    const cwd = makeProject({ "database-url": "postgres://on-disk/app" });
    writeFileSync(join(cwd, "penv.config.ts"), "export const notDefault = {};\n", "utf8");
    const snapshot = snapshotWith({
      "database-url.enc": seal(DATABASE_URL_ENC, "postgres://snapshot/app"),
    });

    expect(() => load(bundleSchema, { cwd, environment: "development", snapshot })).toThrow(
      ConfigError,
    );
  });

  it("still throws the config's own error when no snapshot was passed", () => {
    const cwd = makeProject({});
    breakConfig(cwd);

    // Nothing to fall back to, so the cause is not downgraded to a warning.
    expect(() => load(bundleSchema, { cwd, environment: "development" })).toThrow(ConfigError);
  });

  it("does not fall back past a config that loaded — a value it cannot open still throws", () => {
    // The tree is present and the config is fine; this is the user's data
    // failing, and the snapshot must not be allowed to paper over it.
    const cwd = makeProject({ "database-url.enc": "not-an-envelope" }, KEY_CONFIG);
    const snapshot = snapshotWith({
      "database-url.enc": seal(DATABASE_URL_ENC, "postgres://snapshot/app"),
    });

    expect(() => load(bundleSchema, { cwd, environment: "development", snapshot })).toThrow(
      /could not decrypt/,
    );
  });

  it("does not fall back for an incomplete tree — a missing parameter is still a ValidationError", () => {
    const cwd = makeProject({ "log-level": "debug" }, KEY_CONFIG);
    const snapshot = snapshotWith({
      "database-url.enc": seal(DATABASE_URL_ENC, "postgres://snapshot/app"),
    });

    expect(() => load(bundleSchema, { cwd, environment: "development", snapshot })).toThrow(
      ValidationError,
    );
  });

  it("names a config the workspace boundary put out of reach rather than quietly skipping it", () => {
    // A bounded walk that stops one directory short of the config a developer
    // expects is the same surprise as one that climbs too far, so it says so.
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app");
    const outer = makeBundleDir();
    writeFileSync(
      join(outer, "penv.config.ts"),
      `export default ${JSON.stringify(CONFIG)};\n`,
      "utf8",
    );
    const inner = join(outer, "apps", "web");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, ".git"), "gitdir: elsewhere\n", "utf8");
    const stderr = captureStderr();

    try {
      load(bundleSchema, {
        cwd: inner,
        environment: "development",
        snapshot: snapshotWith({ "database-url.enc": sealed }),
      });
      expect(stderr.text()).toContain("outside this project's workspace");
    } finally {
      stderr.restore();
    }
  });

  it("says nothing on the ordinary bundle path, where finding no config is the design", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app");
    const cwd = makeBundleDir();
    const stderr = captureStderr();

    try {
      load(bundleSchema, {
        cwd,
        environment: "development",
        snapshot: snapshotWith({ "database-url.enc": sealed }),
      });
      expect(stderr.text()).toBe("");
    } finally {
      stderr.restore();
    }
  });
});

describe("load's `source` option", () => {
  const bundleSchema = z.object({ databaseUrl: z.url() });

  function snapshotWith(values: Readonly<Record<string, string>>): PenvSnapshot {
    return { v: 1, config: KEY_CONFIG as unknown as PenvSnapshot["config"], values };
  }

  it('"disk" refuses the snapshot rather than resolving from it', () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://sealed/app");
    const cwd = makeBundleDir();

    expect(() =>
      load(bundleSchema, {
        cwd,
        environment: "development",
        source: "disk",
        snapshot: snapshotWith({ "database-url.enc": sealed }),
      }),
    ).toThrow(ConfigError);
  });

  it('"snapshot" ignores a config file that is on disk', () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://snapshot/app");
    const cwd = makeProject({
      "database-url": "postgres://on-disk/app",
      "redis/host": "127.0.0.1",
    });

    const env = load(bundleSchema, {
      cwd,
      environment: "development",
      source: "snapshot",
      snapshot: snapshotWith({ "database-url.enc": sealed }),
    });

    expect(env.databaseUrl).toBe("postgres://snapshot/app");
  });

  it('"disk" keeps a broken config fatal even with a snapshot to hand', () => {
    const cwd = makeProject({});
    writeFileSync(join(cwd, "penv.config.ts"), UNRESOLVABLE_CONFIG, "utf8");

    expect(() =>
      load(bundleSchema, {
        cwd,
        environment: "development",
        source: "disk",
        snapshot: snapshotWith({ "database-url.enc": seal(DATABASE_URL_ENC, "postgres://s/app") }),
      }),
    ).toThrow(ConfigError);
  });

  it('"snapshot" with no snapshot is a named error, not a silent disk read', () => {
    const cwd = makeProject({
      "database-url": "postgres://on-disk/app",
      "redis/host": "127.0.0.1",
    });

    expect(() =>
      load(bundleSchema, { cwd, environment: "development", source: "snapshot" }),
    ).toThrow(ConfigError);
  });
});

/**
 * A snapshot that has fallen behind the tree bakes one value into the build and
 * serves another at runtime. `load` holds both sources at once, so it is where
 * the drift can be seen — and it is only ever reported, never resolved by.
 */
describe("snapshot drift", () => {
  const bundleSchema = z.object({ databaseUrl: z.url() });
  const config = KEY_CONFIG as unknown as PenvSnapshot["config"];

  it("warns when the committed snapshot no longer digests to what the tree holds", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://on-disk/app");
    const cwd = makeProject({ "database-url.enc": sealed }, KEY_CONFIG);
    const stale = { "database-url.enc": "penv:1:dev:stale:stale" };
    const snapshot: PenvSnapshot = {
      v: 1,
      config,
      values: stale,
      digest: snapshotDigest(config, stale),
    };
    const stderr = captureStderr();

    try {
      expect(load(bundleSchema, { cwd, environment: "development", snapshot }).databaseUrl).toBe(
        "postgres://on-disk/app",
      );
      expect(stderr.text()).toContain("penv snapshot");
    } finally {
      stderr.restore();
    }
  });

  it("stays quiet when the snapshot still digests to the tree", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://on-disk/app");
    const cwd = makeProject({ "database-url.enc": sealed }, KEY_CONFIG);
    const values = { "database-url.enc": sealed };
    const snapshot: PenvSnapshot = { v: 1, config, values, digest: snapshotDigest(config, values) };
    const stderr = captureStderr();

    try {
      load(bundleSchema, { cwd, environment: "development", snapshot });
      expect(stderr.text()).toBe("");
    } finally {
      stderr.restore();
    }
  });

  it("stays quiet for a snapshot generated before digests — unverifiable is not stale", () => {
    const sealed = seal(DATABASE_URL_ENC, "postgres://on-disk/app");
    const cwd = makeProject({ "database-url.enc": sealed }, KEY_CONFIG);
    const snapshot: PenvSnapshot = { v: 1, config, values: { "database-url.enc": "penv:1:d:x:y" } };
    const stderr = captureStderr();

    try {
      load(bundleSchema, { cwd, environment: "development", snapshot });
      expect(stderr.text()).toBe("");
    } finally {
      stderr.restore();
    }
  });
});

describe("provenance", () => {
  const bundleSchema = z.object({ databaseUrl: z.url() });

  it("names the config file that answered in a ValidationError", () => {
    const cwd = makeProject({ "log-level": "debug" });

    let thrown: unknown;
    try {
      load(bundleSchema, { cwd, environment: "development" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ValidationError).source).toBe(join(cwd, "penv.config.ts"));
    expect((thrown as ValidationError).message).toContain("penv.config.ts");
  });

  it("names the embedded snapshot in a ValidationError raised from a bundle", () => {
    const cwd = makeBundleDir();

    let thrown: unknown;
    try {
      load(bundleSchema, {
        cwd,
        environment: "development",
        snapshot: { v: 1, config: KEY_CONFIG as unknown as PenvSnapshot["config"], values: {} },
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ValidationError).source).toBe("the embedded snapshot");
  });

  it("PENV_DEBUG=1 reports the environment, the source, and each winning file", () => {
    const cwd = makeProject({
      "database-url": "postgres://default/app",
      "database-url.production": "postgres://production/app",
      "redis/host": "127.0.0.1",
    });
    setEnv("PENV_DEBUG", "1");
    const stderr = captureStderr();

    try {
      load(schema, { cwd, environment: "production" });
    } finally {
      stderr.restore();
    }

    expect(stderr.text()).toContain("environment production");
    expect(stderr.text()).toContain("resolved from disk");
    expect(stderr.text()).toContain("database-url <- database-url.production");
    expect(stderr.text()).toContain("redis.host <- redis/host");
  });

  it("says nothing without PENV_DEBUG", () => {
    const cwd = makeProject({
      "database-url": "postgres://default/app",
      "redis/host": "127.0.0.1",
    });
    setEnv("PENV_DEBUG", undefined);
    const stderr = captureStderr();

    try {
      load(schema, { cwd, environment: "development" });
    } finally {
      stderr.restore();
    }

    expect(stderr.text()).toBe("");
  });
});

/**
 * The confirmed prototype-inheritance bug, at the level it was reported from: a
 * snapshot holding only `constructor.production.enc`, loaded for an environment
 * with no candidate, reached `Object.prototype` and failed the schema with
 * `expected string, received function`.
 */
describe("a parameter named after an Object.prototype member", () => {
  const snapshot: PenvSnapshot = {
    v: 1,
    config: KEY_CONFIG as unknown as PenvSnapshot["config"],
    values: { "constructor.production.enc": "penv:1:dev:aa:bb" },
  };

  it("reports the parameter as absent, not as a function", () => {
    const cwd = makeBundleDir();

    let thrown: unknown;
    try {
      load(z.object({ constructor: z.string() }), { cwd, environment: "development", snapshot });
    } catch (error) {
      thrown = error;
    }

    // The reported failure was `expected string, received function`.
    expect((thrown as ValidationError).issues[0]?.message).toContain("received undefined");
  });

  it("yields the same empty result an ordinary parameter name would", () => {
    const cwd = makeBundleDir();

    const env = load(z.object({ constructor: z.string().optional() }), {
      cwd,
      environment: "development",
      snapshot,
    });

    expect(Object.hasOwn(env as object, "constructor")).toBe(false);
  });
});
