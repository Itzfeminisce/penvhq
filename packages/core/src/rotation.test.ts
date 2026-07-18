import { describe, expect, it } from "vitest";
import { PenvError } from "./errors.js";
import {
  beginRotation,
  completeRotation,
  isOverdue,
  isStuck,
  parseDuration,
  rotationOf,
  tryParseDuration,
} from "./rotation.js";
import type { Meta } from "./types.js";

const DAY = 86_400_000;

describe("parseDuration", () => {
  it("parses each unit to milliseconds", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("90d")).toBe(90 * DAY);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDuration("  90d ")).toBe(90 * DAY);
  });

  it("throws ROTATION_POLICY on a malformed spec", () => {
    for (const spec of ["", "90", "d", "90x", "1h30m", "1.5d", "-1d", "90 d", "ninety"]) {
      expect(() => parseDuration(spec)).toThrow(PenvError);
      try {
        parseDuration(spec);
        expect.unreachable(`parseDuration accepted \`${spec}\``);
      } catch (error) {
        expect((error as PenvError).code).toBe("ROTATION_POLICY");
      }
    }
  });
});

describe("tryParseDuration", () => {
  it("parses a valid spec exactly as parseDuration does", () => {
    expect(tryParseDuration("90d")).toBe(90 * DAY);
    expect(tryParseDuration("  24h ")).toBe(24 * 3_600_000);
  });

  it("returns undefined for every spec parseDuration would throw on, never throwing", () => {
    for (const spec of ["", "90", "d", "90x", "1h30m", "1.5d", "-1d", "90 d", "ninety"]) {
      expect(tryParseDuration(spec)).toBeUndefined();
    }
  });
});

describe("rotationOf", () => {
  it("defaults state to active and both clocks to null when nothing is declared", () => {
    expect(rotationOf(undefined, "production")).toEqual({
      mechanism: undefined,
      policy: undefined,
      state: "active",
      rotatingSince: null,
      lastRotated: null,
    });
  });

  it("reads the five fields through the base-plus-environment merge", () => {
    const meta: Meta = {
      rotationMechanism: "dual-valid",
      rotationPolicy: "90d",
      environments: {
        production: {
          rotationPolicy: "30d",
          rotationState: "rotating",
          rotatingSince: "2026-07-01T00:00:00.000Z",
          lastRotated: "2026-04-01T00:00:00.000Z",
        },
      },
    };

    expect(rotationOf(meta, "production")).toEqual({
      mechanism: "dual-valid",
      policy: "30d",
      state: "rotating",
      rotatingSince: "2026-07-01T00:00:00.000Z",
      lastRotated: "2026-04-01T00:00:00.000Z",
    });
  });

  it("inherits the base for an environment with no block", () => {
    const meta: Meta = { rotationMechanism: "atomic-cutover", rotationPolicy: "90d" };

    expect(rotationOf(meta, "development")).toMatchObject({
      mechanism: "atomic-cutover",
      policy: "90d",
      state: "active",
    });
  });

  it("ignores a mechanism or state value it does not recognise", () => {
    const meta: Meta = { rotationMechanism: "sideways", rotationState: "paused" };

    expect(rotationOf(meta, "production")).toMatchObject({
      mechanism: undefined,
      state: "active",
    });
  });
});

