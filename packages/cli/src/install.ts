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
 * Two commands write that dependency line: `penv init`, which is the engine's,
 * and `penv upgrade`, which is the launcher's. This module is published at
 * `@penvhq/cli/install` so the launcher reaches it without loading the command
 * surface — one answer to "which package manager, which diff, which spawn",
 * rather than a second copy on the other side of the launcher/engine split.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PenvError } from "@penvhq/core";
import { startChild } from "./child.js";

/** The package an adopted project depends on. The CLI engine is not one of its dependencies. */
export const RUNTIME_PACKAGE = "@penvhq/penv";

/** The peer `penv.schema.ts` imports, which the project supplies because a peer is not hoisted. */
export const SCHEMA_PACKAGE = "zod";

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

/** One package the adopted project needs, and what its `package.json` says today. */
export interface InstallPackage {
  readonly name: string;
  readonly version: string;
  /** What `package.json` already says about it, when it says anything. */
  readonly declared?: string;
  /** True when this project already has it — nothing to install for this one. */
  readonly satisfied: boolean;
}

export interface InstallPlan {
  readonly root: string;
  readonly manager: PackageManager;
  /** Everything an adopted project needs, in the order the diff shows them. */
  readonly packages: readonly InstallPackage[];
  /** The command, argv-shaped — what runs, and what a refusal tells the user to run. */
  readonly command: readonly string[];
  /** The lockfile the manager will rewrite, when the project has one. */
  readonly lockfile?: string;
  /** True when every package is already there — nothing to install. */
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

/** What `package.json` says about one package today, from either dependency block. */
function declaredVersion(root: string, name: string): string | undefined {
  const manifest = manifestOf(root);
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block: unknown = manifest?.[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      const version: unknown = (block as Record<string, unknown>)[name];
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

  const runtimeDeclared = declaredVersion(root, RUNTIME_PACKAGE);
  const zodDeclared = declaredVersion(root, SCHEMA_PACKAGE);
  const packages: InstallPackage[] = [
    {
      name: RUNTIME_PACKAGE,
      version,
      ...(runtimeDeclared === undefined ? {} : { declared: runtimeDeclared }),
      satisfied: runtimeDeclared === version,
    },
    {
      name: SCHEMA_PACKAGE,
      version: schemaPackageVersion(),
      ...(zodDeclared === undefined ? {} : { declared: zodDeclared }),
      // Any declared zod counts: which zod a project uses is the project's
      // decision, and penv is here to make sure there is one, not to move it.
      satisfied: zodDeclared !== undefined,
    },
  ];

  const pending = packages.filter((entry) => !entry.satisfied);
  const specs = (pending.length === 0 ? packages : pending).map(
    (entry) => `${entry.name}@${entry.version}`,
  );
  return {
    root,
    manager,
    packages,
    command: [...ADD[manager], ...specs],
    ...(lockfile === undefined ? {} : { lockfile }),
    satisfied: pending.length === 0,
  };
}

function describe(entry: InstallPackage): string {
  return `${entry.name} ${entry.version}`;
}

/**
 * The change, as it will appear in the diff — the whole point of showing it is
 * that the reader recognises their own file, so these are the `package.json`
 * lines that land and the lockfile that gets rewritten, not a summary of both.
 */
export function renderInstallPlan(plan: InstallPlan): string[] {
  if (plan.satisfied) {
    return [
      `package.json already has ${plan.packages.map(describe).join(" and ")} — nothing to install.`,
    ];
  }
  const pending = plan.packages.filter((entry) => !entry.satisfied);
  const added = pending.filter((entry) => entry.declared === undefined);
  const replaced = pending.filter((entry) => entry.declared !== undefined);
  return [
    "package.json",
    ...(added.length === 0
      ? []
      : [
          '  + "dependencies": {',
          ...added.map((entry) => `  +   "${entry.name}": "${entry.version}"`),
          "  + }",
        ]),
    ...replaced.flatMap((entry) => [
      `  - "${entry.name}": "${entry.declared}"`,
      `  + "${entry.name}": "${entry.version}"`,
    ]),
    ...(plan.lockfile === undefined
      ? []
      : [plan.lockfile, ...pending.map((entry) => `  + ${entry.name}@${entry.version}`)]),
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
    purpose: `install ${plan.packages.map(describe).join(" and ")}`,
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
