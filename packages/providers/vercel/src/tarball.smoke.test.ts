/**
 * A provider extension as `$PENV_HOME` actually receives it.
 *
 * `installPin` fetches one tarball, verifies it, unpacks it, and stops. Nothing
 * on that path installs a dependency — there is no `node_modules` beside a
 * pinned extension and never will be — so a provider whose entry imports
 * anything it did not bundle dies on its first line with `Cannot find package
 * '@penvhq/core'`, which is the failure every published provider had and which
 * no test aliasing `@penvhq/*` to source can see.
 *
 * So this packs the real tarball, extracts it with the launcher's own reader
 * into a directory with no `node_modules` above it, and imports the entry the
 * engine would import. It then makes the provider refuse — no `VERCEL_TOKEN` —
 * and asks core, from its own separate copy, whether the refusal that crossed
 * the bundle boundary is still recognisable as one. It is not `instanceof
 * PenvError` over there and never can be, which is why penv asks by shape.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "..", "..", "..");
const timeout = 300_000;

/** What the probe reports back about the provider it loaded, as JSON. */
interface Probe {
  readonly exports: readonly string[];
  readonly instanceofPenvError: boolean;
  readonly penvErrorLike: boolean;
  readonly name: string;
  readonly code: string;
  readonly summary: string;
  readonly remedy: string;
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
 * The probe: it imports the extracted entry and core's built copy — two separate
 * copies of the error classes, exactly as an engine and a pinned extension are —
 * and reports what the boundary did to the refusal.
 */
const PROBE = `import { pathToFileURL } from "node:url";

const [entry, core] = process.argv.slice(2);
const provider = await import(pathToFileURL(entry).href);
const { PenvError, isPenvErrorLike } = await import(pathToFileURL(core).href);

const built = provider.penvProviderFactory({
  root: process.cwd(),
  config: {
    environments: {
      production: { provider: "@penvhq/provider-vercel", project: "prj_smoke" },
    },
  },
  environment: "production",
  providerConfig: { provider: "@penvhq/provider-vercel", project: "prj_smoke" },
});

let thrown;
try {
  await built.verify();
} catch (error) {
  thrown = error;
}

console.log(
  JSON.stringify({
    exports: Object.keys(provider),
    instanceofPenvError: thrown instanceof PenvError,
    penvErrorLike: isPenvErrorLike(thrown),
    name: thrown?.name,
    code: thrown?.code,
    summary: thrown?.summary,
    remedy: thrown?.remedy,
  }),
);
`;

describe("the provider tarball penv installs into $PENV_HOME", () => {
  let workspace: string;
  let extracted: string;
  let entry: string;
  let probe: Probe;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "penv-provider-"));
    run("pnpm", ["build"], repoRoot);

    const packed = run("pnpm", ["pack", "--pack-destination", workspace], packageDir)
      .trim()
      .split(/\r?\n/)
      .at(-1);
    if (packed === undefined) {
      throw new Error("pnpm pack printed no tarball path");
    }

    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };

    // The launcher's own reader, and the layout `installPin` writes: the store
    // is under a temp directory, so nothing above it holds a `node_modules`.
    const { readTarball } = await import("../../../launcher/src/tar.js");
    extracted = join(workspace, "extensions", ...manifest.name.split("/"), manifest.version);
    for (const file of readTarball(readFileSync(packed), manifest)) {
      const target = join(extracted, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }

    // The engine's own answer for where a store package's entry is, so the file
    // this test imports is the file `penv push` would.
    const { packageEntry } = await import("../../../core/src/store.js");
    const resolved = packageEntry(extracted);
    if (resolved === undefined || !resolved.importable) {
      throw new Error(`the packed provider declares no importable entry: ${resolved?.file}`);
    }
    entry = resolved.file;

    const script = join(workspace, "probe.mjs");
    writeFileSync(script, PROBE, "utf8");

    // `NODE_PATH` is vitest's pointer at this workspace's pnpm store, which
    // would resolve `@penvhq/core` and zod for a bundle that shipped neither —
    // the exact failure this file exists to catch. `VERCEL_TOKEN` goes for the
    // opposite reason: the refusal is the point.
    const { NODE_PATH: _path, NODE_OPTIONS: _options, VERCEL_TOKEN: _token, ...env } = process.env;
    const core = join(repoRoot, "packages", "core", "dist", "index.js");
    const stdout = execFileSync(process.execPath, [script, entry, core], {
      cwd: workspace,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    probe = JSON.parse(stdout) as Probe;
  }, timeout);

  it("arrives with no node_modules, because nothing on this path would install one", () => {
    expect(existsSync(entry)).toBe(true);
    for (let dir = extracted, parent = dirname(extracted); ; parent = dirname(dir)) {
      expect(existsSync(join(dir, "node_modules"))).toBe(false);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  });

  /**
   * Finding 24: the package shipped no `penv.types`, so what `penv add`
   * committed was the open fallback and `target` went unchecked.
   */
  it("ships the declaration `penv.types` names, and add commits that rather than the fallback", async () => {
    const { readExtensionPackage, renderDeclaration } = await import(
      "../../../launcher/src/declaration.js"
    );
    const installed = readExtensionPackage(extracted);
    expect(installed.types).toBe("penv.d.ts");

    const written = renderDeclaration(
      { name: installed.name ?? "", version: installed.version ?? "", attested: false },
      {
        file: installed.types ?? "",
        source: readFileSync(join(extracted, installed.types ?? ""), "utf8"),
      },
    );
    expect(written).toContain('"production" | "preview" | "development"');
    expect(written).not.toContain("ProviderConfig &");
  });

  it("imports from the store and exports the factory the engine calls", () => {
    expect(probe.exports).toContain("penvProviderFactory");
  });

  /** Finding 25: the refusal that crossed the boundary is still a refusal. */
  it("throws a refusal core recognises by shape, though not by class", () => {
    expect(probe.instanceofPenvError).toBe(false);
    expect(probe.penvErrorLike).toBe(true);
    expect(probe.name).toBe("VercelUnavailableError");
    expect(probe.code).toBe("VERCEL_UNAVAILABLE");
    expect(probe.summary).toContain("VERCEL_TOKEN");
    expect(probe.remedy).toContain("VERCEL_TOKEN");
  });
});
