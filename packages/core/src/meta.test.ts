import { describe, expect, it } from "vitest";
import { PenvError, UnknownEnvironmentError } from "./errors.js";
import {
  effectiveMeta,
  isRequired,
  isSecret,
  parseMeta,
  serializeMeta,
  validateMetaEnvironments,
} from "./meta.js";
import type { Meta, PenvConfig } from "./types.js";

/** The `jwt-secret` meta file from the docs, verbatim. */
const jwtSecret: Meta = {
  description: "Signs and verifies user session JWTs",
  owner: "auth-team",
  rotationPolicy: "90d",
  environments: {
    production: { required: true, rotationPolicy: "30d", owner: "infra-team" },
    staging: { required: true },
  },
};

describe("effectiveMeta", () => {
  it("returns the base when the file declares no environment blocks", () => {
    const meta: Meta = { description: "Redis connection password", owner: "platform-team" };

    expect(effectiveMeta(meta, "production")).toEqual({
      description: "Redis connection password",
      owner: "platform-team",
    });
  });

  it("overrides per top-level key and inherits the rest", () => {
    expect(effectiveMeta(jwtSecret, "production")).toEqual({
      description: "Signs and verifies user session JWTs",
      owner: "infra-team",
      rotationPolicy: "30d",
      required: true,
    });
  });

  it("inherits every base key a block does not declare", () => {
    expect(effectiveMeta(jwtSecret, "staging")).toEqual({
      description: "Signs and verifies user session JWTs",
      owner: "auth-team",
      rotationPolicy: "90d",
      required: true,
    });
  });

  // Invariant 5. Deep-merge would keep `pagerduty` and `escalateAfter` from the
  // base, making effective policy uncomputable from two objects.
  it("replaces a nested object wholesale and never deep-merges", () => {
    const meta: Meta = {
      description: "Signs and verifies user session JWTs",
      alerts: { channel: "#platform", pagerduty: false, escalateAfter: "15m" },
      environments: {
        production: { alerts: { channel: "#incidents" } },
      },
    };

    const effective = effectiveMeta(meta, "production");

    expect(effective["alerts"]).toEqual({ channel: "#incidents" });
    expect(effective["alerts"]).not.toHaveProperty("pagerduty");
    expect(effective["alerts"]).not.toHaveProperty("escalateAfter");
    expect(effective["description"]).toBe("Signs and verifies user session JWTs");
  });

  it("returns the base for an environment with no block — optional by default", () => {
    expect(effectiveMeta(jwtSecret, "development")).toEqual({
      description: "Signs and verifies user session JWTs",
      owner: "auth-team",
      rotationPolicy: "90d",
    });
  });

  it("returns an empty object when the parameter has no meta file", () => {
    expect(effectiveMeta(undefined, "production")).toEqual({});
  });

  it("passes unknown keys through untouched", () => {
    const meta: Meta = {
      ticket: "PLAT-1184",
      environments: { production: { compliance: ["soc2", "pci"] } },
    };

    const effective = effectiveMeta(meta, "production");

    expect(effective["ticket"]).toBe("PLAT-1184");
    expect(effective["compliance"]).toEqual(["soc2", "pci"]);
  });

  it("never leaks the environments container into the effective meta", () => {
    expect(effectiveMeta(jwtSecret, "production")).not.toHaveProperty("environments");
    expect(effectiveMeta(jwtSecret, "development")).not.toHaveProperty("environments");
    expect(effectiveMeta({ environments: {} }, "production")).toEqual({});
  });

  it("does not mutate the meta it was given", () => {
    const meta: Meta = {
      owner: "auth-team",
      environments: { production: { owner: "infra-team" } },
    };

    effectiveMeta(meta, "production");

    expect(meta.owner).toBe("auth-team");
    expect(meta.environments?.["production"]).toEqual({ owner: "infra-team" });
  });
});

