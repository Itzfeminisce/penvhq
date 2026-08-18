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

import { describe, expect, it } from "vitest";
import { cmdCommandLine } from "./child.js";

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
