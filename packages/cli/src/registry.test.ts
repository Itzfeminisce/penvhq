/**
 * The provider registry is the CLI's portability seam: it turns a
 * `providers.*.type` into a concrete provider, and it is the one place that
 * refuses a type this build does not carry.
 *
 * The refusal must land at `openProject` — config-open time — not at whichever
 * command first reaches the provider. A config naming a provider this project
 * has not installed should fail loudly and immediately, naming the environment
 * and the package to install, rather than crash halfway through a write. The
 * pre-installed pair (the filesystem tree, the mock) opens everywhere; anything
 * else opens only if its package resolves from the project.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localExtensionsFile,
  MANIFEST_PATH,
  type PenvConfig,
  PenvError,
  packageDir,
  recordsDir,
  serializeLocalExtensions,
  serializeManifest,
} from "@penvhq/core";
import { FilesystemProvider } from "@penvhq/provider-filesystem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localTree, openProject, sourceProviderFor } from "./project.js";
import {
  assertProvidersRegistered,
  createProvider,
  isProviderRegistered,
  localExtensions,
} from "./registry.js";

/** A minimal valid provider plugin: exports the factory penv's seam calls. */
const VALID_PLUGIN = `export const penvProviderFactory = () => ({
  type: "faketype",
  read: async () => undefined,
  write: async () => {},
  list: async () => [],
  remove: async () => {},
  readMeta: async () => undefined,
  writeMeta: async () => {},
  removeMeta: async () => {},
});
`;

/** The same plugin under a chosen `type`, so a test can tell two copies of it apart. */
function pluginWithType(type: string): string {
  return VALID_PLUGIN.replace('"faketype"', JSON.stringify(type));
}

