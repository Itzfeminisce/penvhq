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
import { environmentEntry } from "./types.js";

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
  environments: {
    development: "@penvhq/provider-filesystem",
    staging: { provider: "@penvhq/provider-vault", path: "secret/staging" },
    production: { provider: "@penvhq/provider-ssm", path: "/prod/app" },
  },
  override: { "database-url": "DATABASE_URL" },
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

  it("stops at the workspace root rather than climbing past it", () => {
    // The shape of a container image: a config one layer above the deployed
    // bundle is a config belonging to something else. Climbing to it would
    // resolve the whole application from a stranger's file.
    const outer = makeDir();
    writeFileSync(join(outer, "penv.config.ts"), VALID_SOURCE, "utf8");
    const bundle = join(outer, "var", "task");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, ".git"), "gitdir: elsewhere\n", "utf8");

    expect(findConfigFile(bundle)).toBeUndefined();
  });

  it("stops at the outermost package.json when no workspace marker is above it", () => {
    const outer = makeDir();
    writeFileSync(join(outer, "penv.config.ts"), VALID_SOURCE, "utf8");
    const bundle = join(outer, "var", "task");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "package.json"), '{ "name": "bundle" }\n', "utf8");

    expect(findConfigFile(bundle)).toBeUndefined();
  });

  it("climbs through a package boundary to the workspace that contains it", () => {
    // A monorepo app reads the config at the repo root, so a package.json in
    // `apps/web` must not stop the walk — only the workspace root does.
    const root = makeProject(VALID_SOURCE);
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n', "utf8");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), '{ "name": "web" }\n', "utf8");

    expect(findConfigFile(app)).toBe(resolve(root, "penv.config.ts"));
  });

  it("treats a package.json with `workspaces` as the workspace root", () => {
    const root = makeProject(VALID_SOURCE);
    writeFileSync(join(root, "package.json"), '{ "workspaces": ["apps/*"] }\n', "utf8");
    const app = join(root, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), '{ "name": "web" }\n', "utf8");

    expect(findConfigFile(app)).toBe(resolve(root, "penv.config.ts"));
  });
});

describe("an environment named after an Object.prototype member", () => {
  it("is a declared environment when the record declares it", () => {
    const config: PenvConfig = { environments: { constructor: "@penvhq/provider-filesystem" } };

    expect(codesFor(config)).toEqual([]);
    expect(environmentEntry(config, "constructor")).toEqual({
      provider: "@penvhq/provider-filesystem",
    });
  });

  it("is undeclared when nothing declares it, rather than answering with `Object`", () => {
    // A bare index for `constructor` answers with `Object` — an entry penv was
    // never given, read as a provider it would then try to build.
    expect(environmentEntry(valid, "constructor")).toBeUndefined();
    expect(() => assertEnvironment("constructor", valid)).toThrow(UnknownEnvironmentError);
  });
});

