/**
 * Finding 25: two refusals from one `penv push`, seconds apart — the engine's
 * printed as the usual two-line block, the provider's printed the same block and
 * then ten frames of its `dist/index.js`. Both were refusals with a code and a
 * remedy; only the one that crossed the extension boundary leaked its internals,
 * because a self-contained extension throws from its own copy of the class.
 *
 * So the block is asserted here for a refusal that is not `instanceof
 * PenvError`, and the stack is asserted for a plain error — the bug path that
 * has to keep it.
 */

import { PenvError } from "@penvhq/core";
import { describe, expect, it, vi } from "vitest";
import { reportError } from "./ui.js";

/** An extension's own copy of the class: same fields, unrelated constructor. */
class ForeignRefusal extends Error {
  override readonly name = "VercelUnavailableError";
  readonly code = "VERCEL_UNAVAILABLE";
  readonly summary: string;
  readonly remedy: string;

  constructor(summary: string, remedy: string) {
    super(`${summary}\n  ${remedy}`);
    this.summary = summary;
    this.remedy = remedy;
  }
}

function reported(error: unknown): string {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  const code = process.exitCode;
  try {
    reportError(error);
  } finally {
    spy.mockRestore();
    process.exitCode = code;
  }
  return written.join("");
}

describe("reportError", () => {
  it("prints a refusal from across the extension boundary exactly as its own", () => {
    const summary = "penv found no `VERCEL_TOKEN` to authenticate to Vercel with";
    const remedy = "Create an access token and export it as `VERCEL_TOKEN`.";
    const foreign = new ForeignRefusal(summary, remedy);

    expect(foreign instanceof PenvError).toBe(false);
    expect(reported(foreign)).toBe(`✗ ${summary}\n  → ${remedy}\n`);
    expect(reported(foreign)).toBe(reported(new PenvError("VERCEL_UNAVAILABLE", summary, remedy)));
  });

  it("keeps the stack of anything that is not a refusal, because that is a bug report", () => {
    const output = reported(new Error("the seam broke"));

    expect(output).toContain("✗ the seam broke\n");
    expect(output).toMatch(/\n\s+at\s/);
  });
});
