/**
 * The launcher protocol, which is a protocol about refusals.
 *
 * Every test here is one answer to "which penv is this project's": the pinned
 * bytes are present and the command crosses untouched, or they are not and the
 * user gets one sentence and one command. The two that matter most are the ones
 * that must never fire together — CI never downloads, and a mismatch is never
 * repaired by downloading over it — so both assert that the fetcher was not
 * called at all.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ManifestEngine } from "@penvhq/core";
import {
  MANIFEST_PATH,
  PENV_HOME_VAR,
  packageDir,
  parseManifest,
  STATE_PATH,
  serializeManifest,
} from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegate.js";
import { nodeSpawner } from "./delegate.js";
import type { Engine } from "./engine.js";
import type { Fetcher } from "./fetcher.js";
import { INTEGRITY_FILE } from "./home.js";
import { integrityOf } from "./integrity.js";
import type { LauncherIo } from "./io.js";
import { type LauncherOptions, runLauncher } from "./launcher.js";
import { BUNDLED_ENGINE_PIN } from "./pins.js";
import { installPin, type Pin } from "./store.js";
import { enginePackage, packTar } from "./tarball.fixtures.js";

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENGINE_TARBALL = packTar(enginePackage("@penvhq/cli", "0.9.0"));
const EXTENSION_TARBALL = packTar(enginePackage("@penvhq/provider-vault", "0.9.0"));

const ENGINE_PIN: Pin = {
  name: "@penvhq/cli",
  version: "0.9.0",
  integrity: integrityOf(ENGINE_TARBALL),
};
const EXTENSION_PIN: Pin = {
  name: "@penvhq/provider-vault",
  version: "0.9.0",
  integrity: integrityOf(EXTENSION_TARBALL),
};

const BUNDLED_VERSION = "0.10.0";
const BUNDLED_TARBALL = packTar(enginePackage("@penvhq/cli", BUNDLED_VERSION));

/** What a released launcher carries: the SSRI npm recorded for the engine beside it. */
const BUNDLED_PIN: ManifestEngine = {
  package: "@penvhq/cli",
  version: BUNDLED_VERSION,
  integrity: integrityOf(BUNDLED_TARBALL),
};

/** The same pin, as the store reads pins. */
const BUNDLED_STORE_PIN: Pin = {
  name: BUNDLED_PIN.package,
  version: BUNDLED_PIN.version,
  integrity: BUNDLED_PIN.integrity,
};

function manifestText(options: { format?: number; extension?: boolean } = {}): string {
  return `${JSON.stringify(
    {
      format: options.format ?? 1,
      engine: {
        package: ENGINE_PIN.name,
        version: ENGINE_PIN.version,
        integrity: ENGINE_PIN.integrity,
      },
      extensions:
        options.extension === true
          ? {
              [EXTENSION_PIN.name]: {
                version: EXTENSION_PIN.version,
                integrity: EXTENSION_PIN.integrity,
              },
            }
          : {},
    },
    null,
    2,
  )}\n`;
}

/** A manifest whose one extension entry pins a number, written past the serializer. */
function brokenEntryManifest(): string {
  return `${JSON.stringify(
    {
      ...(JSON.parse(manifestText()) as Record<string, unknown>),
      extensions: { [EXTENSION_PIN.name]: { version: 9, integrity: EXTENSION_PIN.integrity } },
    },
    null,
    2,
  )}\n`;
}

function projectAt(manifest = manifestText()): string {
  const root = scratch("penv-launch-project-");
  const file = join(root, ...MANIFEST_PATH.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, manifest);
  return root;
}

/** The engine that shipped with the launcher, as a package directory on disk. */
function bundled(): Engine {
  const dir = scratch("penv-bundled-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@penvhq/cli",
      version: BUNDLED_VERSION,
      bin: { "penv-engine": "./bin.js" },
    }),
  );
  writeFileSync(join(dir, "bin.js"), "");
  return { name: "@penvhq/cli", version: BUNDLED_VERSION, dir, entry: join(dir, "bin.js") };
}

interface Harness {
  readonly options: LauncherOptions;
  readonly out: string[];
  readonly err: string[];
  readonly asked: string[];
  readonly questions: string[];
  readonly spawned: Delegation[];
}

