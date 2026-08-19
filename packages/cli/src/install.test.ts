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
 *
 * `@penvhq/core` is in every plan for the same reason at the type level: the
 * declaration `penv add` commits augments that module by name, and pnpm does not
 * hoist a transitive one either — which fails silently, since an augmentation
 * whose module cannot be found is an ambient declaration, not an error.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  engineVersion,
  installFailed,
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
    mkdirSync(dirname(join(root, name)), { recursive: true });
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

    expect(plan.steps[0]?.command).toEqual([
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

    expect(plan.steps[0]?.packages).toContainEqual({ name: "zod", version: ZOD, satisfied: false });
  });

  /**
   * Finding 28: `penv add` commits a `declare module "@penvhq/core"` block, and
   * under pnpm's strict layout a transitive `@penvhq/core` is not at the project
   * root — so the specifier resolves to nothing, the augmentation degrades to an
   * ambient declaration without a diagnostic, and a misspelled provider field
   * compiles clean. Declaring it is what makes it bind.
   */
  it("names @penvhq/core, because the declaration penv commits augments it", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    const plan = planInstall(root, "1.2.3");
    const step = plan.steps[1] as NonNullable<(typeof plan.steps)[1]>;

    expect(step.manifest).toBe("package.json");
    expect(step.packages).toEqual([{ name: "@penvhq/core", version: "1.2.3", satisfied: false }]);
    // Its own command, in `devDependencies`: it is the declare-module target and
    // nothing else, and one command names one block.
    expect(step.command).toEqual(["pnpm", "add", "--save-exact", "-D", "@penvhq/core@1.2.3"]);
    expect(step.dev).toBe(true);
  });

  /** The quiet half: a project that already declares it is left exactly as it is. */
  it("leaves an already-declared @penvhq/core where the project put it", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/core": "^0.11.0" } }));

    const plan = planInstall(root, "1.2.3");

    expect(plan.steps[1]?.satisfied).toBe(true);
    expect(renderInstallPlan(plan).join("\n")).not.toContain("@penvhq/core");
  });

  it("names no lockfile the project does not have", () => {
    expect(planInstall(makeProject(manifest({ name: "app" })), "1.2.3").lockfile).toBeUndefined();
  });

  it("has nothing to do when package.json already has all three", () => {
    const root = makeProject(
      manifest({
        dependencies: { "@penvhq/penv": "1.2.3", zod: "^4.4.3" },
        devDependencies: { "@penvhq/core": "1.2.3" },
      }),
    );

    const plan = planInstall(root, "1.2.3");

    expect(plan.satisfied).toBe(true);
    expect(plan.steps[0]?.packages).toContainEqual({
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

    expect(plan.steps[0]?.command).toEqual([
      "npm",
      "install",
      "--save-exact",
      "@penvhq/penv@1.2.3",
    ]);
    expect(plan.steps[0]?.packages).toContainEqual({
      name: "zod",
      version: ZOD,
      declared: "^4.9.0",
      satisfied: true,
    });
  });

  /** A range is not the exact version PRD §3 asks for, so it is a change to show. */
  it("treats a range as a version to replace", () => {
    const root = makeProject(manifest({ dependencies: { "@penvhq/penv": "^1.0.0" } }));

    expect(planInstall(root, "1.2.3").steps[0]?.packages).toContainEqual({
      name: "@penvhq/penv",
      version: "1.2.3",
      declared: "^1.0.0",
      satisfied: false,
    });
  });

  /** The block a project chose is the block penv writes back to. */
  it("keeps a dev-declared dependency in devDependencies", () => {
    const root = makeProject({
      ...manifest({ devDependencies: { "@penvhq/penv": "^1.0.0", zod: "4.4.3" } }),
      "pnpm-lock.yaml": "",
    });

    expect(planInstall(root, "1.2.3").steps[0]?.command).toEqual([
      "pnpm",
      "add",
      "--save-exact",
      "-D",
      "@penvhq/penv@1.2.3",
    ]);
  });
});

/**
 * Finding 20: pnpm refuses a bare `add` at a workspace root
 * (`ERR_PNPM_ADDING_TO_ROOT`), and penv printed that exact command twice — once
 * to run and once as the remedy after it failed.
 */
