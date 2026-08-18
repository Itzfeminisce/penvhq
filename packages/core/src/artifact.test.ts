/**
 * The artifact format itself: the bytes it writes, and the one thing it says
 * about anything it will not read.
 *
 * Everything here is pure. What a *build* puts in an artifact is the CLI's test;
 * this is the reader every release depends on, so each refusal is checked on the
 * exact damage that provokes it — and checked in order, because an artifact from
 * a newer penv must not be reported as a dozen unknown keys.
 */

import { describe, expect, it } from "vitest";
import type { Artifact } from "./artifact.js";
import {
  ARTIFACT_FORMAT,
  ArtifactError,
  assertArtifactFor,
  deliveryDigest,
  parseArtifact,
  serializeArtifact,
  UnsupportedArtifactFormatError,
} from "./artifact.js";

const VALUES: Artifact["values"] = {
  "database-url": {
    kind: "sealed",
    variable: "DATABASE_URL",
    address: "database-url.production.enc",
    sealed: "penv:1:prod:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB",
  },
  "redis.host": { kind: "plain", variable: "REDIS_HOST", value: "10.0.0.4" },
  region: { kind: "absent", variable: "REGION" },
};

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  const values = overrides.values ?? VALUES;
  return {
    format: ARTIFACT_FORMAT,
    environment: "production",
    engineVersion: "0.9.0",
    keySource: "env:prod",
    schemaDigest: deliveryDigest(values),
    ...overrides,
    values,
  };
}

/** The written form, damaged in one specific way. */
function damaged(edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeArtifact(artifact())) as Record<string, unknown>;
  edit(raw);
  return JSON.stringify(raw);
}

function refusalFrom(read: () => unknown): { code: string; message: string; remedy?: string } {
  try {
    read();
  } catch (error) {
    return error as { code: string; message: string; remedy?: string };
  }
  throw new Error("expected the artifact to be refused");
}