describe("isRequired", () => {
  it("is false when no meta declares it", () => {
    expect(isRequired(undefined, "production")).toBe(false);
    expect(isRequired({ description: "Signs user session JWTs" }, "production")).toBe(false);
  });

  it("is false for an environment with no block", () => {
    expect(isRequired(jwtSecret, "development")).toBe(false);
  });

  it("reads the environment block", () => {
    expect(isRequired(jwtSecret, "production")).toBe(true);
    expect(isRequired(jwtSecret, "staging")).toBe(true);
  });

  it("lets an environment block override a required base", () => {
    const meta: Meta = { required: true, environments: { development: { required: false } } };

    expect(isRequired(meta, "production")).toBe(true);
    expect(isRequired(meta, "development")).toBe(false);
  });
});

describe("isSecret", () => {
  it("is false when no meta declares it", () => {
    expect(isSecret(undefined, "production")).toBe(false);
    expect(isSecret({ owner: "auth-team" }, "production")).toBe(false);
  });

  it("inherits a secret base into every environment", () => {
    const meta: Meta = { secret: true, environments: { production: { required: true } } };

    expect(isSecret(meta, "production")).toBe(true);
    expect(isSecret(meta, "development")).toBe(true);
  });

  it("lets an environment block override the base", () => {
    const meta: Meta = { secret: false, environments: { production: { secret: true } } };

    expect(isSecret(meta, "production")).toBe(true);
    expect(isSecret(meta, "staging")).toBe(false);
  });
});

describe("parseMeta", () => {
  it("parses a meta file", () => {
    expect(parseMeta(JSON.stringify(jwtSecret), "jwt-secret.meta.json")).toEqual(jwtSecret);
  });

  it("keeps unknown keys so an older penv cannot destroy them", () => {
    const meta = parseMeta('{ "rotationPolicy": "90d", "futureField": { "a": 1 } }', "x.meta.json");

    expect(meta["futureField"]).toEqual({ a: 1 });
  });

  it("throws META_PARSE naming the file on bad JSON", () => {
    expect(() => parseMeta("{ not json", "jwt-secret.meta.json")).toThrow(/jwt-secret\.meta\.json/);

    try {
      parseMeta("{ not json", "jwt-secret.meta.json");
      expect.unreachable("parseMeta accepted invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(PenvError);
      expect((error as PenvError).code).toBe("META_PARSE");
    }
  });

  it("throws META_PARSE naming the file on a non-object root", () => {
    for (const source of ['"a string"', "42", "null", '["production"]']) {
      expect(() => parseMeta(source, "jwt-secret.meta.json")).toThrow(/jwt-secret\.meta\.json/);
      try {
        parseMeta(source, "jwt-secret.meta.json");
        expect.unreachable(`parseMeta accepted a non-object root: ${source}`);
      } catch (error) {
        expect((error as PenvError).code).toBe("META_PARSE");
      }
    }
  });

  it("rejects an environments key that is not an object of blocks", () => {
    expect(() => parseMeta('{ "environments": ["production"] }', "jwt-secret.meta.json")).toThrow(
      /environments/,
    );
    expect(() =>
      parseMeta('{ "environments": { "production": true } }', "jwt-secret.meta.json"),
    ).toThrow(/production/);
  });
});

describe("validateMetaEnvironments", () => {
  const config: PenvConfig = {
    environments: ["development", "production"],
    providers: { filesystem: { type: "@penvhq/provider-filesystem" } },
  };

  // The finding: a typo'd key was silently inert policy. `effectiveMeta` found no
  // `production` block, returned the base, `isRequired` was false, and a parameter
  // marked required for production deployed absent with `validate` passing.
  it("reports a typo'd environment key that would otherwise be silently inert", () => {
    const meta: Meta = { secret: true, environments: { prodution: { required: true } } };

    const errors = validateMetaEnvironments(meta, "redis/password.meta.json", config);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnknownEnvironmentError);
    expect(errors[0]?.code).toBe("UNKNOWN_ENVIRONMENT");
    expect(errors[0]?.message).toContain("prodution");
    // The policy the typo silently dropped, and why this check has to exist.
    expect(isRequired(meta, "production")).toBe(false);
  });

  it("reports every undeclared key, not just the first", () => {
    const meta: Meta = {
      environments: { prodution: { required: true }, stagng: { required: true } },
    };

    const errors = validateMetaEnvironments(meta, "redis/password.meta.json", config);

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => (e as UnknownEnvironmentError).environment)).toEqual([
      "prodution",
      "stagng",
    ]);
  });

  // The negative case: this check must stay quiet when every key is declared.
  it("returns no errors when every environment key is declared", () => {
    const meta: Meta = {
      description: "Redis connection password",
      environments: { development: { required: false }, production: { required: true } },
    };

    expect(validateMetaEnvironments(meta, "redis/password.meta.json", config)).toEqual([]);
  });

  it("returns no errors for a meta with no environments block", () => {
    const meta: Meta = { description: "Redis connection password", owner: "platform-team" };

    expect(validateMetaEnvironments(meta, "redis/password.meta.json", config)).toEqual([]);
    expect(
      validateMetaEnvironments({ environments: {} }, "redis/password.meta.json", config),
    ).toEqual([]);
  });

  it("returns no errors when the parameter has no meta file", () => {
    expect(validateMetaEnvironments(undefined, "redis/password.meta.json", config)).toEqual([]);
  });

  it("collects rather than throws, leaving severity to the caller", () => {
    expect(() =>
      validateMetaEnvironments({ environments: { qa: {} } }, "redis/password.meta.json", config),
    ).not.toThrow();
  });
});

