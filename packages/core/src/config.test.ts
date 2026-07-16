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
    development: { type: "filesystem" },
    staging: { type: "vault", path: "secret/staging" },
    production: { type: "aws-ssm", path: "/prod/app" },
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
        '  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },',
        "};",
        "export default config;",
        "",
      ].join("\n"),
    );

    const config = loadConfigFrom(resolve(root, "penv.config.ts"));

    expect(config.environments).toEqual(["development", "production"]);
    expect(config.providers.production).toEqual({ type: "filesystem" });
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
      providers: { local: { type: "filesystem" }, production: { type: "filesystem" } },
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
        '  providers: { local: { type: "filesystem" }, production: { type: "filesystem" } },',
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
        providers: { [token]: { type: "filesystem" } },
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
      providers: { "  ": { type: "filesystem" } },
    };
    expect(codesFor(blank)).toContain("CONFIG_ENVIRONMENT_INVALID");

    const duplicated: PenvConfig = {
      environments: ["production", "production"],
      providers: { production: { type: "filesystem" } },
    };
    expect(codesFor(duplicated)).toContain("CONFIG_ENVIRONMENT_DUPLICATE");
  });

  it("rejects a declared environment with no providers entry", () => {
    const config: PenvConfig = {
      environments: ["development", "production"],
      providers: { development: { type: "filesystem" } },
    };

    const errors = validateConfig(config);
    const missing = errors.find((error) => error.code === "PROVIDER_MISSING");

    expect(missing).toBeDefined();
    expect(missing?.message).toContain("production");
  });

  it("rejects a providers entry naming an undeclared environment", () => {
    const config: PenvConfig = {
      environments: ["development"],
      providers: { development: { type: "filesystem" }, staging: { type: "vault" } },
    };

    const errors = validateConfig(config);
    const unknown = errors.find((error) => error.code === "UNKNOWN_ENVIRONMENT");

    expect(unknown).toBeInstanceOf(UnknownEnvironmentError);
    expect(unknown?.message).toContain("staging");
  });

  it("reports both directions at once", () => {
    const config: PenvConfig = {
      environments: ["development", "production"],
      providers: { development: { type: "filesystem" }, staging: { type: "vault" } },
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
