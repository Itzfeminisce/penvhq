/**
 * The refusal test that has to work across a bundle boundary.
 *
 * A provider extension is published self-contained, so it ships its own copy of
 * these classes: what it throws is a refusal with a constructor penv has never
 * seen. `isPenvErrorLike` is what penv asks instead of `instanceof`, and it has
 * to say yes to that and no to everything else — a Node system error carries a
 * `code` too, and answering yes to one would print a bug as a polished refusal
 * with no stack to report it from.
 */

import { describe, expect, it } from "vitest";
import { isPenvErrorLike, PenvError } from "./errors.js";

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

describe("isPenvErrorLike", () => {
  it("recognises penv's own refusal", () => {
    expect(isPenvErrorLike(new PenvError("CODE", "it will not", "do this"))).toBe(true);
  });

  it("recognises a refusal thrown by a copy of the class it has never seen", () => {
    const refusal = new ForeignRefusal("penv found no `VERCEL_TOKEN`", "Export one.");

    expect(refusal instanceof PenvError).toBe(false);
    expect(isPenvErrorLike(refusal)).toBe(true);
  });

  it("takes a refusal with no remedy, which is a refusal that has none to give", () => {
    expect(isPenvErrorLike(new PenvError("CODE", "it will not"))).toBe(true);
  });

  it("says no to a Node system error, which carries a code and nothing else", () => {
    const failure = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

    expect(isPenvErrorLike(failure)).toBe(false);
  });

  it("says no to a plain error, a plain object of the right shape, and a string", () => {
    expect(isPenvErrorLike(new Error("boom"))).toBe(false);
    expect(isPenvErrorLike({ name: "X", code: "C", message: "m", summary: "m" })).toBe(false);
    expect(isPenvErrorLike("PenvError: boom")).toBe(false);
    expect(isPenvErrorLike(undefined)).toBe(false);
  });
});