function harness(overrides: {
  argv: readonly string[];
  cwd: string;
  home: string;
  env?: Readonly<Record<string, string | undefined>>;
  interactive?: boolean;
  /** One answer, or one per question in the order they are asked. */
  consent?: boolean | readonly boolean[];
  exitCode?: number;
  serve?: Readonly<Record<string, Uint8Array>>;
  pin?: ManifestEngine;
  /** What the delegated child leaves on disk before it exits. */
  onSpawn?: () => void;
}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const questions: string[] = [];
  const spawned: Delegation[] = [];
  const consents = Array.isArray(overrides.consent) ? [...overrides.consent] : undefined;

  const io: LauncherIo = {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
    interactive: overrides.interactive ?? false,
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(
        consents === undefined ? overrides.consent === true : consents.shift() === true,
      );
    },
    ask: (question) => {
      questions.push(question);
      return Promise.resolve("Reviewed the source.");
    },
  };

  const serve = overrides.serve ?? {};
  const fetcher: Fetcher = {
    get: (url) => {
      asked.push(url);
      const bytes = serve[url];
      return bytes === undefined
        ? Promise.reject(new Error("the registry answered 404 Not Found"))
        : Promise.resolve(bytes);
    },
  };

  return {
    out,
    err,
    asked,
    questions,
    spawned,
    options: {
      argv: overrides.argv,
      cwd: overrides.cwd,
      env: { [PENV_HOME_VAR]: overrides.home, ...overrides.env },
      io,
      fetcher,
      spawn: (delegation) => {
        spawned.push(delegation);
        overrides.onSpawn?.();
        return Promise.resolve(overrides.exitCode ?? 0);
      },
      bundledEngine: bundled,
      bundledPin: overrides.pin ?? BUNDLED_PIN,
    },
  };
}

const REGISTRY: Readonly<Record<string, Uint8Array>> = {
  "https://registry.npmjs.org/@penvhq/cli/-/cli-0.9.0.tgz": ENGINE_TARBALL,
  "https://registry.npmjs.org/@penvhq/provider-vault/-/provider-vault-0.9.0.tgz": EXTENSION_TARBALL,
};

/** What the registry serves the engine a released launcher ships. */
const BUNDLED_REGISTRY: Readonly<Record<string, Uint8Array>> = {
  [`https://registry.npmjs.org/@penvhq/cli/-/cli-${BUNDLED_VERSION}.tgz`]: BUNDLED_TARBALL,
};

async function install(home: string, pin: Pin, tarball: Uint8Array): Promise<string> {
  return installPin({
    home,
    kind: pin === EXTENSION_PIN ? "extensions" : "engines",
    pin,
    fetcher: { get: () => Promise.resolve(tarball) },
  });
}

describe("outside a project", () => {
  it("prints the bundled engine's version, and runs nothing", async () => {
    const test = harness({
      argv: ["--version"],
      cwd: scratch("penv-nowhere-"),
      home: scratch("penv-home-"),
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.out).toEqual([`penv ${BUNDLED_VERSION}`]);
    expect(test.spawned).toEqual([]);
  });

  it("runs init on the bundled engine, argv untouched", async () => {
    const cwd = scratch("penv-nowhere-");
    const test = harness({ argv: ["init", "--yes"], cwd, home: scratch("penv-home-") });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned).toHaveLength(1);
    expect(test.spawned[0]?.args.slice(1)).toEqual(["init", "--yes"]);
    expect(test.spawned[0]?.cwd).toBe(cwd);
  });

  it("refuses every other command, naming init", async () => {
    const cwd = scratch("penv-nowhere-");
    const test = harness({ argv: ["get", "redis/password"], cwd, home: scratch("penv-home-") });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.spawned).toEqual([]);
    expect(test.err).toEqual([
      `✗ penv found no ${MANIFEST_PATH} in ${cwd} or any parent directory`,
      "  → Run `penv init` here to adopt this project.",
    ]);
  });
});

