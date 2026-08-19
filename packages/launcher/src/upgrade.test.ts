/**
 * Moving the pin, which is two committed files or neither.
 *
 * The tests that matter most are the pair around consent: a yes rewrites the
 * manifest *and* the dependency at one version the registry stated, and a no
 * leaves both files byte-identical. Everything else is about where the integrity
 * comes from — the registry, never this machine — and about who is allowed to
 * decide, which is never a run with nobody at it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallPlan, InstallRuntime } from "@penvhq/cli/install";
import { MANIFEST_PATH, type Manifest, packageDir, serializeManifest } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Fetcher } from "./fetcher.js";
import { integrityOf } from "./integrity.js";
import type { LauncherIo } from "./io.js";
import { enginePackage, packTar } from "./tarball.fixtures.js";
import { type UpgradeOptions, upgrade } from "./upgrade.js";

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

const ENGINE = "@penvhq/cli";
const PINNED = "0.9.0";
const LATEST = "0.9.6";
const OLDER = "0.8.4";

const TARBALLS: Readonly<Record<string, Uint8Array>> = {
  [PINNED]: packTar(enginePackage(ENGINE, PINNED)),
  [LATEST]: packTar(enginePackage(ENGINE, LATEST)),
  [OLDER]: packTar(enginePackage(ENGINE, OLDER)),
};

function integrityFor(version: string): string {
  return integrityOf(TARBALLS[version] ?? new Uint8Array());
}

const PACKUMENT_URL = `https://registry.npmjs.org/${ENGINE}`;

function tarballUrlFor(version: string): string {
  return `https://registry.npmjs.org/${ENGINE}/-/cli-${version}.tgz`;
}

/** Every published version, with `latest` pointing at {@link LATEST}. */
function packument(): Uint8Array {
  const versions = Object.fromEntries(
    Object.keys(TARBALLS).map((version) => [
      version,
      {
        name: ENGINE,
        version,
        dist: { integrity: integrityFor(version), tarball: tarballUrlFor(version) },
      },
    ]),
  );
  return new TextEncoder().encode(
    JSON.stringify({
      name: ENGINE,
      "dist-tags": { latest: LATEST },
      time: Object.fromEntries(
        Object.keys(TARBALLS).map((version) => [version, "2026-01-04T09:00:00.000Z"]),
      ),
      versions,
    }),
  );
}

const REGISTRY: Readonly<Record<string, Uint8Array>> = {
  [PACKUMENT_URL]: packument(),
  ...Object.fromEntries(
    Object.entries(TARBALLS).map(([version, bytes]) => [tarballUrlFor(version), bytes]),
  ),
};

function manifestFor(version: string, extensions: Manifest["extensions"] = {}): Manifest {
  return {
    format: 1,
    engine: { package: ENGINE, version, integrity: integrityFor(version) },
    extensions,
  };
}

function baseManifest(extensions: Manifest["extensions"] = {}): Manifest {
  return manifestFor(PINNED, extensions);
}

interface ProjectOptions {
  readonly manifest?: Manifest;
  /** What `package.json` declares for `@penvhq/penv` today. */
  readonly declared?: string;
  /** The lockfile that names the project's package manager. */
  readonly lockfile?: string;
  /** Workspace packages under `packages/`, each with what it declares. */
  readonly workspace?: Readonly<Record<string, string>>;
}