/** Writes a fake provider package into a project's node_modules, so it resolves by name. */
function installFakeProvider(root: string, packageName: string, body: string): void {
  const dir = join(root, "node_modules", ...packageName.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0", type: "module", main: "index.js" }),
    "utf8",
  );
  writeFileSync(join(dir, "index.js"), body, "utf8");
}

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
  mkdirSync(recordsDir(root), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    'import { z } from "zod";\nexport const schema = z.object({});\n',
    "utf8",
  );
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the provider registry", () => {
  it("pre-installs the local tree and the mock, and nothing else", () => {
    expect(isProviderRegistered("@penvhq/provider-filesystem")).toBe(true);
    expect(isProviderRegistered("@penvhq/provider-mock")).toBe(true);
    // Every other provider — vault included — is a package the project installs.
    expect(isProviderRegistered("@penvhq/provider-vault")).toBe(false);
    expect(isProviderRegistered("consul")).toBe(false);
  });

  it("builds the filesystem provider through the registry", () => {
    const provider = createProvider("@penvhq/provider-filesystem", {
      root: FIXTURE_PARENT,
      config: { environments: [], providers: {} },
    });
    expect(provider).toBeInstanceOf(FilesystemProvider);
    expect(provider.type).toBe("@penvhq/provider-filesystem");
  });

  it("refuses a type that is not pre-installed, naming the package to install", () => {
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
    expect(error.remedy ?? "").toContain("penv add consul");
  });

  it("accepts a config naming the registered providers", () => {
    const root = makeProject({ environments: [], providers: {} });
    expect(() =>
      assertProvidersRegistered(
        {
          environments: ["development", "production"],
          providers: {
            development: { type: "@penvhq/provider-mock" },
            production: { type: "@penvhq/provider-vault", location: "secret/app" },
          },
        },
        root,
      ),
    ).not.toThrow();
  });

  it("refuses a config whose provider type is unregistered, naming the environment", () => {
    const root = makeProject({ environments: [], providers: {} });
    let thrown: unknown;
    try {
      assertProvidersRegistered(
        {
          environments: ["production"],
          providers: { production: { type: "consul", location: "secret/app" } },
        },
        root,
      );
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

/**
 * A local extension is the package this checkout builds. Development needs it;
 * a pipeline may not have it, because nothing pins the bytes it would run.
 */
describe("a locally added extension", () => {
  const CONFIG: PenvConfig = {
    environments: ["production"],
    providers: { production: { type: "@acme/provider-consul" } },
  };

  function projectWithLocal(): string {
    const root = makeProject({ environments: [], providers: {} });
    installFakeProvider(root, "@acme/provider-consul", VALID_PLUGIN);
    writeFileSync(
      localExtensionsFile(root),
      serializeLocalExtensions(["@acme/provider-consul"]),
      "utf8",
    );
    return root;
  }

  it("refuses in CI, naming the registry path", () => {
    const root = projectWithLocal();
    let thrown: unknown;
    try {
      assertProvidersRegistered(CONFIG, root, { ci: true });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as PenvError).code).toBe("LOCAL_EXTENSION_IN_CI");
    expect((thrown as PenvError).remedy).toContain("penv add @acme/provider-consul");
  });

  it("opens normally where a developer is working", () => {
    const root = projectWithLocal();

    expect(() => assertProvidersRegistered(CONFIG, root, { ci: false })).not.toThrow();
    expect(localExtensions(root)).toEqual(["@acme/provider-consul"]);
  });

  /** The quiet half: a project that records none is unaffected, in CI like anywhere. */
  it("leaves a project with no local list alone", () => {
    const root = makeProject({ environments: [], providers: {} });
    installFakeProvider(root, "@acme/provider-consul", VALID_PLUGIN);

    expect(() => assertProvidersRegistered(CONFIG, root, { ci: true })).not.toThrow();
    expect(localExtensions(root)).toEqual([]);
  });
});

describe("openProject and the registry", () => {
  const FILESYSTEM_CONFIG: PenvConfig = {
    environments: ["development", "production"],
    providers: {
      development: { type: "@penvhq/provider-filesystem" },
      production: { type: "@penvhq/provider-filesystem" },
    },
  };

  it("opens a filesystem project and exposes the tree as the contract", () => {
    const root = makeProject(FILESYSTEM_CONFIG);
    const project = openProject(root);
    expect(project.provider.type).toBe("@penvhq/provider-filesystem");
    // The contract is the static type; the local tree is reachable through
    // `localTree`, which is the only place the sync surface is named.
    expect(localTree(project)).toBeInstanceOf(FilesystemProvider);
  });

  it("refuses at open time a config naming an unregistered provider", () => {
    const root = makeProject({
      environments: ["development", "production"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
        production: { type: "consul", location: "secret/app" },
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

/**
 * A `type` with no pre-installed entry is not an error — it is a package the
 * project depends on, imported by the very name the config declares. This is the
 * seam a private or third-party backend plugs into without ever being named in
 * the CLI.
 */
describe("package-resolved providers", () => {
  it("accepts, at open time, a type whose package resolves from the project", () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-faketype" } },
    });
    installFakeProvider(root, "@penvhq/provider-faketype", VALID_PLUGIN);

    expect(() => openProject(root)).not.toThrow();
  });

  it("refuses at open time a type whose package is not installed, with an install hint", () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-penv-cloud" } },
    });

    let thrown: unknown;
    try {
      openProject(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PenvError);
    const error = thrown as PenvError;
    expect(error.code).toBe("UNKNOWN_PROVIDER");
    expect(error.message).toContain("@penvhq/provider-penv-cloud");
    // The type is the package, so the remedy is actionable verbatim.
    expect(error.remedy ?? "").toContain("penv add @penvhq/provider-penv-cloud");
  });

  it("builds a package provider through the source-of-truth path", async () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-faketype" } },
    });
    installFakeProvider(root, "@penvhq/provider-faketype", VALID_PLUGIN);
    const project = openProject(root);

    const source = await sourceProviderFor(project, "production");

    expect(source.type).toBe("faketype");
  });

  it("imports a provider from any package name the config declares", async () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@acme/custom-provider" } },
    });
    installFakeProvider(root, "@acme/custom-provider", VALID_PLUGIN);
    const project = openProject(root);

    const source = await sourceProviderFor(project, "production");

    expect(source.type).toBe("faketype");
  });

  it("refuses a resolved package that does not export penvProviderFactory", async () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-faketype" } },
    });
    installFakeProvider(root, "@penvhq/provider-faketype", "export const notTheFactory = 1;\n");
    const project = openProject(root);

    await expect(sourceProviderFor(project, "production")).rejects.toMatchObject({
      code: "PROVIDER_PLUGIN_INVALID",
    });
  });

  /**
   * Finding 18: the failure a provider threw is the diagnosis. A refusal that
   * keeps neither the cause nor the file it tried sends the reader to reproduce
   * the import by hand, outside penv.
   */
  it("carries the underlying failure and the file it tried", async () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@penvhq/provider-faketype" } },
    });
    installFakeProvider(
      root,
      "@penvhq/provider-faketype",
      "throw new Error(\"Cannot find package 'consul-client'\");\n",
    );
    const project = openProject(root);

    let thrown: unknown;
    try {
      await sourceProviderFor(project, "production");
    } catch (error) {
      thrown = error;
    }
    const error = thrown as PenvError;
    expect(error.code).toBe("PROVIDER_PLUGIN_LOAD");
    expect(error.summary).toContain("Cannot find package 'consul-client'");
    expect(error.summary).toContain(join(root, "node_modules", "@penvhq", "provider-faketype"));
  });
});

