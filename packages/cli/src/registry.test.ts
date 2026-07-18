/**
 * The provider registry is the CLI's portability seam: it turns a
 * `providers.*.type` into a concrete provider, and it is the one place that
 * refuses a type this build does not carry.
 *
 * The refusal must land at `openProject` — config-open time — not at whichever
 * command first reaches the provider. A config naming a provider no build carries
 * — `consul` here, a type this build has never registered — should fail loudly
 * and immediately, naming the environment, rather than crash halfway through a
 * write. The registered set (`filesystem`, `vault`, `mock`) opens; anything
 * outside it is refused at the seam.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PenvConfig, PenvError } from "@penvhq/core";
import { FilesystemProvider } from "@penvhq/provider-filesystem";
import { afterEach, describe, expect, it } from "vitest";
import { localTree, openProject } from "./project.js";
import { assertProvidersRegistered, createProvider, isProviderRegistered } from "./registry.js";

const FIXTURE_PARENT = fileURLToPath(new URL("./node_modules/.penv-test/", import.meta.url));

const created: string[] = [];

function makeProject(config: PenvConfig): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "registry-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    'import { z } from "zod";\nexport const schema = z.object({});\n',
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the provider registry", () => {
  it("registers the built-in providers and nothing that does not exist", () => {
    expect(isProviderRegistered("filesystem")).toBe(true);
    expect(isProviderRegistered("vault")).toBe(true);
    expect(isProviderRegistered("mock")).toBe(true);
    expect(isProviderRegistered("consul")).toBe(false);
  });

  it("builds the filesystem provider through the registry", () => {
    const provider = createProvider("filesystem", {
      root: FIXTURE_PARENT,
      config: { environments: [], providers: {} },
    });
    expect(provider).toBeInstanceOf(FilesystemProvider);
    expect(provider.type).toBe("filesystem");
  });

  it("refuses an unregistered type, naming what this build carries", () => {
    let thrown: unknown;
    try {
      createProvider("consul", {
        root: FIXTURE_PARENT,
        config: { environments: [], providers: {} },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PenvError);
    const error = thrown as PenvError;
    expect(error.code).toBe("UNKNOWN_PROVIDER");
    expect(error.message).toContain("consul");
    expect(error.message).toContain("filesystem");
  });

  it("accepts a config naming the registered providers", () => {
    expect(() =>
      assertProvidersRegistered({
        environments: ["development", "production"],
        providers: {
          development: { type: "mock" },
          production: { type: "vault", path: "secret/app" },
        },
      }),
    ).not.toThrow();
  });

  it("refuses a config whose provider type is unregistered, naming the environment", () => {
    let thrown: unknown;
    try {
      assertProvidersRegistered({
        environments: ["production"],
        providers: { production: { type: "consul", path: "secret/app" } },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PenvError);
    const error = thrown as PenvError;
    expect(error.code).toBe("UNKNOWN_PROVIDER");
    expect(error.message).toContain("production");
    expect(error.message).toContain("consul");
  });
});

describe("openProject and the registry", () => {
  const FILESYSTEM_CONFIG: PenvConfig = {
    environments: ["development", "production"],
    providers: {
      development: { type: "filesystem" },
      production: { type: "filesystem" },
    },
  };

  it("opens a filesystem project and exposes the tree as the contract", () => {
    const root = makeProject(FILESYSTEM_CONFIG);
    const project = openProject(root);
    expect(project.provider.type).toBe("filesystem");
    // The contract is the static type; the local tree is reachable through
    // `localTree`, which is the only place the sync surface is named.
    expect(localTree(project)).toBeInstanceOf(FilesystemProvider);
  });

  it("refuses at open time a config naming an unregistered provider", () => {
    const root = makeProject({
      environments: ["development", "production"],
      providers: {
        development: { type: "filesystem" },
        production: { type: "consul", path: "secret/app" },
      },
    });
    expect(() => openProject(root)).toThrow(PenvError);
    try {
      openProject(root);
    } catch (error) {
      expect((error as PenvError).code).toBe("UNKNOWN_PROVIDER");
      expect((error as PenvError).message).toContain("production");
    }
  });
});