function projectAt(options: ProjectOptions = {}): string {
  const root = scratch("penv-upgrade-project-");
  const manifestFile = join(root, ...MANIFEST_PATH.split("/"));
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, serializeManifest(options.manifest ?? baseManifest()));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "acme-api",
        dependencies: { "@penvhq/penv": options.declared ?? PINNED, zod: "4.4.3" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, options.lockfile ?? "pnpm-lock.yaml"), "");
  if (options.workspace !== undefined) {
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    for (const [name, declared] of Object.entries(options.workspace)) {
      const dir = join(root, "packages", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: `@acme/${name}`, dependencies: { "@penvhq/penv": declared } }, null, 2)}\n`,
      );
    }
  }
  return root;
}

interface Harness {
  readonly options: UpgradeOptions;
  readonly root: string;
  readonly home: string;
  readonly out: string[];
  readonly asked: string[];
  readonly questions: string[];
  readonly installs: InstallPlan[];
}

function harness(overrides: {
  argv: readonly string[];
  manifest?: Manifest;
  declared?: string;
  serve?: Readonly<Record<string, Uint8Array>>;
  interactive?: boolean;
  consent?: boolean;
  ci?: boolean;
  noDownload?: boolean;
  /** Makes the package manager refuse, the way a failed `pnpm add` does. */
  installFails?: boolean;
  workspace?: Readonly<Record<string, string>>;
}): Harness {
  const root = projectAt({
    ...(overrides.manifest === undefined ? {} : { manifest: overrides.manifest }),
    ...(overrides.declared === undefined ? {} : { declared: overrides.declared }),
    ...(overrides.workspace === undefined ? {} : { workspace: overrides.workspace }),
  });
  const home = scratch("penv-upgrade-home-");
  const out: string[] = [];
  const asked: string[] = [];
  const questions: string[] = [];
  const installs: InstallPlan[] = [];

  const io: LauncherIo = {
    out: (line) => {
      out.push(line);
    },
    err: () => {},
    interactive: overrides.interactive ?? true,
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(overrides.consent ?? true);
    },
    ask: (question) => {
      questions.push(question);
      return Promise.resolve("");
    },
  };

  const serve = overrides.serve ?? REGISTRY;
  const fetcher: Fetcher = {
    get: (url) => {
      asked.push(url);
      const bytes = serve[url];
      return bytes === undefined
        ? Promise.reject(new Error("the registry answered 404 Not Found"))
        : Promise.resolve(bytes);
    },
  };

  const install: InstallRuntime = (plan) => {
    installs.push(plan);
    return overrides.installFails === true
      ? Promise.reject(new Error("pnpm exited 1"))
      : Promise.resolve();
  };

  return {
    root,
    home,
    out,
    asked,
    questions,
    installs,
    options: {
      argv: overrides.argv,
      root,
      manifestFile: join(root, ...MANIFEST_PATH.split("/")),
      manifest: JSON.parse(
        readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8"),
      ) as Manifest,
      home,
      io,
      fetcher,
      install,
      ...(overrides.ci === undefined ? {} : { ci: overrides.ci }),
      ...(overrides.noDownload === undefined ? {} : { noDownload: overrides.noDownload }),
    },
  };
}

function manifestIn(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8")) as Manifest;
}

function manifestTextIn(root: string): string {
  return readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8");
}

function packageTextIn(root: string): string {
  return readFileSync(join(root, "package.json"), "utf8");
}

describe("moving the pin", () => {
  it("takes `latest` when no version is named, with the registry's own integrity", async () => {
    const test = harness({ argv: [], consent: true });
    await upgrade(test.options);

    const engine = manifestIn(test.root).engine;
    expect(engine.version).toBe(LATEST);
    expect(engine.integrity).toBe(integrityFor(LATEST));
    // Never hashed here: what the manifest records is what the packument stated.
    expect(test.asked).toContain(PACKUMENT_URL);
  });

  it("installs the pinned engine into $PENV_HOME, verified", async () => {
    const test = harness({ argv: [], consent: true });
    await upgrade(test.options);

    const dir = packageDir(test.home, "engines", ENGINE, LATEST);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(test.asked).toContain(tarballUrlFor(LATEST));
    expect(test.out).toContain(`✓ ${ENGINE} ${LATEST} installed`);
  });

  it("honours an explicit version instead of `latest`", async () => {
    const test = harness({ argv: [OLDER], consent: true });
    await upgrade(test.options);

    expect(manifestIn(test.root).engine.version).toBe(OLDER);
    expect(test.installs[0]?.steps[0]?.command.join(" ")).toContain(`@penvhq/penv@${OLDER}`);
  });

  it("moves the dependency to the same exact version as the pin", async () => {
    const test = harness({ argv: [LATEST], consent: true });
    await upgrade(test.options);

    expect(test.installs).toHaveLength(1);
    expect(test.installs[0]?.steps[0]?.command).toEqual([
      "pnpm",
      "add",
      "--save-exact",
      `@penvhq/penv@${LATEST}`,
    ]);
    expect(test.out).toContain(`✓ package.json depends on @penvhq/penv ${LATEST}`);
  });

  it("downgrades, because a pin is a pin", async () => {
    const test = harness({ argv: [OLDER], consent: true });
    await upgrade(test.options);

    expect(manifestIn(test.root).engine).toEqual({
      package: ENGINE,
      version: OLDER,
      integrity: integrityFor(OLDER),
    });
    expect(test.installs[0]?.steps[0]?.command.join(" ")).toContain(`@penvhq/penv@${OLDER}`);
  });

  it("round-trips the manifest through the parser that validates it", async () => {
    const test = harness({ argv: [LATEST], consent: true });
    await upgrade(test.options);

    const text = manifestTextIn(test.root);
    expect(text).toBe(
      serializeManifest({
        format: 1,
        engine: { package: ENGINE, version: LATEST, integrity: integrityFor(LATEST) },
        extensions: {},
      }),
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says so and stops when both are already at the version asked for", async () => {
    const test = harness({
      argv: [LATEST],
      manifest: manifestFor(LATEST),
      declared: LATEST,
      consent: true,
    });
    const before = manifestTextIn(test.root);

    await upgrade(test.options);

    expect(test.out).toEqual([`✓ Already on ${ENGINE} ${LATEST} — nothing to move`]);
    expect(test.installs).toHaveLength(0);
    expect(test.questions).toEqual([]);
    expect(manifestTextIn(test.root)).toBe(before);
  });
});

describe("the one consent", () => {
  it("shows both file changes before either moves", async () => {
    const test = harness({ argv: [LATEST], consent: true });
    await upgrade(test.options);

    const shown = test.out.join("\n");
    expect(shown).toContain(`${ENGINE} ${PINNED} → ${LATEST}`);
    expect(shown).toContain(MANIFEST_PATH);
    expect(shown).toContain(`  +   "integrity": "${integrityFor(LATEST)}"`);
    expect(shown).toContain(`  +   "version": "${LATEST}"`);
    expect(shown).toContain(`  - "@penvhq/penv": "${PINNED}"`);
    expect(shown).toContain(`  + "@penvhq/penv": "${LATEST}"`);
    expect(shown).toContain(`Run with: pnpm add --save-exact @penvhq/penv@${LATEST}`);
    expect(test.questions).toEqual([`Move this project to ${LATEST}?`]);
  });

  it("leaves both files untouched when it is declined", async () => {
    const test = harness({ argv: [LATEST], consent: false });
    const manifestBefore = manifestTextIn(test.root);
    const packageBefore = packageTextIn(test.root);

    await expect(upgrade(test.options)).rejects.toThrow(
      `${ENGINE} ${LATEST} was not installed, so ${MANIFEST_PATH} and package.json are unchanged`,
    );

    expect(manifestTextIn(test.root)).toBe(manifestBefore);
    expect(packageTextIn(test.root)).toBe(packageBefore);
    expect(test.installs).toHaveLength(0);
    // Declined before the download, so nothing landed in the store either.
    expect(existsSync(packageDir(test.home, "engines", ENGINE, LATEST))).toBe(false);
  });

  it("keeps the pin where it was when the package manager refuses", async () => {
    const test = harness({ argv: [LATEST], consent: true, installFails: true });
    const before = manifestTextIn(test.root);

    await expect(upgrade(test.options)).rejects.toMatchObject({
      code: "PENV_UPGRADE_INSTALL_FAILED",
      summary: `pnpm did not finish moving this project to ${ENGINE} ${LATEST}, so ${MANIFEST_PATH} still pins the engine it pinned before`,
      // Finding 20: never the command that just failed — that is the one
      // instruction already known not to work.
      remedy: expect.not.stringContaining("pnpm add"),
    });
    expect(manifestTextIn(test.root)).toBe(before);
  });

  it("asks nothing when `--yes` answered in advance", async () => {
    const test = harness({ argv: [LATEST, "--yes"], consent: false });
    await upgrade(test.options);

    expect(test.questions).toEqual([]);
    expect(manifestIn(test.root).engine.version).toBe(LATEST);
  });
});

/**
 * Finding 21: `upgrade` moved the root `package.json` and nothing else, so a
 * workspace package declaring `@penvhq/penv` at `^0.8.0` ran the 0.8 bridge
 * under a 0.11 pin through three releases without being mentioned once.
 */
describe("a workspace whose packages declare the dependency too", () => {
  function packageTextAt(root: string, name: string): string {
    return readFileSync(join(root, "packages", name, "package.json"), "utf8");
  }

  it("moves every one of them, and names each in the one diff", async () => {
    const test = harness({
      argv: [LATEST],
      consent: true,
      workspace: { db: "^0.8.0", worker: "^0.9.0" },
    });

    await upgrade(test.options);

    const shown = test.out.join("\n");
    expect(shown).toContain("packages/db/package.json");
    expect(shown).toContain('  - "@penvhq/penv": "^0.8.0"');
    expect(shown).toContain("packages/worker/package.json");
    expect(shown).toContain('  - "@penvhq/penv": "^0.9.0"');
    // One question covers all three files, and `-w` is what pnpm needs at the root.
    expect(test.questions).toEqual([`Move this project to ${LATEST}?`]);
    expect(test.installs[0]?.steps.map((step) => step.command.join(" "))).toEqual([
      `pnpm add -w --save-exact @penvhq/penv@${LATEST}`,
      `pnpm --filter ./packages/db add --save-exact @penvhq/penv@${LATEST}`,
      `pnpm --filter ./packages/worker add --save-exact @penvhq/penv@${LATEST}`,
    ]);
    expect(test.out).toContain(`✓ packages/db/package.json depends on @penvhq/penv ${LATEST}`);
  });

  it("leaves every file untouched when the one question is declined", async () => {
    const test = harness({ argv: [LATEST], consent: false, workspace: { db: "^0.8.0" } });
    const manifestBefore = manifestTextIn(test.root);
    const rootBefore = packageTextIn(test.root);
    const dbBefore = packageTextAt(test.root, "db");

    await expect(upgrade(test.options)).rejects.toThrow("was not installed");

    expect(manifestTextIn(test.root)).toBe(manifestBefore);
    expect(packageTextIn(test.root)).toBe(rootBefore);
    expect(packageTextAt(test.root, "db")).toBe(dbBefore);
    expect(test.installs).toHaveLength(0);
  });

  /** The quiet half: a workspace package that never declared penv is not given it. */
  it("says nothing about a package that declares no @penvhq/penv", async () => {
    const test = harness({ argv: [LATEST], consent: true, workspace: { db: "^0.8.0" } });
    mkdirSync(join(test.root, "packages", "ui"), { recursive: true });
    writeFileSync(
      join(test.root, "packages", "ui", "package.json"),
      `${JSON.stringify({ name: "@acme/ui", dependencies: { react: "19" } })}\n`,
    );

    await upgrade(test.options);

    expect(test.out.join("\n")).not.toContain("packages/ui");
    expect(test.installs[0]?.steps).toHaveLength(2);
  });
});

describe("what it refuses", () => {
  it("refuses a version the registry does not publish", async () => {
    const test = harness({ argv: ["9.9.9"], consent: true });

    await expect(upgrade(test.options)).rejects.toThrow(
      `${PACKUMENT_URL} publishes no 9.9.9 of ${ENGINE}`,
    );
    expect(manifestIn(test.root).engine.version).toBe(PINNED);
    expect(test.installs).toHaveLength(0);
  });

  it("names `penv upgrade`, not `penv add`, when the registry cannot be read", async () => {
    const test = harness({ argv: [], serve: {}, consent: true });

    const failure = await upgrade(test.options).catch((error: unknown) => error);
    expect(String(failure)).toContain("Run `penv upgrade` again when the registry is reachable");
  });

  it("refuses an unattended run with no version", async () => {
    const test = harness({ argv: ["--yes"], interactive: false });

    await expect(upgrade(test.options)).rejects.toThrow(
      `Upgrading rewrites ${MANIFEST_PATH} and package.json, and this run has nobody to decide that`,
    );
    // Refused before the first request: nothing was read and nothing was written.
    expect(test.asked).toEqual([]);
  });

  it("refuses an unattended run with a version but no `--yes`", async () => {
    const test = harness({ argv: [LATEST], ci: true });

    await expect(upgrade(test.options)).rejects.toThrow("nobody to decide that");
    expect(test.asked).toEqual([]);
  });

  it("upgrades unattended when the version and `--yes` are both there", async () => {
    const test = harness({ argv: [LATEST, "--yes"], ci: true, interactive: false });
    await upgrade(test.options);

    expect(manifestIn(test.root).engine.version).toBe(LATEST);
    expect(test.questions).toEqual([]);
  });

  it("refuses when `--no-download` says this run has no network", async () => {
    const test = harness({ argv: [LATEST], noDownload: true });

    await expect(upgrade(test.options)).rejects.toThrow("`--no-download` says this run does not");
    expect(test.asked).toEqual([]);
  });

  it("refuses two versions, and a flag it does not have", async () => {
    await expect(upgrade(harness({ argv: [LATEST, OLDER] }).options)).rejects.toThrow(
      "`penv upgrade` takes one version, or none",
    );
    await expect(upgrade(harness({ argv: ["--force"] }).options)).rejects.toThrow(
      "`penv upgrade` does not understand `--force`",
    );
  });
});

describe("extensions", () => {
  const VAULT = "@penvhq/provider-vault";

  function withVault(version: string): Manifest {
    return baseManifest({ [VAULT]: { version, integrity: integrityFor(PINNED) } });
  }

  it("leaves their pins alone and says so", async () => {
    const test = harness({ argv: [LATEST], manifest: withVault("0.4.1"), consent: true });
    await upgrade(test.options);

    expect(manifestIn(test.root).extensions[VAULT]?.version).toBe("0.4.1");
    expect(test.out).toContain(
      `→ ${VAULT} keeps its own pin — \`penv add <package>@<version>\` moves one.`,
    );
  });

  it("stays quiet when every pinned extension is already at that version", async () => {
    const test = harness({ argv: [LATEST], manifest: withVault(LATEST), consent: true });
    await upgrade(test.options);

    expect(test.out.some((line) => line.startsWith("→"))).toBe(false);
    expect(manifestIn(test.root).extensions[VAULT]?.version).toBe(LATEST);
  });
});