describe("serializeMeta", () => {
  it("emits description then owner, then remaining keys sorted, then environments", () => {
    const meta: Meta = {
      rotationPolicy: "90d",
      environments: { staging: { required: true }, production: { required: true } },
      owner: "auth-team",
      description: "Signs and verifies user session JWTs",
      secret: true,
    };

    const keys = serializeMeta(meta)
      .split("\n")
      .filter((line) => /^ {2}"/.test(line))
      .map((line) => line.slice(3, line.indexOf('"', 3)));

    expect(keys).toEqual(["description", "owner", "rotationPolicy", "secret", "environments"]);
  });

  it("is stable 2-space JSON with a trailing newline", () => {
    const output = serializeMeta({ description: "Signs user session JWTs", owner: "auth-team" });

    expect(output).toBe(
      '{\n  "description": "Signs user session JWTs",\n  "owner": "auth-team"\n}\n',
    );
  });

  it("does not depend on the input key order", () => {
    const reordered: Meta = {
      environments: { production: { owner: "infra-team", rotationPolicy: "30d", required: true } },
      rotationPolicy: "90d",
      description: "Signs and verifies user session JWTs",
      owner: "auth-team",
    };
    const original: Meta = {
      description: "Signs and verifies user session JWTs",
      owner: "auth-team",
      rotationPolicy: "90d",
      environments: { production: { required: true, rotationPolicy: "30d", owner: "infra-team" } },
    };

    expect(serializeMeta(reordered)).toBe(serializeMeta(original));
  });

  it("sorts environment names and orders keys within each block", () => {
    const output = serializeMeta(jwtSecret);

    expect(output.indexOf('"production"')).toBeLessThan(output.indexOf('"staging"'));
    expect(output).toContain('"owner": "infra-team"');
  });

  it("round-trips through parseMeta", () => {
    const output = serializeMeta(jwtSecret);
    const reparsed = parseMeta(output, "jwt-secret.meta.json");

    expect(reparsed).toEqual(jwtSecret);
    expect(serializeMeta(reparsed)).toBe(output);
  });

  it("round-trips unknown keys and nested objects", () => {
    const meta: Meta = {
      description: "Signs and verifies user session JWTs",
      alerts: { channel: "#platform", pagerduty: false },
      compliance: ["soc2"],
      environments: { production: { alerts: { channel: "#incidents" } } },
    };

    const reparsed = parseMeta(serializeMeta(meta), "jwt-secret.meta.json");

    expect(reparsed).toEqual(meta);
    expect(effectiveMeta(reparsed, "production")["alerts"]).toEqual({ channel: "#incidents" });
  });
});
