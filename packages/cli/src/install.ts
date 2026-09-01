/**
 * The runtime dependencies an adopted project takes, and how they get there.
 *
 * PRD §3: an adopted project depends on `@penvhq/penv` at the engine's own
 * version — the typed `@env` surface, not a CLI distribution. It also depends on
 * zod, because the `penv.schema.ts` init scaffolds imports it: zod is a *peer* of
 * `@penvhq/penv`, and a peer is a package the project supplies. Under pnpm's
 * strict layout nothing hoists it to the project root, so an install that named
 * only `@penvhq/penv` left the very schema init had just written unable to
 * resolve `zod` — and adoption could never finish.
 *
 * Both are installed with the package manager the project already uses, and only
 * after showing the exact `package.json` and lockfile change: an install is the
 * one step of adoption that reaches outside the repository, so it is the one step
 * that is shown before it happens rather than reported after.
 *
 * The install itself is a seam. It shells out to a package manager, which the
 * tests must never do — and a fake here is not a weaker test, because what init
 * has to get right is the plan, the consent, and the refusal when the install
 * does not happen.
 *
 * A plan is a list of steps, because in a workspace "the project's dependency"
 * is plural. pnpm refuses a bare `add` at a workspace root (`-w` is how you say
 * you meant the root), and a workspace package that declares `@penvhq/penv`
 * itself is a second copy of the very version the manifest pins — one repository
 * ran the 0.8 bridge under a 0.11 pin for three releases because nothing looked
 * below the root, and the same repository then held two `@penvhq/core`s five
 * minor versions apart because the scan looked for only one name. So every
 * `package.json` that declares either moves, under one consent, and the commands
 * shown are the ones that run.
 *
 * Two commands write that dependency line: `penv init`, which is the engine's,
 * and `penv upgrade`, which is the launcher's. This module is published at
 * `@penvhq/cli/install` so the launcher reaches it without loading the command
 * surface — one answer to "which package manager, which diff, which spawn",
 * rather than a second copy on the other side of the launcher/engine split.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PenvError } from "@penvhq/core";
import { startChild } from "./child.js";

/** The package an adopted project depends on. The CLI engine is not one of its dependencies. */
export const RUNTIME_PACKAGE = "@penvhq/penv";

/** The peer `penv.schema.ts` imports, which the project supplies because a peer is not hoisted. */
export const SCHEMA_PACKAGE = "zod";

/**
 * The module every committed provider declaration augments, which the project
 * declares for the same reason it declares zod: nothing hoists it.
 *
 * `penv add` commits a `declare module "@penvhq/core"` block, and TypeScript
 * resolves that specifier from the project's own files. Under pnpm's strict
 * layout a transitive dependency is not at the project root, so the specifier
 * resolves to nothing — and an augmentation whose module cannot be found is not
 * an error, it silently degrades to an *ambient* declaration. The map
 * `defineConfig` reads stays empty, a misspelled provider field compiles clean,
 * and no diagnostic anywhere says so. A hoisting package manager hides this; the
 * project declaring it is what makes the declaration bind under all of them.
 *
 * `devDependencies`, because that is the whole of what it is: a type-only
 * augmentation target. No application code imports it, and `@penvhq/penv`
 * carries its own copy of the runtime — so the PRD's one runtime dependency is
 * still one.
 */
export const TYPES_PACKAGE = "@penvhq/core";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** The lockfile that names each manager, checked in this order. */
const LOCKFILES: readonly (readonly [PackageManager, string])[] = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
];

/** How each manager is told to add a package. */
const ADD: Readonly<Record<PackageManager, readonly [string, string]>> = {
  pnpm: ["pnpm", "add"],
  npm: ["npm", "install"],
  yarn: ["yarn", "add"],
  bun: ["bun", "add"],
};

/** How each manager is told to write the version down exactly, with no range. */
const EXACT: Readonly<Record<PackageManager, string>> = {
  pnpm: "--save-exact",
  npm: "--save-exact",
  yarn: "--exact",
  bun: "--exact",
};

/** How each manager is told to keep the dependency in the block it is already in. */
const DEV: Readonly<Record<PackageManager, string>> = {
  pnpm: "-D",
  npm: "--save-dev",
  yarn: "--dev",
  bun: "--dev",
};

/** pnpm refuses an install at a workspace root without this — `ERR_PNPM_ADDING_TO_ROOT`. */
const WORKSPACE_ROOT_FLAG = "-w";

