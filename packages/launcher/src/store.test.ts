/**
 * Three states and one install path.
 *
 * The state a directory is in decides whether penv runs, refuses, or downloads,
 * so the marker that records which bytes are installed is tested as carefully as
 * the download itself — including the two ways it can say "not the pinned
 * bytes": absent, and present but different.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadFailedError, DownloadIntegrityError } from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import { INTEGRITY_FILE, packageDir } from "./home.js";
import { integrityOf } from "./integrity.js";
import { inspectInstall, installPin, type Pin, tarballUrl } from "./store.js";
import { enginePackage, packTar } from "./tarball.fixtures.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-store-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TARBALL = packTar(enginePackage("@penvhq/cli", "0.9.0"));

const PIN: Pin = {
  name: "@penvhq/cli",
  version: "0.9.0",
  integrity: integrityOf(TARBALL),
};

/** A registry that serves exactly one tarball, and records what was asked for. */
function fetcherOf(bytes: Uint8Array | Error, asked: string[] = []): Fetcher {
  return {
    get(url) {
      asked.push(url);
      return bytes instanceof Error ? Promise.reject(bytes) : Promise.resolve(bytes);
    },
  };
}

describe("tarballUrl", () => {
  it("is npm's address for the exact version", () => {
    expect(tarballUrl(PIN)).toBe("https://registry.npmjs.org/@penvhq/cli/-/cli-0.9.0.tgz");
    expect(tarballUrl({ ...PIN, name: "penv-thing" })).toBe(
      "https://registry.npmjs.org/penv-thing/-/penv-thing-0.9.0.tgz",
    );
  });

  it("uses the registry the manifest records, when it records one", () => {
    expect(tarballUrl({ ...PIN, registry: "https://npm.acme.internal/" })).toBe(
      "https://npm.acme.internal/@penvhq/cli/-/cli-0.9.0.tgz",
    );
  });
});

describe("inspectInstall", () => {
  it("reads absent, installed, and not-the-pinned-bytes", async () => {
    const home = scratch();
    expect(inspectInstall(home, "engines", PIN).state).toBe("absent");

    await installPin({ home, kind: "engines", pin: PIN, fetcher: fetcherOf(TARBALL) });
    expect(inspectInstall(home, "engines", PIN).state).toBe("installed");

    expect(
      inspectInstall(home, "engines", { ...PIN, integrity: integrityOf(new Uint8Array(1)) }).state,
    ).toBe("corrupt");

    rmSync(join(packageDir(home, "engines", PIN.name, PIN.version), INTEGRITY_FILE));
    expect(inspectInstall(home, "engines", PIN).state).toBe("corrupt");
  });
});

describe("installPin", () => {
  it("downloads, verifies, and lays the package down whole", async () => {
    const home = scratch();
    const asked: string[] = [];

    const dir = await installPin({
      home,
      kind: "engines",
      pin: PIN,
      fetcher: fetcherOf(TARBALL, asked),
    });

    expect(asked).toEqual([tarballUrl(PIN)]);
    expect(dir).toBe(packageDir(home, "engines", PIN.name, PIN.version));
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toMatchObject({
      name: "@penvhq/cli",
      version: "0.9.0",
    });
    expect(existsSync(join(dir, "bin.js"))).toBe(true);
    expect(readFileSync(join(dir, INTEGRITY_FILE), "utf8").trim()).toBe(PIN.integrity);
  });

  it("installs nothing when the bytes are not the pinned bytes", async () => {
    const home = scratch();
    const pin: Pin = { ...PIN, integrity: integrityOf(new Uint8Array([1, 2, 3])) };

    await expect(
      installPin({ home, kind: "engines", pin, fetcher: fetcherOf(TARBALL) }),
    ).rejects.toBeInstanceOf(DownloadIntegrityError);

    const parent = join(home, "engines", "@penvhq", "cli");
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
  });

  it("names the registry and the one command to run again when the download fails", async () => {
    const home = scratch();
    const fetcher = fetcherOf(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));

    const failure = installPin({ home, kind: "engines", pin: PIN, fetcher });

    await expect(failure).rejects.toBeInstanceOf(DownloadFailedError);
    await expect(failure).rejects.toThrow(/registry\.npmjs\.org/);
    expect(existsSync(packageDir(home, "engines", PIN.name, PIN.version))).toBe(false);
  });

  it("leaves no staging directory behind", async () => {
    const home = scratch();
    mkdirSync(join(home, "engines", "@penvhq", "cli"), { recursive: true });

    await installPin({ home, kind: "engines", pin: PIN, fetcher: fetcherOf(TARBALL) });

    expect(readdirSync(join(home, "engines", "@penvhq", "cli"))).toEqual(["0.9.0"]);
  });
});
