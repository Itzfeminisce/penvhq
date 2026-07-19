import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEnvironment,
  defineConfig,
  findConfigFile,
  loadConfig,
  loadConfigFrom,
  resolveEnvironment,
  validateConfig,
} from "./config.js";
import { ConfigError, UnknownEnvironmentError } from "./errors.js";
import type { PenvConfig } from "./types.js";

const created: string[] = [];
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;

function setEnv(name: "PENV_ENV" | "NODE_ENV", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-config-"));
  created.push(dir);
  return dir;
}

/** A project root holding one config file. Returns the root. */
function makeProject(source: string, filename = "penv.config.ts"): string {
  const dir = makeDir();
  writeFileSync(join(dir, filename), source, "utf8");
  return dir;
}

const valid: PenvConfig = {
  environments: ["development", "staging", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    staging: { type: "@penvhq/provider-vault", location: "secret/staging" },
    production: { type: "@penvhq/provider-ssm", location: "/prod/app" },
  },
  names: { "database-url": "DATABASE_URL" },
};

const VALID_SOURCE = `export default ${JSON.stringify(valid, null, 2)};\n`;

function codesFor(config: PenvConfig): string[] {
  return validateConfig(config).map((error) => error.code);
}

afterEach(() => {
  setEnv("PENV_ENV", originalPenvEnv);
  setEnv("NODE_ENV", originalNodeEnv);
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("defineConfig", () => {
  it("returns the config unchanged", () => {
    expect(defineConfig(valid)).toBe(valid);
  });
});

describe("findConfigFile", () => {
  it("finds a config file in cwd itself", () => {
    const root = makeProject(VALID_SOURCE);
    expect(findConfigFile(root)).toBe(resolve(root, "penv.config.ts"));
  });

  it("walks up from a nested directory", () => {
    const root = makeProject(VALID_SOURCE);
    const nested = join(root, "apps", "web", "src");
    mkdirSync(nested, { recursive: true });

    expect(findConfigFile(nested)).toBe(resolve(root, "penv.config.ts"));
  });

  it("finds penv.config.mjs as well as penv.config.ts", () => {
    const root = makeProject(VALID_SOURCE, "penv.config.mjs");
    expect(findConfigFile(root)).toBe(resolve(root, "penv.config.mjs"));
  });

  it("returns undefined when no config exists at or above cwd", () => {
    const dir = makeDir();
    // A temp dir has no penv.config.* above it, so the walk reaches the root.
    expect(findConfigFile(dir)).toBeUndefined();
  });
});

describe("loadConfigFrom", () => {
  it("loads a TypeScript config through jiti", () => {
    const root = makeProject(
      [
        "interface Config { environments: string[]; providers: Record<string, { type: string }> }",
        "const config: Config = {",
        '  environments: ["development", "production"],',
        '  providers: { development: { type: "@penvhq/provider-filesystem" }, production: { type: "@penvhq/provider-filesystem" } },',
        "};",
        "export default config;",
        "",
      ].join("\n"),
    );

    const config = loadConfigFrom(resolve(root, "penv.config.ts"));

    expect(config.environments).toEqual(["development", "production"]);
    expect(config.providers.production).toEqual({ type: "@penvhq/provider-filesystem" });
    expect(validateConfig(config)).toEqual([]);
  });

  it("throws ConfigError naming the file when there is no default export", () => {
    const root = makeProject('export const config = { environments: ["production"] };\n');
    const file = resolve(root, "penv.config.ts");

    expect(() => loadConfigFrom(file)).toThrow(ConfigError);
    expect(() => loadConfigFrom(file)).toThrow(file);
    expect(() => loadConfigFrom(file)).toThrow(/no default export/);
  });

  it("throws ConfigError naming the file when the default export is not an object", () => {
    const root = makeProject('export default "production";\n');
    const file = resolve(root, "penv.config.ts");

    expect(() => loadConfigFrom(file)).toThrow(ConfigError);
    expect(() => loadConfigFrom(file)).toThrow(file);
    expect(() => loadConfigFrom(file)).toThrow(/not a configuration object/);
  });
});

describe("loadConfig", () => {
  it("loads the nearest config and reports the file it used", () => {
    const root = makeProject(VALID_SOURCE);
    const nested = join(root, "packages", "api");
    mkdirSync(nested, { recursive: true });

    const { config, file } = loadConfig(nested);

    expect(file).toBe(resolve(root, "penv.config.ts"));
    expect(config.environments).toEqual(["development", "staging", "production"]);
    expect(config.names?.["database-url"]).toBe("DATABASE_URL");
  });

  it("throws ConfigError telling the user to run penv init when no config is found", () => {
    const dir = makeDir();

    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/penv init/);
  });
});

describe("validateConfig", () => {
  it("accepts the documented example", () => {
    expect(validateConfig(valid)).toEqual([]);
  });

  it("rejects an environment named `local`", () => {
    const config: PenvConfig = {
      environments: ["local", "production"],
      providers: {
        local: { type: "@penvhq/provider-filesystem" },
        production: { type: "@penvhq/provider-filesystem" },
      },
    };

    const errors = validateConfig(config);

    expect(errors.map((error) => error.code)).toContain("RESERVED_TOKEN");
    const reserved = errors.find((error) => error.code === "RESERVED_TOKEN");
    expect(reserved?.message).toContain("local");
    expect(reserved?.message).toContain("reserved token");
  });

  it("rejects an environment named `local` when it is loaded from a real config file", () => {
    const root = makeProject(
      [
        "export default {",
        '  environments: ["local", "production"],',
        '  providers: { local: { type: "@penvhq/provider-filesystem" }, production: { type: "@penvhq/provider-filesystem" } },',
        "};",
        "",
      ].join("\n"),
    );

    const { config } = loadConfig(root);

    expect(codesFor(config)).toContain("RESERVED_TOKEN");
  });

  it("rejects every other reserved token as an environment name", () => {
    for (const token of ["enc", "json", "toml", "yml"]) {
      const config: PenvConfig = {
        environments: [token],
        providers: { [token]: { type: "@penvhq/provider-filesystem" } },
      };
      expect(codesFor(config)).toContain("RESERVED_TOKEN");
    }
  });

  it("rejects empty environments", () => {
    const config: PenvConfig = { environments: [], providers: {} };

    const errors = validateConfig(config);

    expect(errors.map((error) => error.code)).toContain("CONFIG_ENVIRONMENTS_EMPTY");
  });

  it("rejects a blank or duplicated environment name", () => {
    const blank: PenvConfig = {
      environments: ["  "],
      providers: { "  ": { type: "@penvhq/provider-filesystem" } },
    };
    expect(codesFor(blank)).toContain("CONFIG_ENVIRONMENT_INVALID");

    const duplicated: PenvConfig = {
      environments: ["production", "production"],
      providers: { production: { type: "@penvhq/provider-filesystem" } },
    };
    expect(codesFor(duplicated)).toContain("CONFIG_ENVIRONMENT_DUPLICATE");
  });

  it("rejects a declared environment with no providers entry", () => {
    const config: PenvConfig = {
      environments: ["development", "production"],
      providers: { development: { type: "@penvhq/provider-filesystem" } },
    };

    const errors = validateConfig(config);
    const missing = errors.find((error) => error.code === "PROVIDER_MISSING");

    expect(missing).toBeDefined();
    expect(missing?.message).toContain("production");
  });

  it("rejects a providers entry naming an undeclared environment", () => {
    const config: PenvConfig = {
      environments: ["development"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
        staging: { type: "@penvhq/provider-vault" },
      },
    };

    const errors = validateConfig(config);
    const unknown = errors.find((error) => error.code === "UNKNOWN_ENVIRONMENT");

    expect(unknown).toBeInstanceOf(UnknownEnvironmentError);
    expect(unknown?.message).toContain("staging");
  });

  it("reports both directions at once", () => {
    const config: PenvConfig = {
      environments: ["development", "production"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
        staging: { type: "@penvhq/provider-vault" },
      },
    };

    expect(codesFor(config)).toEqual(
      expect.arrayContaining(["PROVIDER_MISSING", "UNKNOWN_ENVIRONMENT"]),
    );
  });

  it("rejects a provider with no type", () => {
    const config = {
      environments: ["production"],
      providers: { production: { path: "secret/production" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const typeError = errors.find((error) => error.code === "PROVIDER_TYPE_MISSING");

    expect(typeError).toBeDefined();
    expect(typeError?.message).toContain("production");
  });

  it("rejects a legacy short provider type, naming the exact package rewrite", () => {
    const config: PenvConfig = {
      environments: ["production"],
      providers: { production: { type: "vault" } },
    };

    const errors = validateConfig(config);
    const legacy = errors.find((error) => error.code === "PROVIDER_TYPE_LEGACY");

    expect(legacy).toBeDefined();
    expect(legacy?.message).toContain("vault");
    expect(legacy?.remedy).toContain("@penvhq/provider-vault");
  });

  it("rejects a provider type that is not a package name", () => {
    const config: PenvConfig = {
      environments: ["production"],
      providers: { production: { type: "Not A Package!" } },
    };

    const errors = validateConfig(config);
    const invalid = errors.find((error) => error.code === "PROVIDER_TYPE_INVALID");

    expect(invalid).toBeDefined();
    expect(invalid?.message).toContain("production");
  });

  it("accepts scoped and bare package names as provider types", () => {
    const config: PenvConfig = {
      environments: ["development", "staging", "production"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
        staging: { type: "@acme/penv-provider-doppler", location: "apps/web" },
        production: { type: "penv-provider-custom" },
      },
    };

    const codes = validateConfig(config).map((error) => error.code);
    expect(codes).not.toContain("PROVIDER_TYPE_LEGACY");
    expect(codes).not.toContain("PROVIDER_TYPE_INVALID");
  });

  it("refuses a config still carrying a `sinks` block, naming the provider rewrite", () => {
    const config = {
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-filesystem" } },
      sinks: { production: { type: "github", repo: "acme/api" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const removed = errors.find((error) => error.code === "CONFIG_SINKS_REMOVED");

    expect(removed).toBeDefined();
    expect(removed?.remedy).toContain("@penvhq/provider-github");
    expect(removed?.remedy).toContain("location");
  });

  it("stays quiet about sinks for a config that never declared one", () => {
    expect(codesFor(valid)).not.toContain("CONFIG_SINKS_REMOVED");
  });

  it("rewrites the legacy `github` short type to its package", () => {
    const config: PenvConfig = {
      environments: ["production"],
      providers: { production: { type: "github" } },
    };

    const legacy = validateConfig(config).find((error) => error.code === "PROVIDER_TYPE_LEGACY");
    expect(legacy?.remedy).toContain("@penvhq/provider-github");
  });

  it("rejects an empty name override", () => {
    const config: PenvConfig = { ...valid, names: { "database-url": "" } };

    expect(codesFor(config)).toContain("NAME_OVERRIDE_EMPTY");
  });

  it("rejects two overrides mapping to the same variable, naming both keys", () => {
    const config: PenvConfig = {
      ...valid,
      names: { "database-url": "DATABASE_URL", "db/url": "DATABASE_URL" },
    };

    const errors = validateConfig(config);
    const duplicate = errors.find((error) => error.code === "NAME_OVERRIDE_DUPLICATE");

    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain("database-url");
    expect(duplicate?.message).toContain("db/url");
    expect(duplicate?.message).toContain("DATABASE_URL");
  });

  it("accepts a keys block declaring an env source per environment", () => {
    const config: PenvConfig = {
      ...valid,
      keys: {
        staging: { source: "env", id: "staging-key" },
        production: { source: "env", id: "prod.2024_key-a" },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it("accepts a config with no keys block at all", () => {
    // An environment with no entry has no key source, which is not the same as
    // having no key — and is not a misconfiguration to report.
    expect(validateConfig(valid)).toEqual([]);
  });

  it("rejects a keys entry naming an undeclared environment", () => {
    const config: PenvConfig = { ...valid, keys: { qa: { source: "env", id: "prod" } } };

    const errors = validateConfig(config);
    const unknown = errors.find((error) => error.message.includes("`keys` block"));

    expect(unknown).toBeInstanceOf(ConfigError);
    expect(unknown?.message).toContain("qa");
    expect(unknown?.remedy).toContain("whitelist");
  });

  it("rejects an id containing `:`, which separates the envelope's fields", () => {
    const config: PenvConfig = {
      ...valid,
      keys: { production: { source: "env", id: "prod:2024" } },
    };

    const errors = validateConfig(config);
    const badId = errors.find((error) => error.message.includes("declares id"));

    expect(badId).toBeInstanceOf(ConfigError);
    expect(badId?.message).toContain("production");
    expect(badId?.message).toContain("prod:2024");
    expect(badId?.remedy).toContain("`:`");
  });

  it("rejects an empty id", () => {
    const config: PenvConfig = { ...valid, keys: { production: { source: "env", id: "" } } };

    expect(validateConfig(config).some((error) => error.message.includes("declares id"))).toBe(
      true,
    );
  });

  it("rejects an unknown key source, naming the ones penv knows", () => {
    const config = {
      ...valid,
      keys: { production: { source: "vault", id: "prod" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const source = errors.find((error) => error.message.includes("declares source"));

    expect(source).toBeInstanceOf(ConfigError);
    expect(source?.message).toContain("production");
    expect(source?.message).toContain("vault");
    expect(source?.remedy).toContain("`env`");
  });

  it("accepts `keychain` as a source — it is a config-grammar name, refused at use", () => {
    // The stays-quiet half: `keychain` is a valid declaration that this release
    // cannot read. `resolveKeySource` is what refuses it, loudly, so `validate`
    // must not also report a config that is spelled correctly.
    const config: PenvConfig = {
      ...valid,
      keys: { production: { source: "keychain", id: "prod" } },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it("rejects a keys entry that is not a key-source object", () => {
    const config = { ...valid, keys: { production: "prod" } } as unknown as PenvConfig;

    const errors = validateConfig(config);

    expect(errors.some((error) => error.message.includes("not a key-source object"))).toBe(true);
  });

  it("rejects a keys block that is not an object", () => {
    const config = { ...valid, keys: ["prod"] } as unknown as PenvConfig;

    const errors = validateConfig(config);

    expect(errors.some((error) => error.message.includes("`keys` in penv.config.ts"))).toBe(true);
  });

  it("reports every bad keys entry in one pass", () => {
    const config = {
      ...valid,
      keys: {
        qa: { source: "env", id: "qa" },
        production: { source: "vault", id: "prod:2024" },
      },
    } as unknown as PenvConfig;

    expect(validateConfig(config).length).toBeGreaterThanOrEqual(3);
  });

  it("collects rather than throws", () => {
    const config: PenvConfig = { environments: [], providers: { production: { type: "" } } };

    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config).length).toBeGreaterThan(1);
  });
});

describe("assertEnvironment", () => {
  it("passes a declared environment", () => {
    expect(() => assertEnvironment("production", valid)).not.toThrow();
  });

  it("throws UnknownEnvironmentError for an undeclared environment", () => {
    expect(() => assertEnvironment("qa", valid)).toThrow(UnknownEnvironmentError);
    expect(() => assertEnvironment("qa", valid)).toThrow(/not declared in penv.config.ts/);
  });
});

describe("resolveEnvironment", () => {
  it("prefers explicit over PENV_ENV and NODE_ENV", () => {
    setEnv("PENV_ENV", "staging");
    setEnv("NODE_ENV", "development");

    expect(resolveEnvironment(valid, "production")).toBe("production");
  });

  it("prefers PENV_ENV over NODE_ENV", () => {
    setEnv("PENV_ENV", "staging");
    setEnv("NODE_ENV", "development");

    expect(resolveEnvironment(valid)).toBe("staging");
  });

  it("falls back to NODE_ENV", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", "development");

    expect(resolveEnvironment(valid)).toBe("development");
  });

  it("rejects an undeclared value from PENV_ENV", () => {
    setEnv("PENV_ENV", "qa");
    setEnv("NODE_ENV", "development");

    expect(() => resolveEnvironment(valid)).toThrow(UnknownEnvironmentError);
    expect(() => resolveEnvironment(valid)).toThrow(/qa/);
  });

  it("rejects an undeclared explicit value", () => {
    setEnv("PENV_ENV", "production");

    expect(() => resolveEnvironment(valid, "qa")).toThrow(UnknownEnvironmentError);
  });

  it("throws ConfigError explaining how to set the environment when nothing is set", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    expect(() => resolveEnvironment(valid)).toThrow(ConfigError);
    expect(() => resolveEnvironment(valid)).toThrow(/PENV_ENV/);
    expect(() => resolveEnvironment(valid)).toThrow(/development/);
  });

  it("treats a blank environment variable as unset", () => {
    setEnv("PENV_ENV", "   ");
    setEnv("NODE_ENV", "production");

    expect(resolveEnvironment(valid)).toBe("production");
  });
});