describe("loadConfigFrom", () => {
  it("loads a TypeScript config through jiti", () => {
    const root = makeProject(
      [
        "interface Config { environments: Record<string, string | { provider: string }> }",
        "const config: Config = {",
        "  environments: {",
        '    development: "@penvhq/provider-filesystem",',
        '    production: { provider: "@penvhq/provider-ssm" },',
        "  },",
        "};",
        "export default config;",
        "",
      ].join("\n"),
    );

    const config = loadConfigFrom(resolve(root, "penv.config.ts"));

    expect(Object.keys(config.environments)).toEqual(["development", "production"]);
    expect(environmentEntry(config, "production")).toEqual({ provider: "@penvhq/provider-ssm" });
    expect(environmentEntry(config, "development")).toEqual({
      provider: "@penvhq/provider-filesystem",
    });
    expect(validateConfig(config)).toEqual([]);
  });

  it("throws ConfigError naming the file when there is no default export", () => {
    const root = makeProject(
      'export const config = { environments: { production: "@penvhq/provider-ssm" } };\n',
    );
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

  /**
   * The migration is refused where the config enters the system, not only in
   * `penv validate`. Nothing past this point can read the old spine: `environments`
   * as a list has keys `"0"` and `"1"`, and the first command to touch it reports
   * an environment name as an unknown provider package.
   */
  it("refuses the pre-0.14 spine at load, before any command reads it", () => {
    const root = makeProject(
      [
        "export default {",
        '  environments: ["development", "production"],',
        '  providers: { production: { type: "@penvhq/provider-vercel", location: "penv-cloud" } },',
        '  keys: { production: { source: "env", id: "production" } },',
        "};",
        "",
      ].join("\n"),
    );

    expect(() => loadConfigFrom(resolve(root, "penv.config.ts"))).toThrowError(
      expect.objectContaining({ code: "CONFIG_ENVIRONMENTS_MERGED" }),
    );
  });

  it("refuses a config that kept a top-level `keys` block beside the new record", () => {
    const root = makeProject(
      [
        "export default {",
        '  environments: { production: { provider: "@penvhq/provider-ssm", path: "penv" } },',
        '  keys: { production: { source: "env" } },',
        "};",
        "",
      ].join("\n"),
    );

    expect(() => loadConfigFrom(resolve(root, "penv.config.ts"))).toThrowError(
      expect.objectContaining({ code: "CONFIG_ENVIRONMENTS_MERGED" }),
    );
  });
});

describe("loadConfig", () => {
  it("loads the nearest config and reports the file it used", () => {
    const root = makeProject(VALID_SOURCE);
    const nested = join(root, "packages", "api");
    mkdirSync(nested, { recursive: true });

    const { config, file } = loadConfig(nested);

    expect(file).toBe(resolve(root, "penv.config.ts"));
    expect(Object.keys(config.environments)).toEqual(["development", "staging", "production"]);
    expect(config.override?.["database-url"]).toBe("DATABASE_URL");
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
      environments: {
        local: "@penvhq/provider-filesystem",
        production: "@penvhq/provider-filesystem",
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
        "  environments: {",
        '    local: "@penvhq/provider-filesystem",',
        '    production: "@penvhq/provider-filesystem",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const { config } = loadConfig(root);

    expect(codesFor(config)).toContain("RESERVED_TOKEN");
  });

  it("rejects every other reserved token as an environment name", () => {
    for (const token of ["enc", "json", "toml", "yml"]) {
      const config: PenvConfig = { environments: { [token]: "@penvhq/provider-filesystem" } };
      expect(codesFor(config)).toContain("RESERVED_TOKEN");
    }
  });

  it("rejects empty environments", () => {
    const config: PenvConfig = { environments: {} };

    const errors = validateConfig(config);

    expect(errors.map((error) => error.code)).toContain("CONFIG_ENVIRONMENTS_EMPTY");
  });

  it("rejects an `environments` that is not an object", () => {
    const config = { environments: "production" } as unknown as PenvConfig;

    expect(codesFor(config)).toContain("CONFIG_ENVIRONMENTS_INVALID");
  });

  it("rejects a blank environment name", () => {
    const blank: PenvConfig = { environments: { "  ": "@penvhq/provider-filesystem" } };

    expect(codesFor(blank)).toContain("CONFIG_ENVIRONMENT_INVALID");
  });

  it("rejects an entry that is neither a package name nor an entry object", () => {
    const config = { environments: { production: 7 } } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const invalid = errors.find((error) => error.code === "ENVIRONMENT_ENTRY_INVALID");

    expect(invalid).toBeDefined();
    expect(invalid?.message).toContain("production");
    expect(invalid?.remedy).toContain("provider");
  });

  it("rejects an entry object with no provider", () => {
    const config = {
      environments: { production: { path: "secret/production" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const missing = errors.find((error) => error.code === "PROVIDER_MISSING");

    expect(missing).toBeDefined();
    expect(missing?.message).toContain("production");
  });

  it("rejects a legacy short provider name, naming the exact package rewrite", () => {
    const config = { environments: { production: "vault" } } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const legacy = errors.find((error) => error.code === "PROVIDER_LEGACY");

    expect(legacy).toBeDefined();
    expect(legacy?.message).toContain("vault");
    expect(legacy?.remedy).toContain("@penvhq/provider-vault");
  });

  it("rejects a provider that is not a package name", () => {
    const config = {
      environments: { production: { provider: "Not A Package!" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const invalid = errors.find((error) => error.code === "PROVIDER_INVALID");

    expect(invalid).toBeDefined();
    expect(invalid?.message).toContain("production");
  });

  it("accepts scoped and bare package names, in both entry forms", () => {
    const config: PenvConfig = {
      environments: {
        development: "@penvhq/provider-filesystem",
        staging: { provider: "@acme/penv-provider-doppler", project: "apps/web" },
        production: "penv-provider-custom",
      },
    };

    const codes = validateConfig(config).map((error) => error.code);
    expect(codes).not.toContain("PROVIDER_LEGACY");
    expect(codes).not.toContain("PROVIDER_INVALID");
  });

  it("rewrites the legacy `github` short name to its package", () => {
    const config = {
      environments: { production: { provider: "github" } },
    } as unknown as PenvConfig;

    const legacy = validateConfig(config).find((error) => error.code === "PROVIDER_LEGACY");
    expect(legacy?.remedy).toContain("@penvhq/provider-github");
  });

  it("refuses a config still carrying a `names` block, naming the rename", () => {
    const config = {
      environments: { production: "@penvhq/provider-filesystem" },
      names: { "database-url": "DATABASE_URL" },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);
    const renamed = errors.find((error) => error.code === "CONFIG_NAMES_RENAMED");

    expect(renamed).toBeDefined();
    expect(renamed?.remedy).toContain("override");
  });

  it("stays quiet about the rename for a config that uses `override`", () => {
    expect(codesFor(valid)).not.toContain("CONFIG_NAMES_RENAMED");
  });

  it("rejects an empty name override", () => {
    const config: PenvConfig = { ...valid, override: { "database-url": "" } };

    expect(codesFor(config)).toContain("OVERRIDE_EMPTY");
  });

  it("rejects two overrides mapping to the same variable, naming both keys", () => {
    const config: PenvConfig = {
      ...valid,
      override: { "database-url": "DATABASE_URL", "db/url": "DATABASE_URL" },
    };

    const errors = validateConfig(config);
    const duplicate = errors.find((error) => error.code === "OVERRIDE_DUPLICATE");

    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain("database-url");
    expect(duplicate?.message).toContain("db/url");
    expect(duplicate?.message).toContain("DATABASE_URL");
  });

  it("accepts a keySource in both its forms", () => {
    const config: PenvConfig = {
      environments: {
        development: "@penvhq/provider-filesystem",
        staging: { provider: "@penvhq/provider-vault", keySource: "env" },
        production: {
          provider: "@penvhq/provider-ssm",
          keySource: { source: "env", id: "prod.2024_key-a" },
        },
      },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it("accepts a config where no environment declares a keySource", () => {
    // An environment with none has no key source, which is not the same as
    // having no key — and is not a misconfiguration to report.
    expect(validateConfig(valid)).toEqual([]);
  });

  it("rejects an id containing `:`, which separates the envelope's fields", () => {
    const config: PenvConfig = {
      environments: {
        production: {
          provider: "@penvhq/provider-ssm",
          keySource: { source: "env", id: "p:2024" },
        },
      },
    };

    const errors = validateConfig(config);
    const badId = errors.find((error) => error.message.includes("declares id"));

    expect(badId).toBeInstanceOf(ConfigError);
    expect(badId?.message).toContain("production");
    expect(badId?.message).toContain("p:2024");
    expect(badId?.remedy).toContain("`:`");
  });

  it("rejects an empty id", () => {
    const config: PenvConfig = {
      environments: {
        production: { provider: "@penvhq/provider-ssm", keySource: { source: "env", id: "" } },
      },
    };

    expect(validateConfig(config).some((error) => error.message.includes("declares id"))).toBe(
      true,
    );
  });

  it("rejects an unknown key source in either form, naming the ones penv knows", () => {
    for (const keySource of ["vault", { source: "vault", id: "prod" }]) {
      const config = {
        environments: { production: { provider: "@penvhq/provider-ssm", keySource } },
      } as unknown as PenvConfig;

      const errors = validateConfig(config);
      const source = errors.find((error) => error.message.includes("declares source"));

      expect(source).toBeInstanceOf(ConfigError);
      expect(source?.message).toContain("production");
      expect(source?.message).toContain("vault");
      expect(source?.remedy).toContain("`env`");
    }
  });

  it("accepts `keychain` as a source — it is a config-grammar name, refused at use", () => {
    // The stays-quiet half: `keychain` is a valid declaration that this release
    // cannot read. `resolveKeySource` is what refuses it, loudly, so `validate`
    // must not also report a config that is spelled correctly.
    const config: PenvConfig = {
      environments: { production: { provider: "@penvhq/provider-ssm", keySource: "keychain" } },
    };

    expect(validateConfig(config)).toEqual([]);
  });

  it("rejects a keySource that is neither a source name nor a source object", () => {
    const config = {
      environments: { production: { provider: "@penvhq/provider-ssm", keySource: ["env"] } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);

    expect(errors.some((error) => error.message.includes("is not a key source"))).toBe(true);
  });

  it("reports every bad keySource in one pass", () => {
    const config = {
      environments: {
        staging: { provider: "@penvhq/provider-vault", keySource: "aws-kms" },
        production: { provider: "@penvhq/provider-ssm", keySource: { source: "vault", id: "p:1" } },
      },
    } as unknown as PenvConfig;

    expect(validateConfig(config).length).toBeGreaterThanOrEqual(3);
  });

  it("collects rather than throws", () => {
    const config = {
      environments: { "  ": "@penvhq/provider-filesystem", production: { provider: "" } },
    } as unknown as PenvConfig;

    expect(() => validateConfig(config)).not.toThrow();
    expect(validateConfig(config).length).toBeGreaterThan(1);
  });
});

/**
 * The old spine — three parallel structures for one fact — is refused with the
 * whole move named. No compat shim: one release, one migration error.
 */
describe("the merged `environments` record", () => {
  it("refuses a config whose `environments` is still a list", () => {
    const config = {
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-vercel", location: "penv-cloud" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CONFIG_ENVIRONMENTS_MERGED");
    expect(errors[0]?.message).toContain("`environments` as a list");
    expect(errors[0]?.message).toContain("`providers` block");
  });

  it("refuses a top-level `keys` block, naming its new home", () => {
    const config = {
      environments: { production: "@penvhq/provider-filesystem" },
      keys: { production: { source: "env", id: "production" } },
    } as unknown as PenvConfig;

    const errors = validateConfig(config);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CONFIG_ENVIRONMENTS_MERGED");
    expect(errors[0]?.message).toContain("`keys` block");
  });

  it("names every move, so one refusal is the whole migration", () => {
    const config = {
      environments: ["production"],
      providers: {},
      keys: {},
    } as unknown as PenvConfig;

    const remedy = validateConfig(config)[0]?.remedy ?? "";

    for (const move of ["`provider`", "`project`", "`target`", "`keySource`"]) {
      expect(remedy).toContain(move);
    }
    // Before and after, both spelled out — the config edit is a copy, not a guess.
    expect(remedy).toContain('type: "@penvhq/provider-vercel"');
    expect(remedy).toContain('provider: "@penvhq/provider-vercel"');
  });

  it("stays quiet for a config on the new shape", () => {
    expect(codesFor(valid)).not.toContain("CONFIG_ENVIRONMENTS_MERGED");
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

  /** Seal 3: the refusal names both remedies — the flag, and the declared key. */
  it("throws ConfigError naming both remedies when nothing is set", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    expect(() => resolveEnvironment(valid)).toThrow(ConfigError);
    expect(() => resolveEnvironment(valid)).toThrow(/--env <environment>/);
    expect(() => resolveEnvironment(valid)).toThrow(/defaultEnvironment/);
    expect(() => resolveEnvironment(valid)).toThrow(/development/);
  });

  it("treats a blank environment variable as unset", () => {
    setEnv("PENV_ENV", "   ");
    setEnv("NODE_ENV", "production");

    expect(resolveEnvironment(valid)).toBe("production");
  });
});

/**
 * Seal 3. The key answers where the refusal used to be, and nowhere else: it is
 * a standing decision, and `PENV_ENV`/`NODE_ENV` are what this invocation says.
 */
describe("defaultEnvironment", () => {
  const withDefault: PenvConfig = { ...valid, defaultEnvironment: "development" };

  it("answers when nothing else does", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    expect(resolveEnvironment(withDefault)).toBe("development");
  });

  it("loses to an explicit environment", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    expect(resolveEnvironment(withDefault, "production")).toBe("production");
  });

  it("loses to PENV_ENV and to NODE_ENV", () => {
    setEnv("PENV_ENV", "staging");
    setEnv("NODE_ENV", undefined);
    expect(resolveEnvironment(withDefault)).toBe("staging");

    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", "production");
    expect(resolveEnvironment(withDefault)).toBe("production");
  });

  /** Invariant 10: the whitelist judges the default like any other name. */
  it("refuses a default the whitelist does not carry", () => {
    setEnv("PENV_ENV", undefined);
    setEnv("NODE_ENV", undefined);

    expect(() => resolveEnvironment({ ...valid, defaultEnvironment: "qa" })).toThrow(
      UnknownEnvironmentError,
    );
    expect(codesFor({ ...valid, defaultEnvironment: "qa" })).toContain("UNKNOWN_ENVIRONMENT");
  });

  it("refuses a default that is not a name at all", () => {
    expect(codesFor({ ...valid, defaultEnvironment: "  " })).toContain("CONFIG");
    expect(codesFor({ ...valid, defaultEnvironment: 3 as unknown as string })).toContain("CONFIG");
  });

  it("stays quiet for a declared default", () => {
    expect(codesFor(withDefault)).toEqual(codesFor(valid));
  });
});
