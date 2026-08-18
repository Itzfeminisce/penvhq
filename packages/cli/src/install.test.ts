/**
 * The one runtime dependency, and the change shown before it is installed.
 *
 * Nothing here spawns a package manager: what init has to get right is the plan
 * it shows, which manager it would use, and that a project already carrying the
 * exact pin is left alone. The spawn itself is `startChild`, which `penv run`'s
 * tests already exercise against real children.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectPackageManager, engineVersion, planInstall, renderInstallPlan } from "./install.js";

const created: string[] = [];

function makeProject(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "penv-install-"));
  created.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents, "utf8");
  }
  return root;
}

function manifest(body: unknown): Record<string, string> {
  return { "package.json": JSON.stringify(body) };
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the package manager", () => {
  it("is the one whose lockfile the project already has", () => {
    expect(detectPackageManager(makeProject({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(detectPackageManager(makeProject({ "yarn.lock": "" }))).toBe("yarn");
    expect(detectPackageManager(makeProject({ "bun.lock": "" }))).toBe("bun");
    expect(detectPackageManager(makeProject({ "package-lock.json": "{}" }))).toBe("npm");
  });

  /** Corepack's field is the project's own answer when no lockfile is committed. */
  it("falls back to the declared packageManager, then to npm", () => {
    expect(detectPackageManager(makeProject(manifest({ packageManager: "pnpm@9.1.0" })))).toBe(
      "pnpm",
    );
    expect(detectPackageManager(makeProject(manifest({ name: "app" })))).toBe("npm");
    expect(detectPackageManager(makeProject())).toBe("npm");
  });
});

describe("the install plan", () => {
  it("pins the exact version, with the manager's own exact flag", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    const plan = planInstall(root, "1.2.3");

    expect(plan.command).toEqual(["pnpm", "add", "--save-exact", "@penvhq/penv@1.2.3"]);
    expect(plan.lockfile).toBe("pnpm-lock.yaml");
    expect(plan.satisfied).toBe(false);
  });

  it("names no lockfile the project does not have", () => {
    expect(planInstall(makeProject(manifest({ name: "app" })), "1.2.3").lockfile).toBeUndefined();
  });

  it("has nothing to do when package.json already pins the exact version", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "1.2.3" } }));

    expect(planInstall(root, "1.2.3")).toMatchObject({ satisfied: true, declared: "1.2.3" });
  });

  /** A range is not the exact version PRD §3 asks for, so it is a change to show. */
  it("treats a range as a version to replace", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "^1.0.0" } }));

    expect(planInstall(root, "1.2.3")).toMatchObject({ satisfied: false, declared: "^1.0.0" });
  });
});

describe("the change penv shows before installing", () => {
  it("is the package.json line and the lockfile, then the command", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    const shown = renderInstallPlan(planInstall(root, "1.2.3")).join("\n");

    expect(shown).toContain("package.json");
    expect(shown).toContain('"@penvhq/penv": "1.2.3"');
    expect(shown).toContain("pnpm-lock.yaml");
    expect(shown).toContain("Run with: pnpm add --save-exact @penvhq/penv@1.2.3");
  });

  it("shows the replacement when a version is already declared", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "^1.0.0" } }));

    const shown = renderInstallPlan(planInstall(root, "1.2.3")).join("\n");

    expect(shown).toContain('- "@penvhq/penv": "^1.0.0"');
    expect(shown).toContain('+ "@penvhq/penv": "1.2.3"');
  });

  it("says there is nothing to install rather than showing an empty diff", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "1.2.3" } }));

    expect(renderInstallPlan(planInstall(root, "1.2.3")).join("\n")).toContain(
      "already pins @penvhq/penv 1.2.3",
    );
  });
});

/**
 * PRD §3: the runtime dependency is the engine's version exactly. Reading it
 * from the manifest is what keeps the two from drifting on the day a release
 * bumps one of them.
 */
describe("the version penv pins", () => {
  it("is the engine's own, read from its manifest", () => {
    const own: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );

    expect(engineVersion()).toBe((own as { version: string }).version);
  });
});
