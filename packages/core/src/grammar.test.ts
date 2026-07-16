import { describe, expect, it } from "vitest";
import {
  FilenameGrammarError,
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

const config: PenvConfig = {
  environments: ["development", "staging", "production", "test"],
  providers: {
    development: { type: "filesystem" },
    staging: { type: "filesystem" },
    production: { type: "filesystem" },
    test: { type: "filesystem" },
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
      expect(isParameterFile(path)).toBe(false);
    },
  );

  it.each(["password", "redis/password.production", "redis/password.json", "app/jwt-secret.local"])(
    "accepts `%s`",
    (path) => {
      expect(isParameterFile(path)).toBe(true);
    },
  );

  it("normalises Windows separators before taking the basename", () => {
    expect(isParameterFile(".\\redis\\.DS_Store")).toBe(false);
    expect(isParameterFile(".\\redis\\password.production")).toBe(true);
  });

  it("ignores a path that names no file", () => {
    expect(isParameterFile("")).toBe(false);
  });

  // The defect this predicate exists to prevent: a stray dotfile the user never
  // created must not make `list`/`load` fail hard.
  it("filters the files that would otherwise throw on an empty leading segment", () => {
    expect(() => parseFilename(".DS_Store", config)).toThrow(FilenameGrammarError);
    expect(isParameterFile(".DS_Store")).toBe(false);
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
    expect(errors[0]?.token).toBe("local");
    expect(errors[0]?.message).toMatch(/environment name `local`.*is a reserved token/s);
  });

  it("collects every collision rather than throwing on the first", () => {
    const errors = validateEnvironmentNames({
      environments: ["local", "enc", "json", "toml", "yml", "production"],
      providers: {},
    });
    expect(errors.map((e) => e.token)).toEqual(["local", "enc", "json", "toml", "yml"]);
  });
});
