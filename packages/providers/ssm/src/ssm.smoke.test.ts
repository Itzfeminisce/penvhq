/**
 * A sketch against a real AWS account. Excluded from CI by vitest's
 * `*.smoke.test.ts` pattern — the contract proof runs against the in-memory fake
 * in `ssm.test.ts`, which needs no `aws` CLI. Run by hand against a throwaway
 * path in an account you can write to:
 *
 *   AWS_PROFILE=… AWS_REGION=… \
 *     pnpm exec vitest run packages/providers/ssm --mode smoke
 *
 * It uses the default CLI transport, so it proves the `aws` shell-out end to end,
 * including that a value stored as `SecureString` reads back decrypted.
 */

import type { ValueFile } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { createSsmProvider } from "./ssm.js";

describe.skip("SsmProvider against a real AWS account", () => {
  const scoped: ValueFile = {
    namespace: ["redis"],
    name: "password",
    scope: { kind: "environment", environment: "production" },
    encrypted: false,
  };

  it("round-trips a value and its previous version through the aws CLI", async () => {
    const provider = createSsmProvider({ path: `/penv-smoke/${Date.now()}` });

    await provider.write(scoped, "v1");
    await provider.write(scoped, "v2");

    expect(await provider.read(scoped)).toBe("v2");
    expect(await provider.readPrevious(scoped)).toBe("v1");

    await provider.remove(scoped);
    expect(await provider.read(scoped)).toBeUndefined();
  });
});