describe("the manifest an adoption leaves behind", () => {
  /** What a delegated `init` or `migrate` writes: the state directory, and no manifest. */
  function scaffold(root: string): void {
    mkdirSync(join(root, ...STATE_PATH.split("/")), { recursive: true });
  }

  function manifestOf(root: string): string {
    return join(root, ...MANIFEST_PATH.split("/"));
  }

  it("pins the engine that adopted the project", async () => {
    const cwd = scratch("penv-adopt-");
    const test = harness({
      argv: ["init", "--yes"],
      cwd,
      home: scratch("penv-home-"),
      onSpawn: () => {
        scaffold(cwd);
      },
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(JSON.parse(readFileSync(manifestOf(cwd), "utf8"))).toEqual({
      format: 1,
      engine: BUNDLED_PIN,
      extensions: {},
    });
    expect(test.out[0]).toBe(`✓ ${MANIFEST_PATH} pins @penvhq/cli ${BUNDLED_VERSION}`);
  });

  it("writes what parseManifest reads back and serializeManifest writes again", async () => {
    const cwd = scratch("penv-adopt-");
    const test = harness({
      argv: ["init", "--yes"],
      cwd,
      home: scratch("penv-home-"),
      onSpawn: () => {
        scaffold(cwd);
      },
    });

    expect(await runLauncher(test.options)).toBe(0);
    const text = readFileSync(manifestOf(cwd), "utf8");
    expect(serializeManifest(parseManifest(text))).toBe(text);
  });

  it("pins a migrated project from wherever migrate was run", async () => {
    const root = scratch("penv-migrated-");
    const cwd = join(root, "apps", "api");
    mkdirSync(cwd, { recursive: true });
    const test = harness({
      argv: ["migrate", "--yes"],
      cwd,
      home: scratch("penv-home-"),
      onSpawn: () => {
        scaffold(root);
      },
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(JSON.parse(readFileSync(manifestOf(root), "utf8")).engine).toEqual(BUNDLED_PIN);
  });

  it("never writes over a manifest that is already there", async () => {
    const cwd = scratch("penv-adopt-");
    const existing = manifestText();
    const test = harness({
      argv: ["init"],
      cwd,
      home: scratch("penv-home-"),
      onSpawn: () => {
        scaffold(cwd);
        writeFileSync(manifestOf(cwd), existing);
      },
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(readFileSync(manifestOf(cwd), "utf8")).toBe(existing);
    expect(test.out).toEqual([]);
  });

  it("writes nothing when the adoption failed", async () => {
    const cwd = scratch("penv-adopt-");
    const test = harness({
      argv: ["init"],
      cwd,
      home: scratch("penv-home-"),
      exitCode: 4,
      onSpawn: () => {
        scaffold(cwd);
      },
    });

    expect(await runLauncher(test.options)).toBe(4);
    expect(existsSync(manifestOf(cwd))).toBe(false);
  });

  it("writes nothing when the command adopted nothing", async () => {
    const cwd = scratch("penv-nowhere-");
    const test = harness({ argv: ["migrate"], cwd, home: scratch("penv-home-") });

    expect(await runLauncher(test.options)).toBe(0);
    expect(existsSync(join(cwd, ".penv"))).toBe(false);
    expect(test.out).toEqual([]);
  });

  it("refuses to pin a project with a launcher built from source", async () => {
    const cwd = scratch("penv-adopt-");
    const test = harness({
      argv: ["init", "--yes"],
      cwd,
      home: scratch("penv-home-"),
      pin: BUNDLED_ENGINE_PIN,
      onSpawn: () => {
        scaffold(cwd);
      },
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(existsSync(manifestOf(cwd))).toBe(false);
    expect(test.err).toEqual([
      `✗ This penv was built from source, so it carries no published integrity for @penvhq/cli to write into ${MANIFEST_PATH}`,
      "  → Install penv from npm with `npm install -g @penvhq/launcher` and run the command again — a released launcher ships the integrity of the engine it ships.",
    ]);
  });

  it("refuses to pin a version other than the one that ran", async () => {
    const cwd = scratch("penv-adopt-");
    const test = harness({
      argv: ["init", "--yes"],
      cwd,
      home: scratch("penv-home-"),
      pin: { ...BUNDLED_PIN, version: "0.9.0" },
      onSpawn: () => {
        scaffold(cwd);
      },
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(existsSync(manifestOf(cwd))).toBe(false);
    expect(test.err[0]).toBe(
      `✗ This penv carries the integrity of @penvhq/cli 0.9.0 and just ran ${BUNDLED_VERSION}, so it cannot record which bytes scaffolded this project`,
    );
  });

  /**
   * Adoption closes by telling the developer to start their app with
   * `penv run -- …`, and nothing had put the engine that command needs in
   * `$PENV_HOME` — so the very next thing they typed refused. The install is
   * offered here, where there is still somebody reading.
   */
  describe("the engine the adoption pinned", () => {
    const NEXT_STEP = `→ Run \`penv install\` to install @penvhq/cli ${BUNDLED_VERSION} before your first \`penv run\`.`;

    function adopting(overrides: Partial<Parameters<typeof harness>[0]> = {}) {
      const cwd = scratch("penv-adopt-");
      return {
        cwd,
        test: harness({
          argv: ["init", "--yes"],
          cwd,
          home: scratch("penv-home-"),
          serve: BUNDLED_REGISTRY,
          onSpawn: () => {
            scaffold(cwd);
          },
          ...overrides,
        }),
      };
    }

    function installedIn(home: string): boolean {
      return existsSync(
        join(packageDir(home, "engines", "@penvhq/cli", BUNDLED_VERSION), "bin.js"),
      );
    }

    it("is installed after one consent line", async () => {
      const { test } = adopting({ interactive: true, consent: true });
      const home = test.options.env[PENV_HOME_VAR] ?? "";

      expect(await runLauncher(test.options)).toBe(0);
      expect(test.questions).toEqual([
        `penv needs @penvhq/cli ${BUNDLED_VERSION} for this project. Download and verify it now?`,
      ]);
      expect(installedIn(home)).toBe(true);
      expect(test.out).not.toContain(NEXT_STEP);
    });

    it("names `penv install` as the next step when the download is declined", async () => {
      const { test } = adopting({ interactive: true, consent: false });

      expect(await runLauncher(test.options)).toBe(0);
      expect(test.out).toContain(NEXT_STEP);
      expect(installedIn(test.options.env[PENV_HOME_VAR] ?? "")).toBe(false);
    });

    /** Nobody to ask is not a reason to close with a command that refuses. */
    it("names `penv install` as the next step with nobody at the terminal", async () => {
      const { test } = adopting({ interactive: false });

      expect(await runLauncher(test.options)).toBe(0);
      expect(test.questions).toEqual([]);
      expect(test.out).toContain(NEXT_STEP);
    });

    /** The quiet case: the bytes are already there, so there is nothing to ask. */
    it("asks nothing when the pinned engine is already installed", async () => {
      const home = scratch("penv-home-");
      await install(home, BUNDLED_STORE_PIN, BUNDLED_TARBALL);
      const { test } = adopting({ home, interactive: true, consent: true });

      expect(await runLauncher(test.options)).toBe(0);
      expect(test.questions).toEqual([]);
      expect(test.asked).toEqual([]);
      expect(test.out).not.toContain(NEXT_STEP);
    });
  });
});

describe("one visible version", () => {
  it("prints the version the project pins, installed or not", async () => {
    const test = harness({
      argv: ["--version"],
      cwd: projectAt(),
      home: scratch("penv-home-"),
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.out).toEqual(["penv 0.9.0"]);
    expect(test.spawned).toEqual([]);
    expect(test.asked).toEqual([]);
  });
});

describe("delegation", () => {
  it("forwards argv byte for byte, and answers with the child's exit code", async () => {
    const home = scratch("penv-home-");
    const dir = await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const root = projectAt();
    const cwd = join(root, "apps", "api");
    mkdirSync(cwd, { recursive: true });
    const test = harness({
      argv: ["run", "--env", "production", "--", "node", "server.js", "a b"],
      cwd,
      home,
      exitCode: 42,
    });

    expect(await runLauncher(test.options)).toBe(42);
    expect(test.spawned).toHaveLength(1);
    const delegation = test.spawned[0];
    expect(delegation?.args).toEqual([
      join(dir, "bin.js"),
      "run",
      "--env",
      "production",
      "--",
      "node",
      "server.js",
      "a b",
    ]);
    expect(delegation?.cwd).toBe(cwd);
    expect(delegation?.env[PENV_HOME_VAR]).toBe(home);
  });

  it("runs the version the manifest pins, not the newest one installed", async () => {
    const home = scratch("penv-home-");
    const newer = packTar(enginePackage("@penvhq/cli", "0.10.0"));
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    await installPin({
      home,
      kind: "engines",
      pin: { name: "@penvhq/cli", version: "0.10.0", integrity: integrityOf(newer) },
      fetcher: { get: () => Promise.resolve(newer) },
    });
    const test = harness({ argv: ["list"], cwd: projectAt(), home });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned[0]?.args[0]).toBe(
      join(packageDir(home, "engines", "@penvhq/cli", "0.9.0"), "bin.js"),
    );
  });

  it("keeps its own flag out of the engine's argv", async () => {
    const home = scratch("penv-home-");
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const test = harness({
      argv: ["--no-download", "list", "--no-download"],
      cwd: projectAt(),
      home,
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned[0]?.args.slice(1)).toEqual(["list", "--no-download"]);
  });
});

describe("the pinned bytes are missing", () => {
  it("refuses in CI, names the preinstall command, and never reaches the registry", async () => {
    const home = scratch("penv-home-");
    const test = harness({
      argv: ["run", "--", "node", "server.js"],
      cwd: projectAt(),
      home,
      env: { CI: "true" },
      interactive: true,
      consent: true,
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.asked).toEqual([]);
    expect(test.questions).toEqual([]);
    expect(test.spawned).toEqual([]);
    expect(test.err).toEqual([
      `✗ @penvhq/cli 0.9.0 is not installed in ${home}, and this run does not download`,
      "  → Run `penv install` — CI and production install the versions the manifest pins before the command that needs them.",
    ]);
  });

  it("refuses under --no-download, and refuses with no terminal", async () => {
    const home = scratch("penv-home-");
    const flagged = harness({
      argv: ["--no-download", "list"],
      cwd: projectAt(),
      home,
      interactive: true,
      consent: true,
      serve: REGISTRY,
    });
    expect(await runLauncher(flagged.options)).toBe(1);
    expect(flagged.asked).toEqual([]);
    expect(flagged.err[0]).toContain("does not download");

    const piped = harness({ argv: ["list"], cwd: projectAt(), home, serve: REGISTRY });
    expect(await runLauncher(piped.options)).toBe(1);
    expect(piped.asked).toEqual([]);
    expect(piped.questions).toEqual([]);
  });

  it("asks once, downloads once, and hands over", async () => {
    const home = scratch("penv-home-");
    const test = harness({
      argv: ["list"],
      cwd: projectAt(),
      home,
      interactive: true,
      consent: true,
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.questions).toEqual([
      "penv needs @penvhq/cli 0.9.0 for this project. Download and verify it now?",
    ]);
    expect(test.asked).toEqual(["https://registry.npmjs.org/@penvhq/cli/-/cli-0.9.0.tgz"]);
    expect(test.spawned).toHaveLength(1);
  });

  it("installs nothing when the offer is declined", async () => {
    const home = scratch("penv-home-");
    const test = harness({
      argv: ["list"],
      cwd: projectAt(),
      home,
      interactive: true,
      consent: false,
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.asked).toEqual([]);
    expect(test.spawned).toEqual([]);
    expect(test.err).toEqual([
      "✗ @penvhq/cli 0.9.0 was not downloaded",
      "  → Run `penv install` when you want penv to fetch the versions this project pins.",
    ]);
  });

  it("refuses a missing extension by name, with the engine installed", async () => {
    const home = scratch("penv-home-");
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const test = harness({
      argv: ["pull"],
      cwd: projectAt(manifestText({ extension: true })),
      home,
      env: { CI: "1" },
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.spawned).toEqual([]);
    expect(test.err[0]).toBe(
      `✗ @penvhq/provider-vault 0.9.0 is not installed in ${home}, and this run does not download`,
    );
  });
});

describe("the installed bytes are not the pinned bytes", () => {
  it("refuses rather than downloading over them", async () => {
    const home = scratch("penv-home-");
    const dir = await install(home, ENGINE_PIN, ENGINE_TARBALL);
    writeFileSync(join(dir, INTEGRITY_FILE), `${integrityOf(new Uint8Array([9]))}\n`);
    const test = harness({
      argv: ["list"],
      cwd: projectAt(),
      home,
      interactive: true,
      consent: true,
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.asked).toEqual([]);
    expect(test.questions).toEqual([]);
    expect(test.spawned).toEqual([]);
    expect(test.err).toEqual([
      `✗ @penvhq/cli 0.9.0 in ${dir} is not the bytes ${MANIFEST_PATH} pins`,
      `  → Delete ${dir} and run \`penv install\` — penv runs the exact bytes the manifest names, or nothing.`,
    ]);
  });
});

describe("a manifest this penv cannot read", () => {
  it("prints the command that updates this launcher and the command the user ran", async () => {
    const home = scratch("penv-home-");
    writeFileSync(join(home, "meta.json"), JSON.stringify({ updateCommand: "brew upgrade penv" }));
    const test = harness({
      argv: ["run", "--env", "production", "--", "node", "index.js"],
      cwd: projectAt(manifestText({ format: 2 })),
      home,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.err).toEqual([
      `✗ ${MANIFEST_PATH} is format 2, and this penv understands format 1`,
      "  → Run `brew upgrade penv`, then `penv run --env production -- node index.js` again.",
    ]);
  });

  it("falls back to the npm command when no installer recorded one", async () => {
    const test = harness({
      argv: ["list"],
      cwd: projectAt(manifestText({ format: 2 })),
      home: scratch("penv-home-"),
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.err[1]).toBe("  → Run `npm install -g @penvhq/launcher`, then `penv list` again.");
  });
});

describe("penv install", () => {
  it("is the one command that downloads in CI, and says what it did", async () => {
    const home = scratch("penv-home-");
    const test = harness({
      argv: ["install"],
      cwd: projectAt(manifestText({ extension: true })),
      home,
      env: { CI: "true" },
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.asked).toEqual(Object.keys(REGISTRY));
    expect(test.out).toEqual([
      "✓ @penvhq/cli 0.9.0 installed",
      "✓ @penvhq/provider-vault 0.9.0 installed",
    ]);
    expect(test.spawned).toEqual([]);
  });

  it("says so when everything is already there", async () => {
    const home = scratch("penv-home-");
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const test = harness({ argv: ["install"], cwd: projectAt(), home, serve: REGISTRY });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.asked).toEqual([]);
    expect(test.out).toEqual(["✓ @penvhq/cli 0.9.0 already installed"]);
  });

  /**
   * `penv install` is the remedy every missing-package refusal names, so it has
   * to run against a manifest holding the entry that refused. It installs what it
   * can read and names the `penv add` for what it cannot.
   */
  it("installs around an entry it cannot read, and names the add that rewrites it", async () => {
    const home = scratch("penv-home-");
    const test = harness({
      argv: ["install"],
      cwd: projectAt(brokenEntryManifest()),
      home,
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.out).toEqual(["✓ @penvhq/cli 0.9.0 installed"]);
    expect(test.err).toEqual([
      "✗ .penv/state/manifest.json holds an extension entry penv cannot read: @penvhq/provider-vault",
      "  → Run `penv add @penvhq/provider-vault` to rewrite that entry — it resolves the package again and records what the registry states.",
    ]);
  });

  /** The engine pin is not an entry, and nothing about the repair path relaxes it. */
  it("still refuses a manifest whose engine pin is wrong", async () => {
    const test = harness({
      argv: ["install"],
      cwd: projectAt(manifestText().replace(`"${ENGINE_PIN.version}"`, "9")),
      home: scratch("penv-home-"),
      serve: REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(1);
    expect(test.asked).toEqual([]);
    expect(test.err[0]).toContain("`engine.version` in .penv/state/manifest.json is a number");
  });
});

describe("penv add", () => {
  const CONSUL = "@acme/provider-consul";
  const CONSUL_TARBALL = packTar([
    { path: "package/", typeflag: "5" },
    {
      path: "package/package.json",
      content: `${JSON.stringify({
        name: CONSUL,
        version: "1.0.0",
        penv: { onboard: "cloud login" },
      })}\n`,
    },
    { path: "package/index.js", content: "" },
  ]);
  const ADD_REGISTRY: Readonly<Record<string, Uint8Array>> = {
    ...REGISTRY,
    [`https://registry.npmjs.org/${CONSUL}`]: new TextEncoder().encode(
      JSON.stringify({
        name: CONSUL,
        "dist-tags": { latest: "1.0.0" },
        time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
        versions: {
          "1.0.0": {
            name: CONSUL,
            version: "1.0.0",
            _npmUser: { name: "acme-oss" },
            dist: { integrity: integrityOf(CONSUL_TARBALL) },
          },
        },
      }),
    ),
    [`https://registry.npmjs.org/${CONSUL}/-/provider-consul-1.0.0.tgz`]: CONSUL_TARBALL,
  };

  it("runs in the project, records the pin, and never reaches the engine", async () => {
    const home = scratch("penv-home-");
    const root = projectAt();
    const test = harness({
      argv: ["add", CONSUL],
      cwd: root,
      home,
      interactive: true,
      consent: [true, false],
      serve: ADD_REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8"));
    expect(manifest.extensions[CONSUL]).toMatchObject({
      version: "1.0.0",
      trust: { tier: "third-party", publisher: "acme-oss" },
    });
  });

  it("delegates the accepted onboarding step to the project's engine", async () => {
    const home = scratch("penv-home-");
    const dir = await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const root = projectAt();
    const test = harness({
      argv: ["add", CONSUL],
      cwd: root,
      home,
      interactive: true,
      consent: true,
      serve: ADD_REGISTRY,
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned).toHaveLength(1);
    expect(test.spawned[0]?.args).toEqual([join(dir, "bin.js"), "cloud", "login"]);
  });
});

/**
 * Finding 19: the engine's help lists the engine's commands, so `install` and
 * `add` appeared in none of them — including the `penv install` the engine's own
 * refusals name — and `penv add --help` was refused outright under a root help
 * promising `penv <command> --help`.
 */
describe("help for the launcher's own commands", () => {
  it("names install, add and upgrade under the engine's own help", async () => {
    const home = scratch("penv-home-");
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const test = harness({ argv: ["--help"], cwd: projectAt(), home });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned).toHaveLength(1);
    expect(test.spawned[0]?.args.slice(1)).toEqual(["--help"]);
    expect(test.out.join("\n")).toContain("LAUNCHER COMMANDS");
    expect(test.out.some((line) => line.startsWith("  install"))).toBe(true);
    expect(test.out.some((line) => line.startsWith("  add <package>"))).toBe(true);
    expect(test.out.some((line) => line.includes("--local <package>"))).toBe(true);
    expect(test.out.some((line) => line.startsWith("  upgrade [version]"))).toBe(true);
  });

  it("prints usage for `penv add --help` and `penv install --help`, reaching no engine", async () => {
    const home = scratch("penv-home-");
    const cwd = projectAt();

    const added = harness({ argv: ["add", "--help"], cwd, home });
    expect(await runLauncher(added.options)).toBe(0);
    expect(added.spawned).toEqual([]);
    expect(added.out[0]).toBe("penv add <package>[@<version>]");
    expect(added.out.some((line) => line.includes("--registry <url>"))).toBe(true);

    const installed = harness({ argv: ["install", "--help"], cwd, home });
    expect(await runLauncher(installed.options)).toBe(0);
    expect(installed.asked).toEqual([]);
    expect(installed.out[0]).toBe("penv install");

    const upgraded = harness({ argv: ["upgrade", "--help"], cwd, home });
    expect(await runLauncher(upgraded.options)).toBe(0);
    expect(upgraded.asked).toEqual([]);
    expect(upgraded.out[0]).toBe("penv upgrade [version]");
    expect(upgraded.out.some((line) => line.includes("--yes"))).toBe(true);
  });

  /** Help is the launcher's before it is a project's — there may be no project yet. */
  it("answers outside a project, where nothing is adopted", async () => {
    const test = harness({
      argv: ["add", "--help"],
      cwd: scratch("penv-nowhere-"),
      home: scratch("penv-home-"),
    });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.err).toEqual([]);
  });

  /** The quiet half: a command's own help is the engine's, and is left alone. */
  it("adds nothing to an engine command's help", async () => {
    const home = scratch("penv-home-");
    await install(home, ENGINE_PIN, ENGINE_TARBALL);
    const test = harness({ argv: ["get", "--help"], cwd: projectAt(), home });

    expect(await runLauncher(test.options)).toBe(0);
    expect(test.spawned[0]?.args.slice(1)).toEqual(["get", "--help"]);
    expect(test.out).toEqual([]);
  });
});

describe("nodeSpawner", () => {
  it("answers with the child's exit code", async () => {
    const spawn = nodeSpawner();

    expect(
      await spawn({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: process.cwd(),
        env: process.env,
      }),
    ).toBe(7);
  });
});