/**
 * The store is the third and last place an extension comes from, and the only
 * one `penv add <package>` fills: it leaves a type declaration in the project
 * and the bytes in `$PENV_HOME`, so nothing about a pinned extension resolves
 * from `node_modules`. Before this, every one of them ended at UNKNOWN_PROVIDER.
 */
describe("an extension the manifest pins", () => {
  const CONSUL = "@penvhq/provider-consul";
  const CONFIG: PenvConfig = {
    environments: ["production"],
    providers: { production: { type: CONSUL } },
  };

  const INTEGRITY = `sha512-${"a".repeat(86)}==`;

  function store(): string {
    const dir = mkdtempSync(join(FIXTURE_PARENT, "store-"));
    created.push(dir);
    vi.stubEnv("PENV_HOME", dir);
    return dir;
  }

  /** A package in `$PENV_HOME` as `penv install` extracts one: a tarball, no node_modules. */
  function installInStore(home: string, version: string, body: string): void {
    const dir = packageDir(home, "extensions", CONSUL, version);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: CONSUL,
        version,
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    writeFileSync(join(dir, "dist", "index.js"), body);
  }

  function pin(root: string, version: string): void {
    const file = join(root, ...MANIFEST_PATH.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      serializeManifest({
        format: 1,
        engine: { package: "@penvhq/cli", version: "0.9.5", integrity: INTEGRITY },
        extensions: { [CONSUL]: { version, integrity: INTEGRITY } },
      }),
    );
  }

  it("resolves and loads from $PENV_HOME at the pinned version", async () => {
    const root = makeProject(CONFIG);
    pin(root, "0.9.5");
    installInStore(store(), "0.9.5", pluginWithType("fromstore"));

    const source = await sourceProviderFor(openProject(root), "production");

    expect(source.type).toBe("fromstore");
  });

  it("runs the version the manifest pins, not another one in the store", async () => {
    const root = makeProject(CONFIG);
    pin(root, "0.9.5");
    const home = store();
    installInStore(home, "0.9.5", pluginWithType("pinned"));
    installInStore(home, "0.10.0", pluginWithType("newer"));

    const source = await sourceProviderFor(openProject(root), "production");

    expect(source.type).toBe("pinned");
  });

  it("refuses one the store does not hold, naming `penv install`", () => {
    const root = makeProject(CONFIG);
    pin(root, "0.9.5");
    store();

    let thrown: unknown;
    try {
      openProject(root);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as PenvError;
    expect(error.code).toBe("EXTENSION_NOT_INSTALLED");
    expect(error.summary).toContain(`${CONSUL}\` 0.9.5 for environment production`);
    expect(error.remedy ?? "").toContain("penv install");
  });

  /** The project's own copy is what a checkout developing against a provider runs. */
  it("lets the project's own node_modules win over the store", async () => {
    const root = makeProject(CONFIG);
    pin(root, "0.9.5");
    installInStore(store(), "0.9.5", pluginWithType("fromstore"));
    installFakeProvider(root, CONSUL, pluginWithType("fromproject"));

    const source = await sourceProviderFor(openProject(root), "production");

    expect(source.type).toBe("fromproject");
  });

  /** The quiet half: a provider the manifest does not pin is refused as before. */
  it("leaves a provider it does not pin unaffected", () => {
    const root = makeProject({
      environments: ["production"],
      providers: { production: { type: "@acme/provider-consul" } },
    });
    pin(root, "0.9.5");
    installInStore(store(), "0.9.5", pluginWithType("fromstore"));

    let thrown: unknown;
    try {
      openProject(root);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as PenvError).code).toBe("UNKNOWN_PROVIDER");
  });

  /**
   * A local extension is the copy this checkout builds, so the store is not a
   * second place to look for it — even when the manifest happens to pin the name.
   */
  it("never answers a local extension out of the store", () => {
    const root = makeProject(CONFIG);
    pin(root, "0.9.5");
    installInStore(store(), "0.9.5", pluginWithType("fromstore"));
    writeFileSync(localExtensionsFile(root), serializeLocalExtensions([CONSUL]), "utf8");

    let thrown: unknown;
    try {
      openProject(root);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as PenvError;
    expect(error.code).toBe("LOCAL_EXTENSION_UNRESOLVED");
    expect(error.remedy ?? "").toContain("dependency of the root");
  });
});
