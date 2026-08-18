/**
 * The release seam.
 *
 * The pin in the repository is a placeholder, and the whole point of it is that
 * it can never reach a user: the check that a release runs before publishing is
 * the same check the launcher runs before it writes a manifest, so these tests
 * stand for both.
 */

import { ENGINE_PACKAGE, type ManifestEngine } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { EnginePinMismatchError, EnginePinUnreleasedError } from "./errors.js";
import {
  assertReleasePin,
  BUNDLED_ENGINE_PIN,
  DEV_PIN_INTEGRITY,
  releaseEnginePin,
} from "./pins.js";

const RELEASED: ManifestEngine = {
  package: ENGINE_PACKAGE,
  version: "0.9.0",
  integrity: `sha512-${"A".repeat(86)}==`,
};

describe("the pin a release fills in", () => {
  it("refuses the value checked into this repository", () => {
    expect(BUNDLED_ENGINE_PIN.integrity).toBe(DEV_PIN_INTEGRITY);
    expect(() => {
      assertReleasePin(BUNDLED_ENGINE_PIN);
    }).toThrowError(EnginePinUnreleasedError);
  });

  it("refuses a released integrity still carrying the development version", () => {
    expect(() => {
      assertReleasePin({ ...RELEASED, version: BUNDLED_ENGINE_PIN.version });
    }).toThrowError(EnginePinUnreleasedError);
  });

  it("accepts one the release pipeline filled in", () => {
    expect(() => {
      assertReleasePin(RELEASED);
    }).not.toThrow();
  });
});

describe("the pin and the engine beside it", () => {
  it("is what gets written when they are the same release", () => {
    expect(releaseEnginePin(RELEASED, "0.9.0")).toEqual(RELEASED);
  });

  it("refuses when they are not", () => {
    expect(() => releaseEnginePin(RELEASED, "0.10.0")).toThrowError(EnginePinMismatchError);
  });
});
