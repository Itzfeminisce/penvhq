/**
 * The engine as the launcher actually receives it.
 *
 * `installPin` downloads the npm tarball, extracts it into
 * `$PENV_HOME/engines/<name>/<version>/`, and spawns the `bin` its package.json
 * names. Nothing installs dependencies on that path — there is no
 * `node_modules` beside the engine and never will be — so an engine whose entry
 * imports anything it did not bundle dies on its first line, with a
 * `MODULE_NOT_FOUND` that no test aliasing `@penvhq/*` to source can see.
 *
 * So this packs the real tarball, extracts it with the launcher's own reader,
 * and runs the extracted bin. Slow, and it shells out, which is why it is
 * excluded from the default `vitest` run and gated behind `pnpm test:artifact`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "..", "..");
const timeout = 300_000;

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}

/**
 * The engine, run the way the launcher runs it: node, the extracted entry, argv,
 * and no shell.
 *
 * `NODE_PATH` is stripped because vitest sets it to this workspace's pnpm store,
 * which would resolve citty, jiti, zod and `@napi-rs/keyring` for a bundle that
 * shipped none of them — the exact failure this file exists to catch. A user's
 * environment has no such variable.
 */
function engine(entry: string, args: string[], cwd: string): Run {
  const { NODE_PATH: _path, NODE_OPTIONS: _options, ...env } = process.env;
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      status: failure.status ?? 1,
    };
  }
}

/** A project the engine can open: a config it evaluates through jiti, and a records tree. */
function project(parent: string, name: string, keys?: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, ".penv", "state", "records"), { recursive: true });
  writeFileSync(
    join(root, "penv.config.ts"),
    "export default {\n" +
      '  environments: ["production"],\n' +
      '  providers: { production: { type: "@penvhq/provider-filesystem" } },\n' +
      (keys === undefined ? "" : `  keys: { production: ${keys} },\n`) +
      "};\n",
    "utf8",
  );
  return root;
}

describe("the engine tarball the launcher installs", () => {
  let workspace: string;
  let extracted: string;
  let entry: string;
  let version: string;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "penv-engine-"));
    run("pnpm", ["build"], repoRoot);

    const packed = run("pnpm", ["pack", "--pack-destination", workspace], packageDir)
      .trim()
      .split(/\r?\n/)
      .at(-1);
    if (packed === undefined) {
      throw new Error("pnpm pack printed no tarball path");
    }

    const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    version = (manifest as { version: string }).version;

    // The launcher's own reader, imported after the build because it resolves
    // `@penvhq/core` through the built package rather than a vitest alias.
    const { readTarball } = await import("../../launcher/src/tar.js");
    extracted = join(workspace, "engine");
    for (const file of readTarball(readFileSync(packed), { name: "@penvhq/cli", version })) {
      const target = join(extracted, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }

    const packedManifest = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    const declared = packedManifest.bin["penv-engine"];
    if (declared === undefined) {
      throw new Error("the packed engine declares no penv-engine bin");
    }
    entry = join(extracted, declared);
  }, timeout);

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("arrives with no node_modules, because nothing on this path would install one", () => {
    expect(existsSync(join(extracted, "node_modules"))).toBe(false);
    expect(existsSync(entry)).toBe(true);
  });

  it("keeps the shebang, so the bin is a bin", () => {
    expect(readFileSync(entry, "utf8").slice(0, 20)).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
  });

  it("starts and says which engine it is", () => {
    const result = engine(entry, ["--version"], workspace);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  /** citty parsed it, core's zod schemas loaded, and jiti evaluated the TypeScript config. */
  it("opens a project, which means citty, zod and jiti all resolved", () => {
    const result = engine(entry, ["list", "--env", "production"], project(workspace, "adopted"));

    expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".penv/state/records/");
  });

  it("refuses outside a project the way it does everywhere else", () => {
    const empty = join(workspace, "empty");
    mkdirSync(empty, { recursive: true });
    const result = engine(entry, ["list"], empty);

    expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No penv.config.ts found");
  });

  /**
   * `@napi-rs/keyring` is native and cannot be bundled, so on this path it is
   * genuinely absent. Only a command that needs it may fail, and it fails saying
   * what is missing and what to do — not with a resolution stack.
   */
  it("names the missing keychain binding instead of crashing on it", () => {
    const root = project(workspace, "keychain", '{ source: "keychain", id: "prod" }');
    const result = engine(entry, ["key", "create", "--env", "production"], root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("penv could not load @napi-rs/keyring");
    expect(result.stderr).toContain("npm install -g @penvhq/launcher");
    expect(result.stderr).toContain('source: "env"');
  });

  it("mints an env-source key with no keychain anywhere in sight", () => {
    const root = project(workspace, "envkey", '{ source: "env", id: "prod" }');
    const result = engine(entry, ["key", "create", "--env", "production"], root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PENV_KEY_PROD=");
  });
});