describe("a pnpm workspace root", () => {
  function workspaceProject(files: Readonly<Record<string, string>> = {}): string {
    return makeProject({
      ...manifest({ name: "acme", packageManager: "pnpm@11.3.0" }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      ...files,
    });
  }

  it("adds `-w`, because pnpm refuses the root without it", () => {
    const plan = planInstall(workspaceProject(), "1.2.3");

    expect(plan.steps[0]?.command).toEqual([
      "pnpm",
      "add",
      "-w",
      "--save-exact",
      "@penvhq/penv@1.2.3",
      `zod@${ZOD}`,
    ]);
    expect(renderInstallPlan(plan).join("\n")).toContain(
      `Run with: pnpm add -w --save-exact @penvhq/penv@1.2.3 zod@${ZOD}`,
    );
  });

  /** The quiet half: a plain project's command is exactly what it always was. */
  it("leaves a project with no workspace file alone", () => {
    const root = makeProject({ ...manifest({ name: "app" }), "pnpm-lock.yaml": "" });

    expect(planInstall(root, "1.2.3").steps[0]?.command).not.toContain("-w");
  });

  /** And a workspace whose manager is not pnpm has no root flag to add. */
  it("stays quiet for a workspace file beside another manager's lockfile", () => {
    const root = makeProject({
      ...manifest({ name: "acme" }),
      "package-lock.json": "{}",
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    });

    expect(planInstall(root, "1.2.3").steps[0]?.command).not.toContain("-w");
  });
});

/**
 * Finding 21: `packages/db` declared `@penvhq/penv` at `^0.8.0` under a 0.11
 * manifest, so every migration ran the 0.8 bridge. In a workspace "the project's
 * dependency" is plural, and every one of them is in the one diff.
 */
describe("a workspace package that declares the dependency itself", () => {
  function monorepo(members: Readonly<Record<string, unknown>>): string {
    return makeProject({
      ...manifest({ name: "acme", dependencies: { "@penvhq/penv": "^1.0.0", zod: "4.4.3" } }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      ...Object.fromEntries(
        Object.entries(members).map(([dir, body]) => [
          `packages/${dir}/package.json`,
          JSON.stringify(body),
        ]),
      ),
    });
  }

  it("moves it too, in a step of its own", () => {
    const plan = planInstall(
      monorepo({ db: { name: "@acme/db", dependencies: { "@penvhq/penv": "^0.8.0" } } }),
      "1.2.3",
    );

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[2]?.manifest).toBe("packages/db/package.json");
    expect(plan.steps[2]?.command).toEqual([
      "pnpm",
      "--filter",
      "./packages/db",
      "add",
      "--save-exact",
      "@penvhq/penv@1.2.3",
    ]);
  });

  it("names it in the diff, and shows the command that writes it", () => {
    const shown = renderInstallPlan(
      planInstall(
        monorepo({ db: { name: "@acme/db", devDependencies: { "@penvhq/penv": "^0.8.0" } } }),
        "1.2.3",
      ),
    ).join("\n");

    expect(shown).toContain("packages/db/package.json");
    expect(shown).toContain('- "@penvhq/penv": "^0.8.0"');
    expect(shown).toContain("     then pnpm --filter ./packages/db add --save-exact -D");
  });

  /** The quiet half: a workspace package that never asked for penv is not given it. */
  it("leaves a member that declares no @penvhq/penv untouched", () => {
    const plan = planInstall(
      monorepo({ ui: { name: "@acme/ui", dependencies: { react: "19" } } }),
      "1.2.3",
    );

    expect(plan.steps).toHaveLength(2);
    expect(renderInstallPlan(plan).join("\n")).not.toContain("packages/ui");
  });

  /** Nothing to move below the root is nothing to say about it. */
  it("is satisfied when every package.json already declares the version", () => {
    const plan = planInstall(
      monorepo({ db: { name: "@acme/db", dependencies: { "@penvhq/penv": "1.2.3" } } }),
      "1.2.3",
    );

    expect(plan.steps.map((step) => step.satisfied)).toEqual([false, false, true]);
    expect(renderInstallPlan(plan).join("\n")).not.toContain("packages/db");
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
    // The second block is its own line, because it is its own command.
    expect(shown).toContain('  + "devDependencies": {');
    expect(shown).toContain("     then pnpm add --save-exact -D @penvhq/core@1.2.3");
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

  /**
   * Finding 20: the remedy was the command that had just failed, so running it
   * verbatim failed again. It names what the manager said instead.
   */
  it("never tells the reader to run the command that just failed", () => {
    const plan = planInstall(
      makeProject({ ...manifest({ name: "acme" }), "pnpm-lock.yaml": "" }),
      "1.2.3",
    );
    const step = plan.steps[0] as NonNullable<(typeof plan.steps)[0]>;

    const failure = installFailed(plan, step);

    expect(failure.summary).toContain(step.command.join(" "));
    expect(failure.remedy).not.toContain(step.command.join(" "));
    expect(failure.remedy).toContain("Read what pnpm printed above");
  });

  it("says there is nothing to install rather than showing an empty diff", () => {
    const root = makeProject(
      manifest({
        dependencies: { "@penvhq/penv": "1.2.3", zod: "4.4.3" },
        devDependencies: { "@penvhq/core": "1.2.3" },
      }),
    );

    expect(renderInstallPlan(planInstall(root, "1.2.3")).join("\n")).toContain(
      "already has @penvhq/penv 1.2.3, zod 4.4.3 and @penvhq/core 1.2.3",
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
