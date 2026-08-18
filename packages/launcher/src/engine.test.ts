/**
 * An installed directory becomes something to run through its `bin`, and the
 * refusal when it does not is the same shape as every other one: an engine penv
 * cannot start is a package to reinstall, not a stack trace.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineAt } from "./engine.js";
import { EngineEntryError } from "./errors.js";

const created: string[] = [];

function scratch(bin?: unknown, entry = "bin.js"): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-engine-"));
  created.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@penvhq/cli",
      version: "0.9.0",
      ...(bin === undefined ? {} : { bin }),
    }),
  );
  if (entry !== "") {
    writeFileSync(join(dir, entry), "");
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("engineAt", () => {
  it("takes the engine's own bin when the package declares several", () => {
    const dir = scratch({ other: "./other.js", "penv-engine": "./bin.js" });

    expect(engineAt(dir, "@penvhq/cli", "0.9.0").entry).toBe(join(dir, "bin.js"));
  });

  it("takes a single bin whatever it is called", () => {
    const dir = scratch({ solo: "./bin.js" });

    expect(engineAt(dir, "@penvhq/cli", "0.9.0").entry).toBe(join(dir, "bin.js"));
  });

  it("takes a bin declared as a string", () => {
    const dir = scratch("./bin.js");

    expect(engineAt(dir, "@penvhq/cli", "0.9.0").entry).toBe(join(dir, "bin.js"));
  });

  it("refuses a package with no bin, and one whose bin is not there", () => {
    const noBin = scratch();
    expect(() => engineAt(noBin, "@penvhq/cli", "0.9.0")).toThrow(EngineEntryError);

    const noEntry = scratch({ "penv-engine": "./missing.js" });
    const failure = () => engineAt(noEntry, "@penvhq/cli", "0.9.0");
    expect(failure).toThrow(EngineEntryError);
    expect(failure).toThrow(/declares no bin penv can run/);
  });

  it("refuses a directory with no package.json at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "penv-engine-"));
    created.push(empty);

    expect(() => engineAt(empty, "@penvhq/cli", "0.9.0")).toThrow(EngineEntryError);
  });

  /** `bin` is the package's own text, so it is checked like every other untrusted path. */
  it("refuses a bin that climbs out of the package directory", () => {
    // The climb must land somewhere writable, so the package sits two levels deep.
    const root = mkdtempSync(join(tmpdir(), "penv-engine-"));
    created.push(root);
    const dir = join(root, "inner", "pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@penvhq/cli", version: "0.9.0", bin: { "penv-engine": "../../escape.js" } }),
    );
    writeFileSync(join(root, "escape.js"), "");

    expect(() => engineAt(dir, "@penvhq/cli", "0.9.0")).toThrow(EngineEntryError);
  });

  /** The negative case: a path with a `..` in it that still lands inside is fine. */
  it("takes a bin that walks down and back into the package", () => {
    const dir = scratch({ "penv-engine": "./lib/../bin.js" });

    expect(engineAt(dir, "@penvhq/cli", "0.9.0").entry).toBe(join(dir, "bin.js"));
  });
});
