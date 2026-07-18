import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParameterRef, Scope, ValueFile } from "@penvhq/core";
import { retainsPrevious } from "@penvhq/core";
import { runProviderContractSuite } from "@penvhq/provider-contract";
import { afterAll, describe, expect, it } from "vitest";
import { createMockProvider } from "./mock.js";

const dirs: string[] = [];

/** A fresh temp directory to hold one provider's JSON store, tracked for cleanup. */
function makeStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-mock-"));
  dirs.push(dir);
  return join(dir, "store.json");
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

runProviderContractSuite("mock", () => {
  const storePath = makeStorePath();
  const provider = createMockProvider({ storePath });
  return Promise.resolve({
    provider,
    cleanup: () => {
      rmSync(storePath, { force: true });
      return Promise.resolve();
    },
  });
});

describe("mock provider retention", () => {
  const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };
  const scope: Scope = { kind: "environment", environment: "production" };
  const file: ValueFile = {
    namespace: redisPassword.namespace,
    name: redisPassword.name,
    scope,
    encrypted: false,
  };

  it("declares retention through retainsPrevious", () => {
    const provider = createMockProvider({ storePath: makeStorePath() });
    expect(retainsPrevious(provider)).toBe(true);
  });

  it("returns the newest value from read and the one before it from readPrevious", async () => {
    const provider = createMockProvider({ storePath: makeStorePath() });

    await provider.write(file, "v1");
    await provider.write(file, "v2");

    expect(await provider.read(file)).toBe("v2");
    expect(await provider.readPrevious(file)).toBe("v1");
  });

  it("has no previous value at a single-version address", async () => {
    const provider = createMockProvider({ storePath: makeStorePath() });

    await provider.write(file, "only");

    expect(await provider.readPrevious(file)).toBeUndefined();
  });

  it("has no previous value at a never-written address", async () => {
    const provider = createMockProvider({ storePath: makeStorePath() });

    expect(await provider.readPrevious(file)).toBeUndefined();
  });

  it("persists versions across providers sharing a store path", async () => {
    const storePath = makeStorePath();
    const first = createMockProvider({ storePath });

    await first.write(file, "v1");
    await first.write(file, "v2");

    // A second process would construct a fresh provider against the same file.
    const second = createMockProvider({ storePath });

    expect(await second.read(file)).toBe("v2");
    expect(await second.readPrevious(file)).toBe("v1");
  });
});
