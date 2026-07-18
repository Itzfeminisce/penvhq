import { describe, expect, it } from "vitest";
import {
  accessPath,
  checkNameCollisions,
  defaultVariableName,
  isCanonicalSegment,
  refFromAccessPath,
  refFromVariable,
  roundTripsCleanly,
  variableName,
} from "./names.js";
import type { ParameterRef, PenvConfig } from "./types.js";

const config: PenvConfig = {
  environments: ["development", "staging", "production", "test"],
  providers: {
    development: { type: "filesystem" },
    staging: { type: "filesystem" },
    production: { type: "filesystem" },
    test: { type: "filesystem" },
  },
};

const databaseUrl: ParameterRef = { namespace: [], name: "database-url" };
const appJwtSecret: ParameterRef = { namespace: ["app"], name: "jwt-secret" };
const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };

function withNames(names: Record<string, string>): PenvConfig {
  return { ...config, names };
}

describe("the documented examples", () => {
  it("maps database-url in every direction", () => {
    expect(accessPath(databaseUrl)).toEqual(["databaseUrl"]);
    expect(defaultVariableName(databaseUrl)).toBe("DATABASE_URL");
    expect(variableName(databaseUrl, config)).toBe("DATABASE_URL");
    expect(refFromVariable("DATABASE_URL")).toEqual(databaseUrl);
  });

  it("maps app/jwt-secret in every direction", () => {
    expect(accessPath(appJwtSecret)).toEqual(["app", "jwtSecret"]);
    expect(defaultVariableName(appJwtSecret)).toBe("APP_JWT_SECRET");
    expect(variableName(appJwtSecret, config)).toBe("APP_JWT_SECRET");
  });

  it("maps redis/password in every direction", () => {
    expect(accessPath(redisPassword)).toEqual(["redis", "password"]);
    expect(defaultVariableName(redisPassword)).toBe("REDIS_PASSWORD");
    expect(variableName(redisPassword, config)).toBe("REDIS_PASSWORD");
  });
});

describe("accessPath", () => {
  it("camelCases a multi-hyphen name", () => {
    expect(accessPath({ namespace: [], name: "my-long-name" })).toEqual(["myLongName"]);
  });

  it("camelCases namespace segments too", () => {
    expect(accessPath({ namespace: ["third-party"], name: "api-key" })).toEqual([
      "thirdParty",
      "apiKey",
    ]);
  });
});

describe("defaultVariableName", () => {
  it("underscores both the namespace separator and the hyphen", () => {
    expect(defaultVariableName({ namespace: ["third-party"], name: "api-key" })).toBe(
      "THIRD_PARTY_API_KEY",
    );
  });
});

describe("refFromVariable", () => {
  it("never infers a namespace — a flat .env carries no structure", () => {
    expect(refFromVariable("REDIS_PASSWORD")).toEqual({ namespace: [], name: "redis-password" });
    expect(refFromVariable("APP_JWT_SECRET")).toEqual({ namespace: [], name: "app-jwt-secret" });
  });

  it("round-trips flat parameters through defaultVariableName", () => {
    for (const name of ["database-url", "port", "my-long-name", "app-jwt-secret"]) {
      const ref: ParameterRef = { namespace: [], name };
      expect(refFromVariable(defaultVariableName(ref))).toEqual(ref);
    }
  });
});

