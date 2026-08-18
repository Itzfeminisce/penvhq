import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { developmentPin, embedPin, integrityOf, readPin } from "../../../scripts/engine-pin.js";
import { DEV_PIN_INTEGRITY, DEV_PIN_VERSION } from "./pins.js";

/**
 * The release rewrite, tested against the real committed pins.ts — not a copy —
 * so the script and the file it rewrites cannot drift apart.
 */
const source = readFileSync(new URL("./pins.ts", import.meta.url), "utf8");

const RELEASE = {
  version: "0.9.1",
  integrity: `sha512-${"A".repeat(86)}==`,
} as const;

describe("the pin the repository commits", () => {
  it("is the development placeholder, resolved through its constants", () => {
    expect(readPin(source)).toEqual({ version: DEV_PIN_VERSION, integrity: DEV_PIN_INTEGRITY });
  });

  it("names the placeholder in constants the script can find", () => {
    expect(developmentPin(source)).toEqual({
      version: DEV_PIN_VERSION,
      integrity: DEV_PIN_INTEGRITY,
    });
  });
});

describe("the embed rewrite", () => {
  it("replaces exactly the two pin literals", () => {
    const embedded = embedPin(source, RELEASE);
    expect(readPin(embedded)).toEqual(RELEASE);
    // The placeholder constants stay — the launcher's own dev-refusal reads them.
    expect(developmentPin(embedded)).toEqual(developmentPin(source));
  });

  it("is idempotent", () => {
    const once = embedPin(source, RELEASE);
    expect(embedPin(once, RELEASE)).toBe(once);
  });

  it("refuses an integrity that is not an npm sha512", () => {
    expect(() => embedPin(source, { version: "0.9.1", integrity: "sha256-short" })).toThrow(
      "not an npm sha512 integrity",
    );
  });

  it("refuses to embed the development placeholder", () => {
    expect(() =>
      embedPin(source, { version: DEV_PIN_VERSION, integrity: RELEASE.integrity }),
    ).toThrow("development placeholder");
  });

  it("refuses a pins.ts whose package is not the shared constant", () => {
    const tampered = source.replace("package: ENGINE_PACKAGE,", 'package: "@acme/engine",');
    expect(() => embedPin(tampered, RELEASE)).toThrow("not the shared ENGINE_PACKAGE");
  });
});

describe("the ssri", () => {
  it("is the sha512 of the bytes, in npm's spelling", () => {
    const integrity = integrityOf(new TextEncoder().encode("penv"));
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });
});
