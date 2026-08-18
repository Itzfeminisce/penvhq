/**
 * `$PENV_HOME` is where every version any project pins ends up, so the two
 * properties tested here are the ones that keep versions apart and keep an
 * archive from writing outside the store — plus the fallback that makes a
 * manifest-format refusal name a real command on a machine no installer
 * recorded anything on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PenvError } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { launcherUpdateCommand, NPM_UPDATE_COMMAND, packageDir, penvHome } from "./home.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-home-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("penvHome", () => {
  it("is ~/.penv unless the environment says otherwise", () => {
    expect(penvHome({})).toBe(join(homedir(), ".penv"));
    expect(penvHome({ PENV_HOME: "" })).toBe(join(homedir(), ".penv"));
  });

  it("takes the declared store, absolute", () => {
    const dir = scratch();

    expect(penvHome({ PENV_HOME: dir })).toBe(dir);
  });
});

describe("packageDir", () => {
  it("addresses a package by exact name and exact version", () => {
    const home = scratch();

    expect(packageDir(home, "engines", "@penvhq/cli", "0.9.0")).toBe(
      join(home, "engines", "@penvhq", "cli", "0.9.0"),
    );
    expect(packageDir(home, "extensions", "provider-consul", "1.4.2")).toBe(
      join(home, "extensions", "provider-consul", "1.4.2"),
    );
  });

  it("refuses a name that resolves outside the store", () => {
    const failure = () => packageDir(scratch(), "engines", "../../evil", "0.9.0");

    expect(failure).toThrow(PenvError);
    expect(failure).toThrow(/outside/);
  });

  /** Inside `$PENV_HOME` is not enough: an engine filed among the extensions is not an engine. */
  it("refuses a name that lands in the other bucket", () => {
    const failure = () => packageDir(scratch(), "engines", "../extensions/evil", "0.9.0");

    expect(failure).toThrow(PenvError);
    expect(failure).toThrow(/outside/);
  });
});

describe("launcherUpdateCommand", () => {
  it("is what the installer recorded", () => {
    const home = scratch();
    writeFileSync(
      join(home, "meta.json"),
      JSON.stringify({ installMethod: "homebrew", updateCommand: "brew upgrade penv" }),
    );

    expect(launcherUpdateCommand(home)).toBe("brew upgrade penv");
  });

  it("falls back to npm when nothing was recorded", () => {
    const home = scratch();

    expect(launcherUpdateCommand(home)).toBe(NPM_UPDATE_COMMAND);

    writeFileSync(join(home, "meta.json"), "{ not json");
    expect(launcherUpdateCommand(home)).toBe(NPM_UPDATE_COMMAND);

    writeFileSync(join(home, "meta.json"), JSON.stringify({ updateCommand: 7 }));
    expect(launcherUpdateCommand(home)).toBe(NPM_UPDATE_COMMAND);

    mkdirSync(join(home, "engines"), { recursive: true });
    expect(launcherUpdateCommand(home)).toBe(NPM_UPDATE_COMMAND);
  });
});
