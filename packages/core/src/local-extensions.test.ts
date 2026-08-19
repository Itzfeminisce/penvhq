/**
 * The list is names and nothing else, so the only things it can be wrong about
 * are shape. It is committed and hand-editable, so a wrong shape is refused
 * rather than read past — a name penv silently dropped is an extension it would
 * then treat as pinned.
 */

import { describe, expect, it } from "vitest";
import { parseLocalExtensions, serializeLocalExtensions } from "./local-extensions.js";

describe("the local-extension list", () => {
  it("round-trips, sorted and deduped", () => {
    const text = serializeLocalExtensions(["@b/two", "@a/one", "@b/two"]);

    expect(text).toBe('[\n  "@a/one",\n  "@b/two"\n]\n');
    expect(parseLocalExtensions(text)).toEqual(["@a/one", "@b/two"]);
  });

  it("reads an empty list as no local extensions", () => {
    expect(parseLocalExtensions("[]")).toEqual([]);
  });

  it("refuses anything that is not a list of names", () => {
    expect(() => parseLocalExtensions("{")).toThrowError(/not valid JSON/);
    expect(() => parseLocalExtensions('{"a":1}')).toThrowError(/root is not an array/);
    expect(() => parseLocalExtensions("[1]")).toThrowError(/not a package name/);
    expect(() => parseLocalExtensions('[" "]')).toThrowError(/not a package name/);
  });
});