/** pnpm's workspace file, which is both what declares the members and what makes the root refuse. */
const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** One package the adopted project needs, and what its `package.json` says today. */
export interface InstallPackage {
  readonly name: string;
  readonly version: string;
  /** What `package.json` already says about it, when it says anything. */
  readonly declared?: string;
  /** True when this project already has it — nothing to install for this one. */
  readonly satisfied: boolean;
}

/** One `package.json` the install rewrites, and the command that rewrites it. */
export interface InstallStep {
  /** The file the diff names — `package.json`, or a workspace package's path to it. */
  readonly manifest: string;
  /** Everything this file needs, in the order the diff shows them. */
  readonly packages: readonly InstallPackage[];
  /** The command, argv-shaped — run from the project root, whichever file it writes. */
  readonly command: readonly string[];
  /** The block this step writes into, which is what the diff shows. */
  readonly dev: boolean;
  /**
   * True when that block is already in the file. The diff then shows it as the
   * context it is, without a `+`: claiming to create a `devDependencies` beside
   * fourteen entries is the one line in an otherwise literal diff that a reader
   * would go and check by hand.
   */
  readonly blockPresent: boolean;
  /** True when this file already declares every one of them. */
  readonly satisfied: boolean;
}

export interface InstallPlan {
  readonly root: string;
  readonly manager: PackageManager;
  /**
   * The root's `package.json` — one step per block it writes, since one command
   * names one — then one per workspace package that declares the runtime package
   * or the types package itself.
   */
  readonly steps: readonly InstallStep[];
  /** The lockfile the manager will rewrite, when the project has one. */
  readonly lockfile?: string;
  /** True when every step is already satisfied — nothing to install. */
  readonly satisfied: boolean;
}

/** Runs an install plan, or throws. Replaced in tests; never spawns there. */
export type InstallRuntime = (plan: InstallPlan) => Promise<void>;

/**
 * The engine's own version, read from its manifest rather than restated in the
 * source: `@penvhq/penv` must match the engine exactly, and a constant beside
 * the version a release bumps is a second answer waiting to drift.
 */
export function engineVersion(): string {
  const version = ownManifest()?.version;
  if (typeof version === "string" && version.length > 0) {
    return version;
  }
  throw new PenvError(
    "ENGINE_VERSION_UNREADABLE",
    "penv could not read its own version, so it cannot say which `@penvhq/penv` this project needs",
    `Reinstall penv, then run \`penv init\` again.`,
  );
}

/**
 * The zod an adopted project installs: the floor of the peer range the engine
 * and `@penvhq/penv` both declare, which is the version penv is built and tested
 * against.
 *
 * The floor rather than the range, because the diff shown before the install has
 * to be the line that actually lands — `--save-exact` on `^4.4.3` would write
 * whatever the registry resolved that day, which is not something a reader can
 * consent to in advance.
 */
export function schemaPackageVersion(): string {
  const peers = ownManifest()?.peerDependencies;
  const declared =
    peers !== null && typeof peers === "object" && !Array.isArray(peers)
      ? (peers as Record<string, unknown>)[SCHEMA_PACKAGE]
      : undefined;
  const floor = typeof declared === "string" ? declared.replace(/^[\^~>=\s]+/, "").trim() : "";
  if (floor.length > 0) {
    return floor;
  }
  throw new PenvError(
    "ENGINE_PEER_UNREADABLE",
    `penv could not read its own \`${SCHEMA_PACKAGE}\` peer range, so it cannot say which ${SCHEMA_PACKAGE} this project needs`,
    `Reinstall penv, then run \`penv init\` again.`,
  );
}

/** The engine's own manifest, or `undefined` when it cannot be read. */
function ownManifest(): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // The callers refuse: a version penv guessed would pin a project's
    // dependency to something nobody chose.
    return undefined;
  }
}

/** The package manager this project already uses: its lockfile, then what it declares, then npm. */
export function detectPackageManager(root: string): PackageManager {
  for (const [manager, lockfile] of LOCKFILES) {
    if (existsSync(join(root, lockfile))) {
      return manager;
    }
  }
  return declaredManager(root) ?? "npm";
}

/** `"packageManager": "pnpm@9.1.0"` — corepack's field, and a project's own answer. */
function declaredManager(root: string): PackageManager | undefined {
  const declared = manifestOf(root)?.packageManager;
  if (typeof declared !== "string") {
    return undefined;
  }
  const name = declared.split("@")[0];
  return name === "pnpm" || name === "npm" || name === "yarn" || name === "bun" ? name : undefined;
}

