/**
 * The launcher's own record in the store: the command that updates it. Advisory,
 * so what is tested is that it never turns a refusal about something else into a
 * second failure about a metadata file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherUpdateCommand, NPM_UPDATE_COMMAND } from "./home.js";

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
