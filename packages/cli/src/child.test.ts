/**
 * The one command line cmd.exe is handed on Windows.
 *
 * It is the only place penv rebuilds a command rather than passing it through,
 * and it exists because Node will not execute a `.cmd` without a shell. What has
 * to hold is that the child receives the bytes penv was given: a `&` in an
 * argument is data, and cmd would run it as a command line separator if it were
 * escaped one round short.
 *
 * The path is spelled in both separators on purpose. A shell, a lockfile and a
 * user all write `node_modules/.bin/next.cmd` with forward slashes, and it is
 * the same shim as the backslash spelling — the double escape has to be decided
 * on what cmd will see, not on what was typed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdCommandLine, findExecutable, startChild } from "./child.js";

/** A package-manager shim: cmd expands its arguments twice, so penv escapes twice. */
const SHIM_LINE = String.raw`node_modules\.bin\next.cmd ^^^"a^^^&b^^^"`;

/** Anything else: cmd expands once. */
const PLAIN_LINE = String.raw`C:\tools\wrap.cmd ^"a^&b^"`;

describe("the command line a .cmd target is started through", () => {
  it("double-escapes a shim written with backslashes", () => {
    expect(cmdCommandLine(String.raw`.\node_modules\.bin\next.cmd`, ["a&b"])).toBe(SHIM_LINE);
  });

  it("double-escapes the same shim written with forward slashes", () => {
    expect(cmdCommandLine("./node_modules/.bin/next.cmd", ["a&b"])).toBe(SHIM_LINE);
  });

  it("escapes once for a .cmd that is not a shim", () => {
    expect(cmdCommandLine(String.raw`C:\tools\wrap.cmd`, ["a&b"])).toBe(PLAIN_LINE);
  });

  it("finds a shim below an absolute forward-slash path", () => {
    expect(cmdCommandLine("C:/app/node_modules/.bin/next.cmd", ["a&b"])).toBe(
      String.raw`C:\app\node_modules\.bin\next.cmd ^^^"a^^^&b^^^"`,
    );
  });
});

/**
 * Which file on PATH a bare name means.
 *
 * pnpm, npm, npx and every `node_modules/.bin` tool install two files under one
 * name on Windows: the extensionless POSIX shell script, and the `.CMD` shim
 * beside it. Only the second is a program Windows can start, so the extension
 * order is the whole behavior — trying the bare name first picked the script,
 * which is not a `.cmd`, so the cmd.exe wrapper above was never reached and
 * `penv run -- pnpm dev` died with ENOENT.
 */
describe("finding the executable a bare name means", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A PATH directory holding the files npm-installed tools really lay down. */
  function pathDir(names: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "penv-path-"));
    created.push(dir);
    for (const name of names) {
      writeFileSync(join(dir, name), "", "utf8");
    }
    return dir;
  }

  it("takes the .CMD shim on Windows, not the shell script beside it", () => {
    const dir = pathDir(["pnpm", "pnpm.CMD"]);

    expect(findExecutable("pnpm", { PATH: dir }, "win32")).toBe(join(dir, "pnpm.CMD"));
  });

  it("takes the extensionless file on POSIX, where the shim means nothing", () => {
    const dir = pathDir(["pnpm", "pnpm.CMD"]);

    expect(findExecutable("pnpm", { PATH: dir }, "linux")).toBe(join(dir, "pnpm"));
  });

  /**
   * The quiet case: a real executable still wins, so `node` is spawned directly
   * and never routed through cmd. Spelled as PATHEXT spells it, so the fixture
   * is the same file on a case-sensitive filesystem as on Windows.
   */
  it("leaves a real executable alone on Windows rather than reaching for a shim", () => {
    const dir = pathDir(["node", "node.EXE"]);

    expect(findExecutable("node", { PATH: dir }, "win32")).toBe(join(dir, "node.EXE"));
  });

  /** The bare name goes last, not away: a file with no extension is still found. */
  it("still finds a name with no extension at all on Windows", () => {
    const dir = pathDir(["mytool"]);

    expect(findExecutable("mytool", { PATH: dir }, "win32")).toBe(join(dir, "mytool"));
  });
});

describe("a command that could not be started", () => {
  /** The user's command, from after `--`: the remedy is about what they typed. */
  it("sends the reader back to the command after `--`", async () => {
    const child = startChild({
      command: ["penv-no-such-executable"],
      env: {},
      cwd: process.cwd(),
    });

    await expect(child.ended).rejects.toMatchObject({
      code: "RUN_COMMAND_NOT_STARTED",
      remedy: expect.stringContaining("after `--`"),
    });
  });

  /** penv's own spawn: there is no `--`, so the message names what penv started. */
  it("names what penv itself tried to start when the spawn was penv's", async () => {
    const child = startChild({
      command: ["penv-no-such-package-manager", "add"],
      env: {},
      cwd: process.cwd(),
      purpose: "install @penvhq/penv",
    });

    await expect(child.ended).rejects.toMatchObject({
      code: "PENV_COMMAND_NOT_STARTED",
      message: expect.stringContaining(
        "penv could not start `penv-no-such-package-manager` to install @penvhq/penv",
      ),
    });
    await expect(child.ended).rejects.toMatchObject({
      remedy: expect.not.stringContaining("--"),
    });
  });
});
