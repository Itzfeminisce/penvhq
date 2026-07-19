import { describe, expect, it } from "vitest";
import {
  FilenameGrammarError,
  IllegalEnvironmentNameError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
} from "./errors.js";
import {
  formatMetaFile,
  formatValueFile,
  isParameterFile,
  isReservedToken,
  parameterId,
  parseFilename,
  reservedTokensFor,
  validateEnvironmentNames,
} from "./grammar.js";
import type { ParsedFile, PenvConfig, Scope, ValueFile } from "./types.js";

/** The reserved tokens among a collected batch. `validateEnvironmentNames` reports two kinds. */
function tokensOf(errors: readonly PenvError[]): string[] {
  return errors.filter((e) => e instanceof ReservedTokenError).map((e) => e.token);
}

const config: PenvConfig = {
  environments: ["development", "staging", "production", "test"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    staging: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
    test: { type: "@penvhq/provider-filesystem" },
  },
};

describe("parseFilename — valid value forms", () => {
  it("parses an unscoped default at the root", () => {
    expect(parseFilename("database-url", config)).toEqual({
      kind: "value",
      namespace: [],
      name: "database-url",
      scope: { kind: "unscoped" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  it("parses an environment scope", () => {
    expect(parseFilename("redis/password.production", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "environment", environment: "production" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  it("parses a personal override", () => {
    expect(parseFilename("app/jwt-secret.local", config)).toEqual({
      kind: "value",
      namespace: ["app"],
      name: "jwt-secret",
      scope: { kind: "local" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  it("parses a personal override for one environment", () => {
    expect(parseFilename("app/jwt-secret.development.local", config)).toEqual({
      kind: "value",
      namespace: ["app"],
      name: "jwt-secret",
      scope: { kind: "environment-local", environment: "development" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  it("parses a personal override for one environment in a nested namespace", () => {
    expect(parseFilename("redis/password.production.local", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "environment-local", environment: "production" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  it("parses a terminal .enc after an environment-scoped personal override", () => {
    expect(parseFilename("services/billing/stripe/secret-key.staging.local.enc", config)).toEqual({
      kind: "value",
      namespace: ["services", "billing", "stripe"],
      name: "secret-key",
      scope: { kind: "environment-local", environment: "staging" },
      encrypted: true,
    } satisfies ParsedFile);
  });

  it("parses a terminal .enc on the unscoped default", () => {
    expect(parseFilename("redis/password.enc", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "unscoped" },
      encrypted: true,
    } satisfies ParsedFile);
  });

  it("parses a terminal .enc after an environment scope", () => {
    expect(parseFilename("redis/password.production.enc", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "environment", environment: "production" },
      encrypted: true,
    } satisfies ParsedFile);
  });

  it("parses a terminal .enc after a personal override", () => {
    expect(parseFilename("redis/password.local.enc", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "local" },
      encrypted: true,
    } satisfies ParsedFile);
  });

  it("parses nested namespaces", () => {
    expect(parseFilename("services/billing/stripe/secret-key.staging.enc", config)).toEqual({
      kind: "value",
      namespace: ["services", "billing", "stripe"],
      name: "secret-key",
      scope: { kind: "environment", environment: "staging" },
      encrypted: true,
    } satisfies ParsedFile);
  });

  it("normalises Windows separators and a leading ./", () => {
    expect(parseFilename(".\\app\\redis\\password.production", config)).toEqual(
      parseFilename("app/redis/password.production", config),
    );
  });

  it("treats a declared `test` environment as a normal environment scope", () => {
    expect(parseFilename("api-url.test", config)).toEqual({
      kind: "value",
      namespace: [],
      name: "api-url",
      scope: { kind: "environment", environment: "test" },
      encrypted: false,
    } satisfies ParsedFile);
  });
});

describe("parseFilename — meta forms", () => {
  it("parses a json meta file", () => {
    expect(parseFilename("redis/password.json", config)).toEqual({
      kind: "meta",
      namespace: ["redis"],
      name: "password",
      format: "json",
    } satisfies ParsedFile);
  });

  // `.toml`/`.yml` are reserved by the grammar from day one, but the roadmap puts
  // the formats post-v1.0. Reserving without implementing is loud, never silent:
  // a policy file penv ignored would apply no policy with no diagnostic.
  it.each(["toml", "yml"])("throws META_FORMAT_UNSUPPORTED for a %s meta file", (format) => {
    let thrown: unknown;
    try {
      parseFilename(`redis/password.${format}`, config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PenvError);
    expect((thrown as PenvError).code).toBe("META_FORMAT_UNSUPPORTED");
    // Names the file and points at the format that works.
    expect((thrown as PenvError).message).toMatch(/redis\/password\.toml|redis\/password\.yml/);
    expect((thrown as PenvError).message).toMatch(/redis\/password\.json/);
  });

  it("still reports the more specific grammar error before the format is considered", () => {
    expect(() => parseFilename("redis/password.toml.enc", config)).toThrow(FilenameGrammarError);
    expect(() => parseFilename("redis/password.production.yml", config)).toThrow(
      FilenameGrammarError,
    );
  });
});

describe("parseFilename — errors", () => {
  it("rejects .enc before a scope segment", () => {
    expect(() => parseFilename("redis/password.enc.production", config)).toThrow(
      FilenameGrammarError,
    );
    expect(() => parseFilename("redis/password.enc.production", config)).toThrow(
      /terminal|redis\/password\.production\.enc/,
    );
  });

  it("rejects .enc before .local", () => {
    expect(() => parseFilename("redis/password.enc.local", config)).toThrow(FilenameGrammarError);
  });

  it("rejects an encrypted meta file", () => {
    expect(() => parseFilename("redis/password.json.enc", config)).toThrow(FilenameGrammarError);
    expect(() => parseFilename("redis/password.json.enc", config)).toThrow(/plaintext/);
  });

  it("rejects a meta file carrying a scope", () => {
    expect(() => parseFilename("redis/password.production.json", config)).toThrow(
      FilenameGrammarError,
    );
  });

  it("rejects two scope segments", () => {
    expect(() => parseFilename("redis/password.production.staging", config)).toThrow(
      FilenameGrammarError,
    );
    expect(() => parseFilename("redis/password.production.staging.enc", config)).toThrow(
      FilenameGrammarError,
    );
  });

  it("rejects more than two scope segments even when the last is `local`", () => {
    expect(() => parseFilename("redis/password.production.staging.local", config)).toThrow(
      FilenameGrammarError,
    );
    expect(() => parseFilename("redis/password.production.staging.local.enc", config)).toThrow(
      FilenameGrammarError,
    );
    expect(() => parseFilename("redis/password.local.local", config)).toThrow(FilenameGrammarError);
  });

  // The reverse spelling is an error, not a synonym: one cascade level must not
  // be addressable by two names.
  it("rejects `.local` before the environment and names the correct spelling", () => {
    expect(() => parseFilename("redis/password.local.production", config)).toThrow(
      FilenameGrammarError,
    );
    expect(() => parseFilename("redis/password.local.production", config)).toThrow(
      /environment segment always precedes `local`/,
    );
    expect(() => parseFilename("redis/password.local.production", config)).toThrow(
      /redis\/password\.production\.local/,
    );
  });

  it("names the correct encrypted spelling when `.local` precedes the environment", () => {
    expect(() => parseFilename("redis/password.local.production.enc", config)).toThrow(
      /redis\/password\.production\.local\.enc/,
    );
  });

  // A remedy that names a filename penv also rejects is not a remedy. The
  // ordering complaint is only true once the segment could genuinely be an
  // environment, so the suggestion must itself parse.
  it.each(["redis/password.local.production", "redis/password.local.production.enc"])(
    "suggests a filename that parses, for `%s`",
    (path) => {
      let thrown: unknown;
      try {
        parseFilename(path, config);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(FilenameGrammarError);
      const suggestion = /Rename it to `([^`]+)`/.exec(
        (thrown as FilenameGrammarError).message,
      )?.[1];
      expect(suggestion).toBeDefined();
      expect(() => parseFilename(suggestion as string, config)).not.toThrow();
      expect(parseFilename(suggestion as string, config)).toMatchObject({
        kind: "value",
        scope: { kind: "environment-local", environment: "production" },
      });
    },
  );

  // The segment before `local` is an environment only because it was declared
  // (invariant 10). `.local.<undeclared>` is the mirror of `.<undeclared>.local`
  // and must be diagnosed identically — an ordering complaint would assert the
  // segment IS the environment, which is false.
  it("rejects `.local` before an undeclared environment with the environment error", () => {
    expect(() => parseFilename("redis/password.local.prod", config)).toThrow(
      UnknownEnvironmentError,
    );
    expect(() => parseFilename("redis/password.local.prod", config)).toThrow(
      /Environment prod is not declared/,
    );
    expect(() => parseFilename("redis/password.local.qa.enc", config)).toThrow(
      UnknownEnvironmentError,
    );
    expect(() => parseFilename("redis/password.local.qa.enc", config)).toThrow(/`production`/);
  });

  it("rejects `.local` before an implausible segment with the grammar error", () => {
    expect(() => parseFilename("redis/password.local.3x!", config)).toThrow(FilenameGrammarError);
    expect(() => parseFilename("redis/password.local.3x!", config)).toThrow(
      /`3x!` is not an environment/,
    );
    expect(() => parseFilename("redis/password.local.3x!.enc", config)).toThrow(
      /`3x!` is not an environment/,
    );
  });

  // Neither order may claim an undeclared segment is the environment.
  it("diagnoses `.local.<segment>` exactly as its mirror `.<segment>.local` does", () => {
    for (const segment of ["prod", "3x!"]) {
      const diagnose = (path: string): string => {
        try {
          parseFilename(path, config);
        } catch (error) {
          return (error as PenvError).code;
        }
        throw new Error(`${path} parsed but should not have`);
      };
      expect(diagnose(`redis/password.local.${segment}`)).toBe(
        diagnose(`redis/password.${segment}.local`),
      );
    }
  });

  it("rejects an undeclared environment before `.local` with the environment error", () => {
    expect(() => parseFilename("redis/password.prod.local", config)).toThrow(
      UnknownEnvironmentError,
    );
    expect(() => parseFilename("redis/password.prod.local", config)).toThrow(
      /Environment prod is not declared/,
    );
    expect(() => parseFilename("redis/password.qa.local.enc", config)).toThrow(/`production`/);
  });

  it("rejects an implausible segment before `.local` with the grammar error", () => {
    expect(() => parseFilename("redis/password.3x!.local", config)).toThrow(FilenameGrammarError);
  });

  it("never infers the environment of a `<env>.local` file from its namespace folder", () => {
    expect(() => parseFilename("production/redis/password.prod.local", config)).toThrow(
      UnknownEnvironmentError,
    );
  });

  it("rejects an undeclared environment segment with the environment error", () => {
    expect(() => parseFilename("redis/password.prod", config)).toThrow(UnknownEnvironmentError);
    expect(() => parseFilename("redis/password.prod", config)).toThrow(
      /Environment prod is not declared/,
    );
  });

  it("names the declared whitelist in the unknown-environment remedy", () => {
    expect(() => parseFilename("redis/password.qa.enc", config)).toThrow(/`production`/);
  });

  it("never infers an environment from a namespace folder", () => {
    expect(() => parseFilename("production/redis/password.prod", config)).toThrow(
      UnknownEnvironmentError,
    );
  });

  it("rejects an implausible segment with the grammar error", () => {
    expect(() => parseFilename("redis/password.3x!", config)).toThrow(FilenameGrammarError);
  });

  it("rejects empty dot segments", () => {
    expect(() => parseFilename("redis/password.", config)).toThrow(FilenameGrammarError);
    expect(() => parseFilename("redis/password..production", config)).toThrow(FilenameGrammarError);
  });

  it("rejects a path that names no parameter", () => {
    expect(() => parseFilename("", config)).toThrow(FilenameGrammarError);
  });

  it("rejects `..` as a namespace", () => {
    expect(() => parseFilename("../../etc/passwd.production", config)).toThrow(
      FilenameGrammarError,
    );
  });
});

describe("parseFilename — reserved parameter names", () => {
  it.each(["enc", "json", "toml", "yml", "local"])("rejects a parameter named `%s`", (token) => {
    expect(() => parseFilename(`redis/${token}`, config)).toThrow(ReservedTokenError);
    expect(() => parseFilename(`redis/${token}.production`, config)).toThrow(ReservedTokenError);
  });

  it("rejects a parameter named `enc` today, before encryption exists", () => {
    // The roadmap reserves `enc` from day one so that reserving it at v0.3 is
    // not a migration. This test is the reservation.
    expect(() => parseFilename("enc", config)).toThrow(ReservedTokenError);
    let thrown: unknown;
    try {
      parseFilename("secrets/enc", config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReservedTokenError);
    expect((thrown as ReservedTokenError).token).toBe("enc");
    expect((thrown as ReservedTokenError).code).toBe("RESERVED_TOKEN");
    expect((thrown as ReservedTokenError).message).toMatch(/reserved token/);
  });

  it.each(["development", "staging", "production", "test"])(
    "rejects a parameter named after the declared environment `%s`",
    (environment) => {
      expect(() => parseFilename(environment, config)).toThrow(ReservedTokenError);
      expect(() => parseFilename(`redis/${environment}`, config)).toThrow(ReservedTokenError);
      expect(() => parseFilename(`redis/${environment}.staging`, config)).toThrow(
        ReservedTokenError,
      );
    },
  );

  it("names the colliding token in the environment-collision error", () => {
    let thrown: unknown;
    try {
      parseFilename("production", config);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReservedTokenError);
    expect((thrown as ReservedTokenError).token).toBe("production");
    expect((thrown as ReservedTokenError).code).toBe("RESERVED_TOKEN");
  });

  // The negative case: reservation is config-driven (invariant 10), never
  // inferred. `production` is only reserved because this config declares it.
  it("accepts a parameter named `production` when production is not a declared environment", () => {
    const bare: PenvConfig = { environments: ["development"], providers: {} };
    expect(parseFilename("redis/production", bare)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "production",
      scope: { kind: "unscoped" },
      encrypted: false,
    } satisfies ParsedFile);
  });

  // Reservation applies to the parameter NAME only. The scope segment is the
  // environment doing its job — this must keep working.
  it("keeps `<name>.production` valid as a scope segment", () => {
    expect(parseFilename("redis/password.production", config)).toEqual({
      kind: "value",
      namespace: ["redis"],
      name: "password",
      scope: { kind: "environment", environment: "production" },
      encrypted: false,
    } satisfies ParsedFile);
    expect(parseFilename("redis/password.production.enc", config)).toMatchObject({
      scope: { kind: "environment", environment: "production" },
      encrypted: true,
    });
  });

  it("keeps `<name>.production.local` valid as a scope segment", () => {
    expect(parseFilename("redis/password.production.local", config)).toMatchObject({
      scope: { kind: "environment-local", environment: "production" },
      encrypted: false,
    });
  });

  // The negative case for the `<env>.local` position: the environment is an
  // environment because it was declared, never because it precedes `local`.
  it("rejects `<name>.production.local` when production is not a declared environment", () => {
    const bare: PenvConfig = { environments: ["development"], providers: {} };
    expect(() => parseFilename("redis/password.production.local", bare)).toThrow(
      UnknownEnvironmentError,
    );
    expect(parseFilename("redis/password.development.local", bare)).toMatchObject({
      scope: { kind: "environment-local", environment: "development" },
    });
  });

  it("does not reserve an environment name as a namespace folder", () => {
    expect(parseFilename("production/password.staging", config)).toMatchObject({
      namespace: ["production"],
      name: "password",
    });
  });
});

describe("isParameterFile", () => {
  it.each([".DS_Store", ".gitignore", ".penvignore", "redis/.DS_Store", "env.ts"])(
    "ignores `%s`",
    (path) => {
      expect(isParameterFile(path, config)).toBe(false);
    },
  );

  it.each(["password", "redis/password.production", "redis/password.json", "app/jwt-secret.local"])(
    "accepts `%s`",
    (path) => {
      expect(isParameterFile(path, config)).toBe(true);
    },
  );

  it("normalises Windows separators before taking the basename", () => {
    expect(isParameterFile(".\\redis\\.DS_Store", config)).toBe(false);
    expect(isParameterFile(".\\redis\\password.production", config)).toBe(true);
  });

  it("ignores a path that names no file", () => {
    expect(isParameterFile("", config)).toBe(false);
  });

  // The defect this predicate exists to prevent: a stray dotfile the user never
  // created must not make `list`/`load` fail hard.
  it("filters the files that would otherwise throw on an empty leading segment", () => {
    expect(() => parseFilename(".DS_Store", config)).toThrow(FilenameGrammarError);
    expect(isParameterFile(".DS_Store", config)).toBe(false);
  });

  /**
   * The schema is skipped for living where the config says, not for being called
   * `env.ts`. A project that moved it out has nothing here to skip — so `env.ts`
   * in the tree becomes an ordinary parameter named `env`, because that is what
   * it would be.
   */
  describe("when the project moved its schema out of the tree", () => {
    const moved: PenvConfig = { ...config, schemaFile: "src/env.ts" };

    it("stops skipping `env.ts` in the tree", () => {
      expect(isParameterFile("env.ts", moved)).toBe(true);
    });

    it("still ignores the files penv never wrote", () => {
      expect(isParameterFile(".DS_Store", moved)).toBe(false);
      expect(isParameterFile(".gitignore", moved)).toBe(false);
    });
  });

  it("skips the schema wherever inside the tree the config puts it", () => {
    const renamed: PenvConfig = { ...config, schemaFile: ".penv/schema.ts" };

    expect(isParameterFile("schema.ts", renamed)).toBe(false);
    // And `env.ts` is no longer special, because nothing declares it.
    expect(isParameterFile("env.ts", renamed)).toBe(true);
  });

  /** A nested schema is one path, not one basename: only that path is skipped. */
  it("skips a namespaced schema by its whole path", () => {
    const nested: PenvConfig = { ...config, schemaFile: ".penv/config/env.ts" };

    expect(isParameterFile("config/env.ts", nested)).toBe(false);
    expect(isParameterFile("other/env.ts", nested)).toBe(true);
  });
});

describe("formatValueFile / formatMetaFile / parameterId", () => {
  it("formats every value scope as a relative posix path", () => {
    expect(
      formatValueFile({
        namespace: ["redis"],
        name: "password",
        scope: { kind: "environment", environment: "production" },
        encrypted: true,
      }),
    ).toBe("redis/password.production.enc");
    expect(
      formatValueFile({
        namespace: [],
        name: "database-url",
        scope: { kind: "unscoped" },
        encrypted: false,
      }),
    ).toBe("database-url");
    expect(
      formatValueFile({
        namespace: ["app"],
        name: "jwt-secret",
        scope: { kind: "local" },
        encrypted: false,
      }),
    ).toBe("app/jwt-secret.local");
    expect(
      formatValueFile({
        namespace: ["app"],
        name: "jwt-secret",
        scope: { kind: "environment-local", environment: "development" },
        encrypted: false,
      }),
    ).toBe("app/jwt-secret.development.local");
  });

  // The environment precedes `local`, and `.enc` stays terminal behind both.
  it("formats an environment-scoped personal override with .enc last", () => {
    expect(
      formatValueFile({
        namespace: ["redis"],
        name: "password",
        scope: { kind: "environment-local", environment: "production" },
        encrypted: true,
      }),
    ).toBe("redis/password.production.local.enc");
  });

  it("formats meta files", () => {
    expect(formatMetaFile({ namespace: ["redis"], name: "password", format: "json" })).toBe(
      "redis/password.json",
    );
    expect(formatMetaFile({ namespace: [], name: "database-url", format: "json" })).toBe(
      "database-url.json",
    );
  });

  it("builds dotted parameter ids", () => {
    expect(parameterId({ namespace: ["redis"], name: "password" })).toBe("redis.password");
    expect(parameterId({ namespace: [], name: "database-url" })).toBe("database-url");
    expect(parameterId({ namespace: ["services", "billing"], name: "key" })).toBe(
      "services.billing.key",
    );
  });
});

describe("round trip", () => {
  const scopes: Scope[] = [
    { kind: "unscoped" },
    { kind: "environment", environment: "development" },
    { kind: "environment", environment: "production" },
    { kind: "local" },
    { kind: "environment-local", environment: "development" },
    { kind: "environment-local", environment: "production" },
  ];
  const namespaces: string[][] = [[], ["redis"], ["services", "billing", "stripe"]];

  const files: ValueFile[] = namespaces.flatMap((namespace) =>
    scopes.flatMap((scope) =>
      [false, true].map((encrypted) => ({ namespace, name: "secret-key", scope, encrypted })),
    ),
  );

  it.each(files)("parseFilename(formatValueFile(x)) deep-equals x: %o", (file) => {
    expect(parseFilename(formatValueFile(file), config)).toEqual({ kind: "value", ...file });
  });

  it("round-trips meta files", () => {
    const ref = { namespace: ["redis"], name: "password", format: "json" } as const;
    expect(parseFilename(formatMetaFile(ref), config)).toEqual({ kind: "meta", ...ref });
  });
});

describe("isReservedToken", () => {
  it.each(["enc", "json", "toml", "yml", "local"])("reserves `%s`", (token) => {
    expect(isReservedToken(token, config)).toBe(true);
  });

  it.each(["development", "staging", "production", "test"])(
    "reserves the declared environment `%s`",
    (token) => {
      expect(isReservedToken(token, config)).toBe(true);
    },
  );

  it.each(["password", "ENC", "encoding", "locale"])("does not reserve `%s`", (token) => {
    expect(isReservedToken(token, config)).toBe(false);
  });

  it("reserves nothing but the static tokens when no environment is declared", () => {
    const bare: PenvConfig = { environments: [], providers: {} };
    expect(isReservedToken("production", bare)).toBe(false);
    expect(isReservedToken("enc", bare)).toBe(true);
  });
});

describe("reservedTokensFor", () => {
  it("returns the static tokens unioned with the declared environments", () => {
    expect(reservedTokensFor(config).sort()).toEqual(
      [
        "development",
        "enc",
        "json",
        "local",
        "production",
        "staging",
        "test",
        "toml",
        "yml",
      ].sort(),
    );
  });

  it("returns only the static tokens when no environment is declared", () => {
    expect(reservedTokensFor({ environments: [], providers: {} })).toEqual([
      "enc",
      "json",
      "toml",
      "yml",
      "local",
    ]);
  });

  it("does not repeat an environment that is already a static token", () => {
    const tokens = reservedTokensFor({ environments: ["local", "production"], providers: {} });
    expect(tokens.filter((t) => t === "local")).toHaveLength(1);
  });
});

describe("validateEnvironmentNames", () => {
  it("passes a clean whitelist", () => {
    expect(validateEnvironmentNames(config)).toEqual([]);
  });

  it("rejects an environment named `local`", () => {
    const errors = validateEnvironmentNames({
      environments: ["development", "local"],
      providers: {},
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ReservedTokenError);
    expect(tokensOf(errors)).toEqual(["local"]);
    expect(errors[0]?.message).toMatch(/environment name `local`.*is a reserved token/s);
  });

  it("collects every collision rather than throwing on the first", () => {
    const errors = validateEnvironmentNames({
      environments: ["local", "enc", "json", "toml", "yml", "production"],
      providers: {},
    });
    expect(tokensOf(errors)).toEqual(["local", "enc", "json", "toml", "yml"]);
  });
});

/**
 * A name becomes a dot segment verbatim, so a name carrying a dot is read back as
 * segments that mean something else. Found in a real project, whose config
 * declared `.env.development.local` — the name of their dotenv file — as an
 * environment. `penv set --env .env.development.local` then wrote
 * `api-key..env.development.local`, which the grammar refuses to read, so every
 * later command on that tree threw and the only repair was deleting the file.
 */
describe("environment names that cannot be written", () => {
  it("rejects a name containing a dot", () => {
    const errors = validateEnvironmentNames({
      environments: ["development", ".env.development.local"],
      providers: {},
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(IllegalEnvironmentNameError);
    expect(errors[0]?.message).toMatch(/cannot be part of a filename/);
  });

  it("rejects a name with a space or a path separator", () => {
    const errors = validateEnvironmentNames({
      environments: ["pro duction", "a/b", "c\\d"],
      providers: {},
    });

    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e instanceof IllegalEnvironmentNameError)).toBe(true);
  });

  /** The negative: the names real projects actually use must all survive. */
  it("accepts letters, digits, underscores and hyphens", () => {
    const errors = validateEnvironmentNames({
      environments: ["development", "production", "staging_2", "pre-prod", "e2e"],
      providers: {},
    });

    expect(errors).toEqual([]);
  });

  /** A reserved token is reported as reserved, not as unspellable — one reason, the true one. */
  it("reports a reserved name as reserved rather than as illegal", () => {
    const errors = validateEnvironmentNames({ environments: ["local"], providers: {} });

    expect(errors[0]).toBeInstanceOf(ReservedTokenError);
    expect(errors).toHaveLength(1);
  });
});
