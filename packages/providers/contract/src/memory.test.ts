/**
 * The in-memory provider is the proof that {@link runProviderContractSuite} is
 * genuinely provider-agnostic. A Map-backed store that shares no code with the
 * filesystem passes the very same behavioural suite the filesystem passes and the
 * Vault adapter must. If this file is green, the portability seam is pluggable —
 * demonstrated with a second provider type and no live backend.
 */

import { retainsPrevious } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { runProviderContractSuite } from "./contract.js";
import { createInMemoryProvider } from "./memory.js";

runProviderContractSuite("memory", () =>
  Promise.resolve({
    provider: createInMemoryProvider(),
    cleanup: () => Promise.resolve(),
  }),
);

describe("InMemoryProvider", () => {
  it("is the memory provider", () => {
    expect(createInMemoryProvider().type).toBe("memory");
  });

  /*
   * The Step 2 capability surface, exercised from the far side: the in-memory
   * provider declares no retention, so the one place penv asks — `retainsPrevious`
   * — answers no rather than guessing. A non-retaining provider is the general
   * case, not an exception; the filesystem and Kubernetes sit here too.
   */
  it("declares no retention, the general case the contract permits", () => {
    expect(retainsPrevious(createInMemoryProvider())).toBe(false);
  });
});
