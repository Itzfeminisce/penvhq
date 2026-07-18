/**
 * A sketch against a real cluster. Excluded from CI by vitest's `*.smoke.test.ts`
 * pattern — the contract proof runs against the in-memory fake in
 * `kubernetes.test.ts`, which needs no `kubectl`. Run by hand against a throwaway
 * namespace on a cluster you can write to (kind, minikube, …):
 *
 *   kubectl create namespace penv-smoke
 *   pnpm exec vitest run packages/providers/kubernetes --mode smoke
 *
 * It uses the default `kubectl` transport, so it proves the shell-out end to end.
 */

import type { ValueFile } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { createKubernetesProvider } from "./kubernetes.js";

describe.skip("KubernetesProvider against a real cluster", () => {
  const scoped: ValueFile = {
    namespace: ["redis"],
    name: "password",
    scope: { kind: "environment", environment: "production" },
    encrypted: false,
  };

  it("round-trips a value through kubectl", async () => {
    const provider = createKubernetesProvider({ namespace: "penv-smoke", secretName: "penv" });

    await provider.write(scoped, "hunter2");
    expect(await provider.read(scoped)).toBe("hunter2");

    await provider.remove(scoped);
    expect(await provider.read(scoped)).toBeUndefined();
  });
});
