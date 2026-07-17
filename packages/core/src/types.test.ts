/**
 * The retention capability is optional by construction: a provider declares it by
 * implementing `readPrevious`, and `retainsPrevious` is the one narrowing penv
 * reads that declaration through. These tests pin both halves — the runtime guard
 * that answers "does this provider retain?", and the type-level guarantee that a
 * bare `Provider` can never be assumed to, so the filesystem legitimately omits
 * the method and still satisfies the contract.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { Provider, RetainingProvider, ValueFile } from "./types.js";
import { retainsPrevious } from "./types.js";

const file: ValueFile = {
  namespace: ["redis"],
  name: "password",
  scope: { kind: "unscoped" },
  encrypted: false,
};

/** The seven mandatory methods, stubbed. A provider is these plus, optionally, retention. */
function baseProvider(type: string): Provider {
  return {
    type,
    read: async () => undefined,
    write: async () => {},
    list: async () => [],
    remove: async () => {},
    readMeta: async () => undefined,
    writeMeta: async () => {},
    removeMeta: async () => {},
  };
}

describe("retainsPrevious", () => {
  it("is false for a provider that declares no retention", () => {
    const provider = baseProvider("filesystem");

    expect(retainsPrevious(provider)).toBe(false);
  });

  it("is true for a provider that implements readPrevious", () => {
    const provider: Provider = {
      ...baseProvider("retaining"),
      readPrevious: async () => "previous",
    };

    expect(retainsPrevious(provider)).toBe(true);
  });

  it("narrows to a provider whose readPrevious can be called and answer undefined", async () => {
    const provider: Provider = {
      ...baseProvider("retaining"),
      readPrevious: async () => undefined,
    };

    if (!retainsPrevious(provider)) throw new Error("expected the provider to declare retention");
    // Absence is a legitimate answer — a pruned previous value, never an error.
    expect(await provider.readPrevious(file)).toBeUndefined();
  });
});

describe("the retention capability is optional", () => {
  it("types readPrevious as possibly absent on a bare Provider", () => {
    expectTypeOf<Provider["readPrevious"]>().toEqualTypeOf<
      ((file: ValueFile) => Promise<string | undefined>) | undefined
    >();
  });

  it("cannot invoke readPrevious on a bare Provider without narrowing first", () => {
    const provider = baseProvider("filesystem");
    // A compile-time assertion, never executed: unguarded, the call does not type-check.
    const callUnguarded = () => {
      // @ts-expect-error readPrevious is optional, so it is possibly undefined here.
      return provider.readPrevious(file);
    };

    expect(typeof callUnguarded).toBe("function");
  });

  it("narrows to a RetainingProvider whose readPrevious is guaranteed present", () => {
    const provider = baseProvider("retaining");
    if (retainsPrevious(provider)) {
      expectTypeOf(provider).toEqualTypeOf<RetainingProvider>();
      expectTypeOf(provider.readPrevious).toEqualTypeOf<
        (file: ValueFile) => Promise<string | undefined>
      >();
    }
  });
});
