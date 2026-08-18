/**
 * The runtime dependencies an adopted project takes, and the change shown before
 * they are installed.
 *
 * Nothing here spawns a package manager: what init has to get right is the plan
 * it shows, which manager it would use, and that a project already carrying the
 * exact pin is left alone. The spawn itself is `startChild`, which `penv run`'s
 * tests already exercise against real children.
 *
 * zod is in every plan because the `penv.schema.ts` init scaffolds imports it.
 * It is a peer of `@penvhq/penv`, so pnpm does not hoist it to the project root,
 * and an install that named only `@penvhq/penv` left a freshly scaffolded
 * project unable to load the schema init had just written.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  engineVersion,
  planInstall,
  renderInstallPlan,
  schemaPackageVersion,
} from "./install.js";

const ZOD = schemaPackageVersion();

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

/** The engine's own manifest — where both versions penv pins come from. */
function own(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
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
  it("pins the exact versions, with the manager's own exact flag", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    const plan = planInstall(root, "1.2.3");

    expect(plan.command).toEqual([
      "pnpm",
      "add",
      "--save-exact",
      "@penvhq/penv@1.2.3",
      `zod@${ZOD}`,
    ]);
    expect(plan.lockfile).toBe("pnpm-lock.yaml");
    expect(plan.satisfied).toBe(false);
  });

  /**
   * The defect: without this line a clean project could never finish init, since
   * the schema it had just scaffolded could not resolve `zod`.
   */
  it("names zod, because the schema penv writes imports it", () => {
    const plan = planInstall(makeProject(manifest({ name: "app" })), "1.2.3");

    expect(plan.packages).toContainEqual({ name: "zod", version: ZOD, satisfied: false });
  });

  it("names no lockfile the project does not have", () => {
    expect(planInstall(makeProject(manifest({ name: "app" })), "1.2.3").lockfile).toBeUndefined();
  });

  it("has nothing to do when package.json already has both", () => {
    const root = makeProject(
      manifest({ dependencies: { "@penvhq/penv": "1.2.3", zod: "^4.4.3" } }),
    );

    const plan = planInstall(root, "1.2.3");

    expect(plan.satisfied).toBe(true);
    expect(plan.packages).toContainEqual({
      name: "@penvhq/penv",
      version: "1.2.3",
      declared: "1.2.3",
      satisfied: true,
    });
  });

  /** Which zod a project runs is the project's decision — penv only makes sure there is one. */
  it("leaves a zod the project already declared exactly where it is", () => {
    const root = makeProject(manifest({ dependencies: { zod: "^4.9.0" } }));

    const plan = planInstall(root, "1.2.3");

    expect(plan.command).toEqual(["npm", "install", "--save-exact", "@penvhq/penv@1.2.3"]);
    expect(plan.packages).toContainEqual({
      name: "zod",
      version: ZOD,
      declared: "^4.9.0",
      satisfied: true,
    });
  });

  /** A range is not the exact version PRD §3 asks for, so it is a change to show. */
  it("treats a range as a version to replace", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "^1.0.0" } }));

    expect(planInstall(root, "1.2.3").packages).toContainEqual({
      name: "@penvhq/penv",
      version: "1.2.3",
      declared: "^1.0.0",
      satisfied: false,
    });
  });
});

describe("the change penv shows before installing", () => {
  it("is every package.json line and the lockfile, then the command", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    const shown = renderInstallPlan(planInstall(root, "1.2.3")).join("\n");

    expect(shown).toContain("package.json");
    expect(shown).toContain('"@penvhq/penv": "1.2.3"');
    expect(shown).toContain(`"zod": "${ZOD}"`);
    expect(shown).toContain("pnpm-lock.yaml");
    expect(shown).toContain(`Run with: pnpm add --save-exact @penvhq/penv@1.2.3 zod@${ZOD}`);
  });

  it("shows the replacement when a version is already declared", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "^1.0.0" } }));

    const shown = renderInstallPlan(planInstall(root, "1.2.3")).join("\n");

    expect(shown).toContain('- "@penvhq/penv": "^1.0.0"');
    expect(shown).toContain('+ "@penvhq/penv": "1.2.3"');
  });

  /** The quiet case: a package the project already has is not in the change at all. */
  it("leaves an already-declared zod out of the change", () => {
    const root = makeProject(manifest({ dependencies: { zod: "^4.9.0" } }));

    const shown = renderInstallPlan(planInstall(root, "1.2.3")).join("\n");

    expect(shown).not.toContain('"zod"');
    expect(shown).toContain('"@penvhq/penv": "1.2.3"');
  });

  it("says there is nothing to install rather than showing an empty diff", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "1.2.3", zod: "4.4.3" } }));

    expect(renderInstallPlan(planInstall(root, "1.2.3")).join("\n")).toContain(
      "already has @penvhq/penv 1.2.3",
    );
  });
});

/**
 * PRD §3: the runtime dependency is the engine's version exactly. Reading it
 * from the manifest is what keeps the two from drifting on the day a release
 * bumps one of them.
 */
describe("the versions penv pins", () => {
  it("is the engine's own, read from its manifest", () => {
    expect(engineVersion()).toBe((own() as { version: string }).version);
  });

  /** The floor of the peer range, so the change shown is the line that lands. */
  it("takes zod from the engine's own peer range, without the range", () => {
    const range = (own() as { peerDependencies: Record<string, string> }).peerDependencies.zod;

    expect(range).toContain(schemaPackageVersion());
    expect(schemaPackageVersion()).not.toContain("^");
  });
});