describe("isOverdue", () => {
  const meta: Meta = {
    rotationPolicy: "90d",
    environments: { production: { lastRotated: "2026-01-01T00:00:00.000Z" } },
  };

  it("is not overdue exactly at the policy interval", () => {
    const now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + 90 * DAY);
    expect(isOverdue(meta, "production", now)).toBe(false);
  });

  it("is overdue one millisecond past the policy interval", () => {
    const now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + 90 * DAY + 1);
    expect(isOverdue(meta, "production", now)).toBe(true);
  });

  it("is not overdue before the interval elapses", () => {
    const now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + DAY);
    expect(isOverdue(meta, "production", now)).toBe(false);
  });

  it("is never overdue without a policy", () => {
    const noPolicy: Meta = {
      environments: { production: { lastRotated: "2026-01-01T00:00:00.000Z" } },
    };
    expect(isOverdue(noPolicy, "production", new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("is never overdue without a lastRotated — never rotated is not late", () => {
    const neverRotated: Meta = { rotationPolicy: "1d" };
    expect(isOverdue(neverRotated, "production", new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("isStuck", () => {
  const THRESHOLD = DAY;
  const since = "2026-07-01T00:00:00.000Z";
  const wayPast = new Date(Date.parse(since) + 30 * DAY);

  const dualValidRotating: Meta = {
    rotationMechanism: "dual-valid",
    environments: { production: { rotationState: "rotating", rotatingSince: since } },
  };

  it("is stuck when a dual-valid rotation has run past the threshold", () => {
    expect(isStuck(dualValidRotating, "production", wayPast, THRESHOLD)).toBe(true);
  });

  it("is not stuck exactly at the threshold", () => {
    const atThreshold = new Date(Date.parse(since) + THRESHOLD);
    expect(isStuck(dualValidRotating, "production", atThreshold, THRESHOLD)).toBe(false);
  });

  // The false positive the RFC and roadmap both single out: atomic-cutover holds
  // no penv-layer grace window, so an old rotatingSince on one is never stuck.
  it("is never stuck for atomic-cutover, even with an ancient rotatingSince", () => {
    const atomic: Meta = {
      rotationMechanism: "atomic-cutover",
      environments: { production: { rotationState: "rotating", rotatingSince: since } },
    };
    expect(isStuck(atomic, "production", wayPast, THRESHOLD)).toBe(false);
  });

  it("is not stuck when the state is active rather than rotating", () => {
    const active: Meta = {
      rotationMechanism: "dual-valid",
      environments: { production: { rotationState: "active", rotatingSince: since } },
    };
    expect(isStuck(active, "production", wayPast, THRESHOLD)).toBe(false);
  });

  it("is not stuck without a rotatingSince clock", () => {
    const noClock: Meta = {
      rotationMechanism: "dual-valid",
      environments: { production: { rotationState: "rotating" } },
    };
    expect(isStuck(noClock, "production", wayPast, THRESHOLD)).toBe(false);
  });

  it("is not stuck when no mechanism is declared", () => {
    const noMechanism: Meta = {
      environments: { production: { rotationState: "rotating", rotatingSince: since } },
    };
    expect(isStuck(noMechanism, "production", wayPast, THRESHOLD)).toBe(false);
  });
});

describe("beginRotation", () => {
  const now = "2026-07-17T12:00:00.000Z";

  it("sets state rotating and stamps rotatingSince for the target environment", () => {
    const result = beginRotation(undefined, "production", now);

    expect(result.environments?.["production"]).toEqual({
      rotationState: "rotating",
      rotatingSince: now,
    });
    expect(rotationOf(result, "production")).toMatchObject({
      state: "rotating",
      rotatingSince: now,
    });
  });

  it("does not mutate the meta it was given", () => {
    const meta: Meta = {
      rotationPolicy: "90d",
      environments: { production: { rotationState: "active", rotatingSince: null } },
    };
    const snapshot = JSON.parse(JSON.stringify(meta));

    beginRotation(meta, "production", now);

    expect(meta).toEqual(snapshot);
  });

  it("preserves other environments, the base block, and unknown keys", () => {
    const meta: Meta = {
      rotationMechanism: "dual-valid",
      owner: "auth-team",
      ticket: "PLAT-9",
      environments: {
        production: { required: true },
        staging: { rotationState: "active", lastRotated: "2026-01-01T00:00:00.000Z" },
      },
    };

    const result = beginRotation(meta, "production", now);

    expect(result.owner).toBe("auth-team");
    expect(result["ticket"]).toBe("PLAT-9");
    expect(result.rotationMechanism).toBe("dual-valid");
    expect(result.environments?.["staging"]).toEqual({
      rotationState: "active",
      lastRotated: "2026-01-01T00:00:00.000Z",
    });
    // The target block keeps its existing keys and gains the rotation stamp.
    expect(result.environments?.["production"]).toEqual({
      required: true,
      rotationState: "rotating",
      rotatingSince: now,
    });
  });
});

describe("completeRotation", () => {
  const now = "2026-07-17T12:00:00.000Z";

  it("returns to active, clears rotatingSince, and records lastRotated", () => {
    const rotating = beginRotation(undefined, "production", "2026-07-01T00:00:00.000Z");

    const result = completeRotation(rotating, "production", now);

    expect(result.environments?.["production"]).toMatchObject({
      rotationState: "active",
      rotatingSince: null,
      lastRotated: now,
    });
    expect(rotationOf(result, "production")).toMatchObject({
      state: "active",
      rotatingSince: null,
      lastRotated: now,
    });
  });

  it("does not mutate the meta it was given", () => {
    const meta: Meta = {
      environments: {
        production: { rotationState: "rotating", rotatingSince: "2026-07-01T00:00:00.000Z" },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(meta));

    completeRotation(meta, "production", now);

    expect(meta).toEqual(snapshot);
  });

  it("preserves other environments and unknown keys", () => {
    const meta: Meta = {
      owner: "auth-team",
      environments: {
        production: { rotationState: "rotating", rotatingSince: "2026-07-01T00:00:00.000Z" },
        staging: { required: true },
      },
    };

    const result = completeRotation(meta, "production", now);

    expect(result.owner).toBe("auth-team");
    expect(result.environments?.["staging"]).toEqual({ required: true });
  });
});
