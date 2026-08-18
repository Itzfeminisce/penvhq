/**
 * The one runtime dependency an adopted project takes, and how it gets there.
 *
 * PRD §3: an adopted project depends on exactly `@penvhq/penv` at the engine's
 * own version — the typed `@env` surface, not a CLI distribution. `penv init`
 * installs it with the package manager the project already uses, and only after
 * showing the exact `package.json` and lockfile change: an install is the one
 * step of adoption that reaches outside the repository, so it is the one step
 * that is shown before it happens rather than reported after.
 *
 * The install itself is a seam. It shells out to a package manager, which the
 * tests must never do — and a fake here is not a weaker test, because what init
 * has to get right is the plan, the consent, and the refusal when the install
 * does not happen.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PenvError } from "@penvhq/core";
import { startChild } from "./child.js";

/** The package an adopted project depends on. The CLI engine is not one of its dependencies. */
export const RUNTIME_PACKAGE = "@penvhq/penv";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** The lockfile that names each manager, checked in this order. */
const LOCKFILES: readonly (readonly [PackageManager, string])[] = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
];

/** How each manager is told to add one exact version. */
const ADD: Readonly<Record<PackageManager, readonly string[]>> = {
  pnpm: ["pnpm", "add", "--save-exact"],
  npm: ["npm", "install", "--save-exact"],
  yarn: ["yarn", "add", "--exact"],
  bun: ["bun", "add", "--exact"],
};

export interface InstallPlan {
  readonly root: string;
  readonly manager: PackageManager;
  readonly package: string;
  readonly version: string;
  /** The command, argv-shaped — what runs, and what a refusal tells the user to run. */
  readonly command: readonly string[];
  /** The lockfile the manager will rewrite, when the project has one. */
  readonly lockfile?: string;
  /** What `package.json` already says about the package, when it says anything. */
  readonly declared?: string;
  /** True when `package.json` already pins this exact version — nothing to install. */
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
  const manifest = new URL("../package.json", import.meta.url);
  try {
    const version: unknown = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (typeof version === "string" && version.length > 0) {
      return version;
    }
  } catch {
    // Falls through to the refusal below: a version penv guessed would pin the
    // project's one dependency to something nobody chose.
  }
  throw new PenvError(
    "ENGINE_VERSION_UNREADABLE",
    "penv could not read its own version, so it cannot say which `@penvhq/penv` this project needs",
    `Reinstall penv, then run \`penv init\` again.`,
  );
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

/** What `package.json` pins the runtime at today, from either dependency block. */
function declaredVersion(root: string): string | undefined {
  const manifest = manifestOf(root);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block: unknown = manifest?.[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const version: unknown = (block as Record<string, unknown>)[RUNTIME_PACKAGE];
      if (typeof version === "string") {
        return version;
      }
    }
  }
  return undefined;
}

export function planInstall(root: string, version: string = engineVersion()): InstallPlan {
  const manager = detectPackageManager(root);
  const lockfile = LOCKFILES.find(
    ([name, file]) => name === manager && existsSync(join(root, file)),
  )?.[1];
  const declared = declaredVersion(root);
  return {
    root,
    manager,
    package: RUNTIME_PACKAGE,
    version,
    command: [...ADD[manager], `${RUNTIME_PACKAGE}@${version}`],
    ...(lockfile === undefined ? {} : { lockfile }),
    ...(declared === undefined ? {} : { declared }),
    satisfied: declared === version,
  };
}

/**
 * The change, as it will appear in the diff — the whole point of showing it is
 * that the reader recognises their own file, so this is the `package.json` line
 * that lands and the lockfile that gets rewritten, not a summary of both.
 */
export function renderInstallPlan(plan: InstallPlan): string[] {
  if (plan.satisfied) {
    return [`package.json already pins ${plan.package} ${plan.version} — nothing to install.`];
  }
  const line = `"${plan.package}": "${plan.version}"`;
  return [
    "package.json",
    ...(plan.declared === undefined
      ? ['  + "dependencies": {', `  +   ${line}`, "  + }"]
      : [`  - "${plan.package}": "${plan.declared}"`, `  + ${line}`]),
    ...(plan.lockfile === undefined ? [] : [plan.lockfile, `  + ${plan.package}@${plan.version}`]),
    "",
    `Run with: ${plan.command.join(" ")}`,
  ];
}

/**
 * The real install: the project's own package manager, started the way any other
 * child is (`.cmd` shims on Windows included), with its output the user's to see.
 */
export const installWithPackageManager: InstallRuntime = async (plan) => {
  const child = startChild({
    command: plan.command,
    env: process.env as Record<string, string>,
    cwd: plan.root,
    purpose: `install ${plan.package} ${plan.version}`,
  });
  const ended = await child.ended;
  if (ended.exitCode !== 0 || ended.signal !== null) {
    throw installFailed(plan);
  }
};

export function installFailed(plan: InstallPlan): PenvError {
  return new PenvError(
    "INIT_INSTALL_FAILED",
    `${plan.command.join(" ")} did not finish, so penv migrated nothing`,
    `Run \`${plan.command.join(" ")}\` yourself, then start this command again. Your dotenv files are exactly where they were.`,
  );
}
