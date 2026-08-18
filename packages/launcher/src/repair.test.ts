/**
 * The tolerant read exists so a refusal's own remedy can run. What it must never
 * become is a second, laxer manifest reader: everything outside the extension
 * entries refuses exactly as `parseManifest` does, and what comes back is an
 * ordinary `Manifest`, so nothing broken can be written back out.
 */

import { describe, expect, it } from "vitest";
import { integrityOf } from "./integrity.js";
import { readManifestForRepair } from "./repair.js";

const INTEGRITY = integrityOf(new Uint8Array([1, 2, 3]));

function manifest(extensions: unknown): string {
  return JSON.stringify({
    format: 1,
    engine: { package: "@penvhq/cli", version: "0.9.0", integrity: INTEGRITY },
    extensions,
  });
}

const VAULT = "@penvhq/provider-vault";
const CONSUL = "@acme/provider-consul";

describe("readManifestForRepair", () => {
  it("keeps the entries that validate and names the ones that do not", () => {
    const result = readManifestForRepair(
      manifest({
        [VAULT]: { version: "0.9.0", integrity: INTEGRITY },
        [CONSUL]: { version: 8, integrity: INTEGRITY },
      }),
    );

    expect(Object.keys(result.manifest.extensions)).toEqual([VAULT]);
    expect(result.broken).toEqual([CONSUL]);
  });

  /** The negative case: a manifest with nothing wrong reads as itself. */
  it("names nothing broken in a manifest that parses", () => {
    const result = readManifestForRepair(
      manifest({ [VAULT]: { version: "0.9.0", integrity: INTEGRITY } }),
    );

    expect(result.broken).toEqual([]);
    expect(result.manifest.extensions[VAULT]?.version).toBe("0.9.0");
  });

  it("refuses a format this engine does not read", () => {
    expect(() => readManifestForRepair(manifest({}).replace('"format":1', '"format":2'))).toThrow(
      /format 2/,
    );
  });

  it("refuses a broken engine pin, which no `penv add` rewrites", () => {
    expect(() =>
      readManifestForRepair(manifest({}).replace('"version":"0.9.0"', '"version":"^0.9.0"')),
    ).toThrow(/range or a tag/);
  });

  it("refuses a file that is not a manifest at all", () => {
    expect(() => readManifestForRepair("not json")).toThrow(/not valid JSON/);
    expect(() => readManifestForRepair(manifest(7))).toThrow(/extensions/);
  });

  /** A trust block that must not be there is a broken entry like any other. */
  it("treats a rule about the entry as a broken entry", () => {
    const result = readManifestForRepair(
      manifest({ [CONSUL]: { version: "1.4.2", integrity: INTEGRITY } }),
    );

    expect(result.broken).toEqual([CONSUL]);
    expect(result.manifest.extensions).toEqual({});
  });
});