describe("refFromAccessPath", () => {
  /** Unlike a flat `.env` variable, a schema key arrives with its structure. */
  it("reads the namespace the path carries", () => {
    expect(refFromAccessPath(["redis", "password"])).toEqual(redisPassword);
    expect(refFromAccessPath(["app", "jwtSecret"])).toEqual(appJwtSecret);
    expect(refFromAccessPath(["databaseUrl"])).toEqual(databaseUrl);
  });

  it("inverts accessPath for every name the transform produces", () => {
    const refs: ParameterRef[] = [
      databaseUrl,
      appJwtSecret,
      redisPassword,
      { namespace: [], name: "port" },
      { namespace: [], name: "my-long-name" },
      { namespace: ["third-party"], name: "api-key" },
    ];
    for (const ref of refs) {
      expect(refFromAccessPath(accessPath(ref))).toEqual(ref);
    }
  });

  /**
   * The transform's image is not every string. `apiURL` kebabs to `api-url`,
   * which camels back to `apiUrl` — a different key — so no value file reaches
   * it. Answering `undefined` is what stops a caller inventing a `penv set` line
   * that writes a file the schema would still not see.
   */
  it("refuses a key outside the transform's image rather than guessing", () => {
    expect(refFromAccessPath(["apiURL"])).toBeUndefined();
    expect(refFromAccessPath(["APIKey"])).toBeUndefined();
    expect(refFromAccessPath(["redis", "passWORD"])).toBeUndefined();
  });

  it("refuses a path that names nothing", () => {
    expect(refFromAccessPath([])).toBeUndefined();
    expect(refFromAccessPath([""])).toBeUndefined();
  });
});

describe("isCanonicalSegment", () => {
  it("accepts a segment the transform reads as-is", () => {
    expect(isCanonicalSegment("database-url")).toBe(true);
    expect(isCanonicalSegment("redis")).toBe(true);
    // snake_case carries no capital for kebabSegment to fold, so it is left
    // unchanged — canonical, and exactly what refFromAccessPath accepts.
    expect(isCanonicalSegment("database_url")).toBe(true);
  });

  it("rejects a segment whose capitals kebabSegment would fold", () => {
    expect(isCanonicalSegment("databaseUrl")).toBe(false);
    expect(isCanonicalSegment("API_KEY")).toBe(false);
    expect(isCanonicalSegment("apiURL")).toBe(false);
  });
});

describe("roundTripsCleanly", () => {
  it("accepts the SCREAMING_SNAKE variables the transform actually produces", () => {
    expect(roundTripsCleanly("DATABASE_URL")).toBe(true);
    expect(roundTripsCleanly("REDIS_PASSWORD")).toBe(true);
    expect(roundTripsCleanly("APP_JWT_SECRET")).toBe(true);
  });

  it("accepts a single-segment variable and one carrying digits", () => {
    expect(roundTripsCleanly("PORT")).toBe(true);
    expect(roundTripsCleanly("S3_BUCKET_V2")).toBe(true);
  });

  it("rejects a hyphenated key, which generate would silently rename to MY_VAR", () => {
    expect(roundTripsCleanly("MY-VAR")).toBe(false);
    expect(defaultVariableName(refFromVariable("MY-VAR"))).toBe("MY_VAR");
  });

  it("rejects lowercase and mixed-case keys, which generate would silently uppercase", () => {
    expect(roundTripsCleanly("lowerKey")).toBe(false);
    expect(roundTripsCleanly("Mixed_Case")).toBe(false);
    expect(defaultVariableName(refFromVariable("lowerKey"))).toBe("LOWERKEY");
    expect(defaultVariableName(refFromVariable("Mixed_Case"))).toBe("MIXED_CASE");
  });

  it("is exactly the composition of the two transforms, never a parallel regex", () => {
    const variables = [
      "DATABASE_URL",
      "REDIS_PASSWORD",
      "APP_JWT_SECRET",
      "PORT",
      "S3_BUCKET_V2",
      "MY-VAR",
      "lowerKey",
      "Mixed_Case",
      "my-var",
      "MY_VAR",
      "THIRD_PARTY_API_KEY",
      "a",
      "_LEADING",
      "TRAILING_",
      "DOUBLE__UNDERSCORE",
    ];
    for (const variable of variables) {
      expect(roundTripsCleanly(variable)).toBe(
        defaultVariableName(refFromVariable(variable)) === variable,
      );
    }
  });

  it("regenerates every clean variable identically — the v0.1 gate's identical keys", () => {
    const variables = [
      "DATABASE_URL",
      "REDIS_PASSWORD",
      "APP_JWT_SECRET",
      "PORT",
      "S3_BUCKET_V2",
      "MY-VAR",
      "lowerKey",
      "Mixed_Case",
      "MY_VAR",
      "THIRD_PARTY_API_KEY",
      "_LEADING",
      "DOUBLE__UNDERSCORE",
    ];
    for (const variable of variables.filter(roundTripsCleanly)) {
      expect(defaultVariableName(refFromVariable(variable))).toBe(variable);
    }
  });

  it("holds for every variable the transform itself emits", () => {
    const refs: ParameterRef[] = [
      databaseUrl,
      appJwtSecret,
      redisPassword,
      { namespace: [], name: "port" },
      { namespace: ["third-party"], name: "api-key" },
      { namespace: ["a"], name: "b" },
    ];
    for (const ref of refs) {
      expect(roundTripsCleanly(defaultVariableName(ref))).toBe(true);
    }
  });
});