describe("serialization", () => {
  it("sorts keys, indents, and ends with one newline", () => {
    const text = serializeArtifact(artifact({ values: { b: VALUES["redis.host"] } as never }));

    expect(text.startsWith('{\n  "engineVersion"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("is the same bytes whatever order the writer happened to build it in", () => {
    const forwards = serializeArtifact(artifact());
    const backwards = serializeArtifact({
      values: VALUES,
      schemaDigest: deliveryDigest(VALUES),
      keySource: "env:prod",
      engineVersion: "0.9.0",
      environment: "production",
      format: ARTIFACT_FORMAT,
    });

    expect(backwards).toBe(forwards);
  });

  it("round-trips through the reader", () => {
    expect(parseArtifact(serializeArtifact(artifact()), "artifact.json")).toEqual(artifact());
  });
});

describe("the delivery digest", () => {
  it("covers the mappings and not the values", () => {
    const before = deliveryDigest(VALUES);
    const after = deliveryDigest({
      ...VALUES,
      "redis.host": { kind: "plain", variable: "REDIS_HOST", value: "10.0.0.9" },
    });

    // A value changed, the contract did not: the digest is what the *shape* of
    // the delivery is, so a rebuild after `penv set` is not a contract change.
    expect(after).toBe(before);
  });

  it("changes when a mapping is added, removed, or renamed", () => {
    const base = deliveryDigest(VALUES);

    expect(deliveryDigest({ "redis.host": VALUES["redis.host"] } as never)).not.toBe(base);
    expect(
      deliveryDigest({
        ...VALUES,
        "redis.host": { kind: "plain", variable: "REDIS_ADDR", value: "10.0.0.4" },
      }),
    ).not.toBe(base);
  });
});

describe("the reader", () => {
  it("refuses text that is not JSON", () => {
    const error = refusalFrom(() => parseArtifact("not json", "artifact.json"));

    expect(error.code).toBe("ARTIFACT_PARSE");
    expect(error.remedy).toContain("penv artifact build");
  });

  it("refuses a root that is not an object", () => {
    expect(refusalFrom(() => parseArtifact("[]", "artifact.json")).code).toBe("ARTIFACT_ROOT");
  });

  it("refuses a file that does not say its format", () => {
    const error = refusalFrom(() =>
      parseArtifact(
        damaged((raw) => {
          raw.format = undefined;
        }),
        "artifact.json",
      ),
    );

    expect(error.code).toBe("ARTIFACT_FORMAT_INVALID");
  });

  /**
   * The gate that runs before every other check. An artifact from a newer penv
   * is not a broken artifact, and reporting it as unknown keys would send the
   * reader editing a file whose only problem is that this penv is old.
   */
  it("refuses a format it does not implement, and says only that", () => {
    const error = refusalFrom(() =>
      parseArtifact(
        damaged((raw) => {
          raw.format = 2;
          raw.somethingNewerPenvWrote = true;
        }),
        "artifact.json",
      ),
    );

    expect(error).toBeInstanceOf(UnsupportedArtifactFormatError);
    expect(error.message).toContain("is format 2");
    expect(error.message).not.toContain("somethingNewerPenvWrote");
  });

  it("refuses a key format 1 does not declare", () => {
    const error = refusalFrom(() =>
      parseArtifact(
        damaged((raw) => {
          raw.providers = { production: { type: "@penvhq/provider-vault" } };
        }),
        "artifact.json",
      ),
    );

    expect(error).toBeInstanceOf(ArtifactError);
    expect(error.code).toBe("ARTIFACT_SHAPE");
  });

  it("refuses an entry that is none of the three kinds", () => {
    const error = refusalFrom(() =>
      parseArtifact(
        damaged((raw) => {
          (raw.values as Record<string, unknown>)["redis.host"] = {
            kind: "plain",
            variable: "REDIS_HOST",
          };
        }),
        "artifact.json",
      ),
    );

    expect(error.code).toBe("ARTIFACT_SHAPE");
  });

  it("refuses a mapping edited after the artifact was built", () => {
    const error = refusalFrom(() =>
      parseArtifact(
        damaged((raw) => {
          (raw.values as Record<string, unknown>).smuggled = {
            kind: "plain",
            variable: "SMUGGLED",
            value: "in",
          };
        }),
        "artifact.json",
      ),
    );

    expect(error.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    expect(error.message).toContain("written once and read unchanged");
  });

  /** The negative case: an untouched artifact is read without complaint. */
  it("reads an artifact penv wrote", () => {
    const read = parseArtifact(serializeArtifact(artifact()), "artifact.json");

    expect(read.environment).toBe("production");
    expect(read.values["redis.host"]).toEqual({
      kind: "plain",
      variable: "REDIS_HOST",
      value: "10.0.0.4",
    });
  });
});

describe("compatibility", () => {
  it("refuses an engine that did not write it", () => {
    const error = refusalFrom(() =>
      assertArtifactFor(artifact(), { engineVersion: "0.9.1" }, "artifact.json"),
    );

    expect(error.code).toBe("ARTIFACT_ENGINE_MISMATCH");
    expect(error.message).toContain("built by penv 0.9.0");
    expect(error.message).toContain("this penv is 0.9.1");
  });

  it("refuses an environment the caller did not ask for", () => {
    const error = refusalFrom(() =>
      assertArtifactFor(
        artifact(),
        { engineVersion: "0.9.0", environment: "staging" },
        "artifact.json",
      ),
    );

    expect(error.code).toBe("ARTIFACT_ENVIRONMENT_MISMATCH");
    expect(error.remedy).toContain("penv artifact build --env staging");
  });

  /** The negative cases: an exact match, and a caller that named no environment. */
  it("accepts an exact match, and a caller who let the artifact say which it is", () => {
    expect(() =>
      assertArtifactFor(
        artifact(),
        { engineVersion: "0.9.0", environment: "production" },
        "artifact.json",
      ),
    ).not.toThrow();
    expect(() =>
      assertArtifactFor(artifact(), { engineVersion: "0.9.0" }, "artifact.json"),
    ).not.toThrow();
  });
});