function manifestOf(root: string): Record<string, unknown> | undefined {
  const file = join(root, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What one `package.json` says about a package today, and which block says it. */
interface Declaration {
  readonly version: string;
  /** True when it sits in `devDependencies` — where an install has to leave it. */
  readonly dev: boolean;
}

function declaredIn(dir: string, name: string): Declaration | undefined {
  const manifest = manifestOf(dir);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block: unknown = manifest?.[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const version: unknown = (block as Record<string, unknown>)[name];
      if (typeof version === "string") {
        return { version, dev: field === "devDependencies" };
      }
    }
  }
  return undefined;
}

/** True when `package.json` already has the block a step writes into. */
function blockPresentIn(dir: string, dev: boolean): boolean {
  const block: unknown = manifestOf(dir)?.[dev ? "devDependencies" : "dependencies"];
  return block !== null && typeof block === "object" && !Array.isArray(block);
}

/** True when `root` is the root of a pnpm workspace, which is what `-w` is for. */
export function isPnpmWorkspaceRoot(root: string): boolean {
  return existsSync(join(root, PNPM_WORKSPACE)) && existsSync(join(root, "package.json"));
}

/** The `packages:` list from `pnpm-workspace.yaml`, block or flow form. */
function workspaceGlobs(root: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, PNPM_WORKSPACE), "utf8");
  } catch {
    return [];
  }
  const unquote = (raw: string): string => raw.replace(/^['"]|['"]$/g, "").trim();
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const flow = /^packages:\s*\[(.*)\]\s*$/.exec(line);
    if (flow?.[1] !== undefined) {
      return flow[1]
        .split(",")
        .map(unquote)
        .filter((glob) => glob !== "");
    }
    if (/^packages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item?.[1] !== undefined) {
      globs.push(unquote(item[1]));
      continue;
    }
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) {
      break;
    }
  }
  return globs;
}

function directoriesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `packages/*` and `apps/**` against the filesystem, one path segment at a time. */
function expandGlob(root: string, glob: string): string[] {
  let dirs = [root];
  for (const segment of glob.split("/").filter((part) => part !== "" && part !== ".")) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (segment === "**") {
        const stack = [dir];
        while (stack.length > 0) {
          const current = stack.pop() as string;
          next.push(current);
          stack.push(...directoriesIn(current));
        }
        continue;
      }
      if (segment.includes("*")) {
        const pattern = new RegExp(
          `^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
        );
        next.push(
          ...directoriesIn(dir).filter((child) => pattern.test(child.slice(dir.length + 1))),
        );
        continue;
      }
      const candidate = join(dir, segment);
      if (isDirectory(candidate)) {
        next.push(candidate);
      }
    }
    dirs = next;
  }
  return dirs;
}

/**
 * Every workspace package that declares `name` itself, root excluded — asked
 * once for `@penvhq/penv` and once for `@penvhq/core`, since a member holding
 * its own copy of either is a second version running under one pin.
 *
 * Only the ones that already declare it: penv moves a dependency a package
 * chose, and adding one to a package that never asked for it is a different
 * decision than the one being consented to.
 */
function workspaceMembers(root: string, name: string): string[] {
  if (!isPnpmWorkspaceRoot(root)) {
    return [];
  }
  const globs = workspaceGlobs(root);
  const excluded = globs
    .filter((glob) => glob.startsWith("!"))
    .flatMap((glob) => expandGlob(root, glob.slice(1)));
  const found = new Set<string>();
  for (const glob of globs.filter((entry) => !entry.startsWith("!"))) {
    for (const dir of expandGlob(root, glob)) {
      if (dir !== root && !excluded.includes(dir) && declaredIn(dir, name) !== undefined) {
        found.add(dir);
      }
    }
  }
  return [...found].sort();
}

/** The path a diff shows for one of them, in the spelling every penv path uses. */
function manifestPathOf(root: string, dir: string): string {
  const within = relative(root, dir)
    .split(sep)
    .filter((part) => part !== "");
  return [...within, "package.json"].join("/");
}

function addCommand(
  manager: PackageManager,
  options: { readonly filter?: string; readonly workspaceRoot: boolean; readonly dev: boolean },
  specs: readonly string[],
): string[] {
  const [bin, verb] = ADD[manager];
  return [
    bin,
    ...(options.filter === undefined ? [] : ["--filter", options.filter]),
    verb,
    ...(options.workspaceRoot ? [WORKSPACE_ROOT_FLAG] : []),
    EXACT[manager],
    ...(options.dev ? [DEV[manager]] : []),
    ...specs,
  ];
}

function stepFor(
  manager: PackageManager,
  manifest: string,
  packages: readonly InstallPackage[],
  options: {
    readonly filter?: string;
    readonly workspaceRoot: boolean;
    readonly dev: boolean;
    readonly dir: string;
  },
): InstallStep {
  const pending = packages.filter((entry) => !entry.satisfied);
  const specs = (pending.length === 0 ? packages : pending).map(
    (entry) => `${entry.name}@${entry.version}`,
  );
  return {
    manifest,
    packages,
    command: addCommand(manager, options, specs),
    dev: options.dev,
    blockPresent: blockPresentIn(options.dir, options.dev),
    satisfied: pending.length === 0,
  };
}

export function planInstall(root: string, version: string = engineVersion()): InstallPlan {
  const manager = detectPackageManager(root);
  const lockfile = LOCKFILES.find(
    ([name, file]) => name === manager && existsSync(join(root, file)),
  )?.[1];
  const workspaceRoot = manager === "pnpm" && isPnpmWorkspaceRoot(root);

  const runtime = declaredIn(root, RUNTIME_PACKAGE);
  const zod = declaredIn(root, SCHEMA_PACKAGE);
  const types = declaredIn(root, TYPES_PACKAGE);
  const packages: InstallPackage[] = [
    {
      name: RUNTIME_PACKAGE,
      version,
      ...(runtime === undefined ? {} : { declared: runtime.version }),
      satisfied: runtime?.version === version,
    },
    {
      name: SCHEMA_PACKAGE,
      version: schemaPackageVersion(),
      ...(zod === undefined ? {} : { declared: zod.version }),
      // Any declared zod counts: which zod a project uses is the project's
      // decision, and penv is here to make sure there is one, not to move it.
      satisfied: zod !== undefined,
    },
  ];
  const typesPackage: InstallPackage = {
    name: TYPES_PACKAGE,
    version,
    ...(types === undefined ? {} : { declared: types.version }),
    // Held to the pin, exactly as a workspace member's copy is. The augmentation
    // binds on the module resolving, but what it binds to is whatever release
    // resolved: a core behind the pin checks `penv.config.ts` against a shape the
    // engine no longer has, and the committed declarations augment interfaces
    // that moved under them.
    satisfied: types?.version === version,
  };

  // The block a package chose is the block penv writes back to — but only when
  // every package this step installs lives there, since one command names one.
  // Which is also why the types package is its own step: it belongs in
  // `devDependencies` whatever the other two chose.
  const pending = packages.filter((entry) => !entry.satisfied);
  const steps: InstallStep[] = [
    stepFor(manager, "package.json", packages, {
      workspaceRoot,
      dir: root,
      dev:
        runtime?.dev === true &&
        pending.every((entry) => entry.name === RUNTIME_PACKAGE) &&
        pending.length > 0,
    }),
    stepFor(manager, "package.json", [typesPackage], { workspaceRoot, dir: root, dev: true }),
  ];
  // Both packages, because a member declaring either holds its own copy of it:
  // `@penvhq/penv` is a second bridge running under the pin, and `@penvhq/core`
  // is a second copy of the interfaces every committed declaration augments.
  for (const name of [RUNTIME_PACKAGE, TYPES_PACKAGE]) {
    for (const dir of workspaceMembers(root, name)) {
      const declared = declaredIn(dir, name) as Declaration;
      steps.push(
        stepFor(
          manager,
          manifestPathOf(root, dir),
          [
            {
              name,
              version,
              declared: declared.version,
              satisfied: declared.version === version,
            },
          ],
          {
            filter: `./${relative(root, dir).split(sep).join("/")}`,
            workspaceRoot: false,
            dir,
            dev: declared.dev,
          },
        ),
      );
    }
  }

  return {
    root,
    manager,
    steps,
    ...(lockfile === undefined ? {} : { lockfile }),
    satisfied: steps.every((step) => step.satisfied),
  };
}

function describe(entry: InstallPackage): string {
  return `${entry.name} ${entry.version}`;
}

/** What this plan actually installs, once per package however many files declare it. */
export function installedPackages(plan: InstallPlan): readonly InstallPackage[] {
  const pending = plan.steps.flatMap((step) => step.packages).filter((entry) => !entry.satisfied);
  return [...new Map(pending.map((entry) => [entry.name, entry])).values()];
}

/** One file the plan wrote, and what landed in it. */
export interface InstalledManifest {
  readonly manifest: string;
  /** `@penvhq/penv 1.2.3 and @penvhq/core 1.2.3` — every package this file gained. */
  readonly packages: string;
}

/**
 * What the install landed, one entry per `package.json`.
 *
 * Per file rather than per step, because the root is two steps and a file is
 * what the reader recognises — and every package in it, because a caller
 * confirming only the one it happened to name leaves the release's own new
 * dependency unmentioned in the lines that say the upgrade worked.
 */
export function installedByManifest(plan: InstallPlan): readonly InstalledManifest[] {
  const byManifest = new Map<string, InstallPackage[]>();
  for (const step of plan.steps.filter((entry) => !entry.satisfied)) {
    const landed = byManifest.get(step.manifest) ?? [];
    landed.push(...step.packages.filter((entry) => !entry.satisfied));
    byManifest.set(step.manifest, landed);
  }
  return [...byManifest].map(([manifest, packages]) => ({
    manifest,
    packages: series(
      [...new Map(packages.map((entry) => [entry.name, entry])).values()].map(describe),
    ),
  }));
}

/** Every package the plan names, once each — the root's blocks are two steps now. */
function plannedPackages(plan: InstallPlan): readonly InstallPackage[] {
  const all = plan.steps.flatMap((step) => step.packages);
  return [...new Map(all.map((entry) => [entry.name, entry])).values()];
}

/** `a`, `a and b`, `a, b and c`. */
function series(values: readonly string[]): string {
  return values.length < 2
    ? (values[0] ?? "")
    : `${values.slice(0, -1).join(", ")} and ${values.at(-1) as string}`;
}

/** The lines one `package.json` contributes to the diff. */
function renderStep(step: InstallStep): string[] {
  const pending = step.packages.filter((entry) => !entry.satisfied);
  const added = pending.filter((entry) => entry.declared === undefined);
  const replaced = pending.filter((entry) => entry.declared !== undefined);
  const block = step.dev ? "devDependencies" : "dependencies";
  // The block's own lines are an insertion only when the block is not there yet.
  const edge = step.blockPresent ? "   " : "  +";
  return [
    step.manifest,
    ...(added.length === 0
      ? []
      : [
          `${edge} "${block}": {`,
          ...added.map((entry) => `  +   "${entry.name}": "${entry.version}"`),
          `${edge} }`,
        ]),
    ...replaced.flatMap((entry) => [
      `  - "${entry.name}": "${entry.declared}"`,
      `  + "${entry.name}": "${entry.version}"`,
    ]),
  ];
}

/**
 * The change, as it will appear in the diff — the whole point of showing it is
 * that the reader recognises their own file, so these are the `package.json`
 * lines that land and the lockfile that gets rewritten, not a summary of both.
 *
 * In a workspace that is more than one file, and the commands underneath are the
 * ones that run: a "Run with:" line the reader cannot paste is worse than none.
 */
export function renderInstallPlan(plan: InstallPlan): string[] {
  if (plan.satisfied) {
    return [
      `package.json already has ${series(plannedPackages(plan).map(describe))} — nothing to install.`,
    ];
  }
  const pending = plan.steps.filter((step) => !step.satisfied);
  const [first, ...rest] = pending.map((step) => step.command.join(" "));
  const landing = installedPackages(plan).map((entry) => `  + ${entry.name}@${entry.version}`);
  return [
    ...pending.flatMap(renderStep),
    ...(plan.lockfile === undefined ? [] : [plan.lockfile, ...landing]),
    "",
    `Run with: ${first ?? ""}`,
    ...rest.map((command) => `     then ${command}`),
  ];
}

/**
 * The real install: the project's own package manager, started the way any other
 * child is (`.cmd` shims on Windows included), with its output the user's to see.
 *
 * Every step runs from the project root — `-w` and `--filter` are how a workspace
 * says which `package.json` it means, so the directory never changes.
 */
export const installWithPackageManager: InstallRuntime = async (plan) => {
  for (const step of plan.steps) {
    if (step.satisfied) {
      continue;
    }
    const child = startChild({
      command: step.command,
      env: process.env as Record<string, string>,
      cwd: plan.root,
      purpose: `install ${step.packages.map(describe).join(" and ")} in ${step.manifest}`,
    });
    const ended = await child.ended;
    if (ended.exitCode !== 0 || ended.signal !== null) {
      throw installFailed(plan, step);
    }
  }
};

/**
 * What to do about a package manager that refused.
 *
 * Never the command that just failed: the one remediation guaranteed not to work
 * is the one the reader already ran. The manager said why, on their screen, and
 * nothing was migrated — so the answer is that line and a second `penv init`.
 */
export function installFailed(plan: InstallPlan, step: InstallStep): PenvError {
  return new PenvError(
    "INIT_INSTALL_FAILED",
    `${step.command.join(" ")} did not finish, so penv migrated nothing`,
    `Read what ${plan.manager} printed above — it names what it refused. Fix that and run this ` +
      "command again; your dotenv files are exactly where they were.",
  );
}
