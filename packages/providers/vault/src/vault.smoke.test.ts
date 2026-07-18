/**
 * A sketch against a real dev-mode Vault. Excluded from CI by vitest's
 * `*.smoke.test.ts` pattern — the contract proof runs against the in-memory fake in
 * `vault.test.ts`, which needs no binary. This exists to be run by hand against a
 * throwaway server:
 *
 *   vault server -dev -dev-root-token-id=root &
 *   VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=root \
 *     pnpm exec vitest run --config vitest.config.ts packages/providers/vault --mode smoke
 *
 * It uses the default CLI transport, so it proves the `vault` shell-out end to end:
 * penv holds no credential, the `vault` process does.
 */

import type { ValueFile } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { createVaultProvider } from "./vault.js";

// Skipped rather than deleted: it documents the real-Vault path and is ready to run
// by hand, but must never gate CI on a running server.
describe.skip("VaultProvider against a real dev-mode Vault", () => {
  const scoped: ValueFile = {
    namespace: ["redis"],
    name: "password",
    scope: { kind: "environment", environment: "production" },
    encrypted: false,
  };

  it("round-trips a value and its previous version through the vault CLI", async () => {
    const provider = createVaultProvider({ path: `penv-smoke/${Date.now()}`, mount: "secret" });

    await provider.write(scoped, "v1");
    await provider.write(scoped, "v2");

    expect(await provider.read(scoped)).toBe("v2");
    expect(await provider.readPrevious(scoped)).toBe("v1");

    await provider.remove(scoped);
    expect(await provider.read(scoped)).toBeUndefined();
  });
});
