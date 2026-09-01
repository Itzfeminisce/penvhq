/**
 * The tree-reading half of the runtime — what the `penv/config` compatibility
 * entry resolves through.
 *
 * The typed bridge validates the environment `penv run` injected and never opens
 * a tree (see `load.test.ts`). This path still does, because the schemaless
 * ambient entry has no schema to be handed values under, so everything the
 * cascade guarantees is pinned here: precedence, the `test` skip, decryption,
 * and the refusals that must not degrade into an empty environment.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ParameterRef, UndecryptableValueError, ValueFile } from "@penvhq/core";
import {
  ConfigError,
  createEnvKeySource,
  findConfigFile,
  KEY_BYTES,
  PenvError,
  parameterId,
  recordsDir,
  sealValue,
} from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSync } from "./resolve.js";

const created: string[] = [];
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;
const originalKey = process.env.PENV_KEY_DEV;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const CONFIG = {
  environments: {
    development: "@penvhq/provider-filesystem",
    test: "@penvhq/provider-filesystem",
    production: "@penvhq/provider-filesystem",
  },
};

const KEY_ID = "dev";
const KEY_CONFIG = {
  environments: {
    ...CONFIG.environments,
    development: {
      provider: "@penvhq/provider-filesystem",
      keySource: { source: "env", id: KEY_ID },
    },
    production: {
      provider: "@penvhq/provider-filesystem",
      keySource: { source: "env", id: KEY_ID },
    },
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

function makeProject(files: Readonly<Record<string, string>>, config: unknown = CONFIG): string {
  const root = mkdtempSync(join(tmpdir(), "penv-resolve-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
    "utf8",
  );
  for (const [name, value] of Object.entries(files)) {
    const file = join(recordsDir(root), name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  }
  return root;
}

/** Every scope of `database-url` present at once, so precedence is observable. */
const FULL_TREE: Readonly<Record<string, string>> = {
  "database-url": "postgres://default/app",
  "database-url.production": "postgres://production/app",
  "database-url.local": "postgres://local/app",
  "redis/host": "127.0.0.1",
  "redis/password.production": "prod-secret",
};

/**
 * Seals a fixture the way `penv encrypt` would, through the same `sealValue`
 * the cascade opens with. A hand-written envelope would be a second
 * implementation of the format, and it is the one that would still pass after
 * the format changed.
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

function resolvedValue(cwd: string, environment: string, parameter: string): string | undefined {
  const { values } = resolveSync({ cwd, environment });
  return values.find(({ ref }: { ref: ParameterRef }) => parameterId(ref) === parameter)?.value;
}

afterEach(() => {
  setEnv("PENV_ENV", originalPenvEnv);
  setEnv("NODE_ENV", originalNodeEnv);
  setEnv("PENV_KEY_DEV", originalKey);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the cascade", () => {
  it("prefers .local over .<env> over the unscoped default", () => {
    const cwd = makeProject(FULL_TREE);

    expect(resolvedValue(cwd, "production", "database-url")).toBe("postgres://local/app");
  });

  it("falls back to .<env> when there is no .local", () => {
    const { "database-url.local": _local, ...withoutLocal } = FULL_TREE;
    const cwd = makeProject(withoutLocal);

    expect(resolvedValue(cwd, "production", "database-url")).toBe("postgres://production/app");
  });

  it("falls back to the unscoped default when there is no scoped value", () => {
    const cwd = makeProject({ "database-url": "postgres://default/app", "redis/host": "1.2.3.4" });

    expect(resolvedValue(cwd, "production", "database-url")).toBe("postgres://default/app");
  });

  it("skips .local entirely in the test environment", () => {
    const cwd = makeProject(FULL_TREE);

    // The same tree that resolves to `.local` for production must not in test.
    expect(resolvedValue(cwd, "test", "database-url")).toBe("postgres://default/app");
  });

  it("reads a namespace as its own parameter", () => {
    const cwd = makeProject(FULL_TREE);

    expect(resolvedValue(cwd, "production", "redis.password")).toBe("prod-secret");
  });
});

describe("environment selection", () => {
  it("reads PENV_ENV, then NODE_ENV", () => {
    const cwd = makeProject(FULL_TREE);
    setEnv("PENV_ENV", "test");
    setEnv("NODE_ENV", "production");

    expect(resolveSync({ cwd }).environment).toBe("test");

    setEnv("PENV_ENV", undefined);
    expect(resolveSync({ cwd }).environment).toBe("production");
  });
});

describe("encrypted values", () => {
  it("decrypts an .enc value with the key exported", () => {
    // The documented tradeoff — "a developer must hold the decrypt key to run
    // locally" — is a tradeoff only if holding the key actually works.
    const cwd = makeProject(
      { "database-url.enc": seal(DATABASE_URL_ENC, "postgres://sealed/app") },
      KEY_CONFIG,
    );

    expect(resolvedValue(cwd, "development", "database-url")).toBe("postgres://sealed/app");
  });

  it("throws VALUE_UNDECRYPTABLE naming the parameter and the file when no key is exported", () => {
    const cwd = makeProject(
      { "database-url.enc": seal(DATABASE_URL_ENC, "postgres://sealed/app") },
      KEY_CONFIG,
    );
    // The deploy that exports the key is the half that did not run.
    setEnv("PENV_KEY_DEV", undefined);

    let thrown: unknown;
    try {
      resolveSync({ cwd, environment: "development" });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as UndecryptableValueError;
    expect(error).toBeInstanceOf(PenvError);
    expect(error.code).toBe("VALUE_UNDECRYPTABLE");
    expect(error.parameter).toBe("database-url");
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
      },
      KEY_CONFIG,
    );
    setEnv("PENV_KEY_DEV", undefined);

    // The lower-scope plaintext is really there, and really resolvable — this
    // test would pass vacuously against a tree that simply had no fallback.
    expect(readFileSync(join(recordsDir(cwd), "database-url"), "utf8")).toBe(
      "postgres://default/app",
    );
    expect(resolvedValue(cwd, "development", "database-url")).toBe("postgres://default/app");

    let thrown: unknown;
    try {
      resolveSync({ cwd, environment: "production" });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as UndecryptableValueError;
    expect(error.code).toBe("VALUE_UNDECRYPTABLE");
    expect(error.message).toContain("database-url.production.enc");
    expect(error.message).not.toContain("postgres://default/app");
  });
});

describe("no config file", () => {
  it("throws ConfigError naming the file it looked for and the command that writes it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "penv-bundle-"));
    created.push(cwd);
    // Guard the premise: a stray config in an ancestor of tmpdir would take the disk path.
    expect(findConfigFile(cwd)).toBeUndefined();

    let thrown: unknown;
    try {
      resolveSync({ cwd, environment: "development" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("No penv.config.ts found");
    expect((thrown as ConfigError).message).toContain("penv init");
  });
});

/**
 * An unmigrated project must not resolve to an empty environment: the runtime
 * makes the same refusal the CLI does, or the first thing the user hears about
 * the layout is a missing required parameter.
 */
describe("a project still on the old layout", () => {
  it("refuses, naming penv migrate", () => {
    const cwd = makeProject({});
    mkdirSync(join(cwd, ".penv"), { recursive: true });
    writeFileSync(join(cwd, ".penv", "database-url"), "postgres://localhost/app", "utf8");

    expect(() => resolveSync({ cwd, environment: "development" })).toThrowError(/penv migrate/);
  });

  it("stays quiet when the records are where penv reads them", () => {
    const cwd = makeProject({ "database-url": "postgres://localhost/app" });

    expect(() => resolveSync({ cwd, environment: "development" })).not.toThrow();
  });
});