describe("variableName overrides", () => {
  it("applies an override keyed by the dotted parameter id", () => {
    expect(variableName(redisPassword, withNames({ "redis.password": "REDIS_AUTH" }))).toBe(
      "REDIS_AUTH",
    );
  });

  it("applies an override keyed by the slash path", () => {
    expect(variableName(appJwtSecret, withNames({ "app/jwt-secret": "JWT_SIGNING_KEY" }))).toBe(
      "JWT_SIGNING_KEY",
    );
  });

  it("applies the documented root override, where id and path coincide", () => {
    expect(variableName(databaseUrl, withNames({ "database-url": "DATABASE_URL" }))).toBe(
      "DATABASE_URL",
    );
    expect(variableName(databaseUrl, withNames({ "database-url": "PG_DSN" }))).toBe("PG_DSN");
  });

  it("leaves unlisted parameters on the default transform", () => {
    expect(variableName(redisPassword, withNames({ "database-url": "PG_DSN" }))).toBe(
      "REDIS_PASSWORD",
    );
  });
});

describe("checkNameCollisions", () => {
  it("reports nothing when every parameter maps to a distinct variable", () => {
    expect(checkNameCollisions([databaseUrl, appJwtSecret, redisPassword], config)).toEqual([]);
  });

  it("catches two parameters whose defaults collide", () => {
    const errors = checkNameCollisions(
      [
        { namespace: ["redis"], name: "password" },
        { namespace: [], name: "redis-password" },
      ],
      config,
    );
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error?.variable).toBe("REDIS_PASSWORD");
    expect(error?.parameters).toEqual(["redis-password", "redis.password"]);
    expect(error?.message).toContain("REDIS_PASSWORD");
  });

  it("catches an override that collides with another parameter's default name", () => {
    const errors = checkNameCollisions(
      [databaseUrl, { namespace: [], name: "pg-dsn" }],
      withNames({ "pg-dsn": "DATABASE_URL" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.variable).toBe("DATABASE_URL");
    expect(errors[0]?.parameters).toEqual(["database-url", "pg-dsn"]);
  });

  it("never resolves a collision by last-write-wins", () => {
    const refs: ParameterRef[] = [
      { namespace: ["redis"], name: "password" },
      { namespace: [], name: "redis-password" },
    ];
    expect(checkNameCollisions(refs, config)).toHaveLength(1);
    expect(checkNameCollisions([...refs].reverse(), config)).toHaveLength(1);
  });

  it("orders errors by variable name and parameter ids deterministically", () => {
    const errors = checkNameCollisions(
      [
        { namespace: [], name: "zeta-key" },
        { namespace: ["zeta"], name: "key" },
        { namespace: ["alpha"], name: "key" },
        { namespace: [], name: "alpha-key" },
      ],
      config,
    );
    expect(errors.map((e) => e.variable)).toEqual(["ALPHA_KEY", "ZETA_KEY"]);
    expect(errors[0]?.parameters).toEqual(["alpha-key", "alpha.key"]);
    expect(errors[1]?.parameters).toEqual(["zeta-key", "zeta.key"]);
  });

  it("reports nothing for an empty parameter set", () => {
    expect(checkNameCollisions([], config)).toEqual([]);
  });
});
