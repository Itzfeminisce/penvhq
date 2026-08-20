/**
 * `penv upgrade [version]` — the one command that moves the engine pin.
 *
 * It belongs to the launcher for the same reason `add` does: everything it
 * writes is the launcher's. An engine cannot compute the npm integrity of its
 * own tarball, and the pin is a promise about bytes, so the integrity comes from
 * the registry's `dist.integrity` and from nowhere else — never hashed here, and
 * never typed by a person. Before this command existed, moving the pin meant
 * hand-editing a version *and* an 88-character hash into the one file whose
 * whole purpose is that its bytes are verified, and a mistyped character came
 * back as a supply-chain check failing closed.
 *
 * The manifest's engine pin and the project's `@penvhq/penv` dependency move
 * together, at the same exact version. In a workspace that dependency is plural
 * — a package declaring its own `@penvhq/penv` is a second bridge running under
 * the pin, and one repository ran the 0.8 one under a 0.11 manifest for three
 * releases because `upgrade` looked only at the root. Every `package.json` that
 * declares it is in the one diff, and they move together or not at all: the
 * dependencies land first, so a package manager that refuses leaves a project
 * still pinning the engine it was already running.
 *
 * Extensions are not touched. Each carries its own pin and its own trust
 * decision, and re-pinning them because the engine moved would be penv choosing
 * bytes nobody reviewed; `penv add <package>@<version>` moves one.
 *
 * A downgrade is an upgrade backwards and takes the same path — a pin is a pin,
 * and a project that needs the engine it ran last week is not asking for
 * something penv should argue with.
 */

import { writeFileSync } from "node:fs";
import {
  type InstallPlan,
  type InstallRuntime,
  installedByManifest,
  installWithPackageManager,
  planInstall,
  renderInstallPlan,
} from "@penvhq/cli/install";
import { ENGINE_PACKAGE, MANIFEST_PATH, type Manifest, serializeManifest } from "@penvhq/core";
import {
  UPGRADE_COMMAND,
  UpgradeDeclinedError,
  UpgradeFlagError,
  UpgradeInstallFailedError,
  UpgradeNoDownloadError,
  UpgradeSubjectError,
  UpgradeUnattendedError,
  YES_FLAG,
} from "./errors.js";
import type { Fetcher } from "./fetcher.js";
import type { LauncherIo } from "./io.js";
import { fetchRelease, type Release } from "./registry.js";
import { installPin } from "./store.js";

export interface UpgradeOptions {
  /** The tokens after `upgrade`. */
  readonly argv: readonly string[];
  /** The project root — the directory holding `.penv/`. */
  readonly root: string;
  readonly manifestFile: string;
  /** The manifest as the launcher already parsed it. */
  readonly manifest: Manifest;
  readonly home: string;
  readonly io: LauncherIo;
  readonly fetcher: Fetcher;
  /** The launcher's `--no-download`: this run reaches no registry at all. */
  readonly noDownload?: boolean;
  /** True on a CI runner, which may have a terminal and still have nobody at it. */
  readonly ci?: boolean;
  /** Injected in tests: how the project's dependency is installed. Never spawns there. */
  readonly install?: InstallRuntime;
}

interface Request {
  /** Absent means whatever `latest` points at today. */
  readonly version: string | undefined;
  readonly yes: boolean;
}

function parseRequest(argv: readonly string[]): Request {
  let version: string | undefined;
  let yes = false;

  for (const token of argv) {
    if (token === YES_FLAG) {
      yes = true;
      continue;
    }
    if (token.startsWith("-")) {
      throw new UpgradeFlagError(token);
    }
    if (version !== undefined || token === "") {
      throw new UpgradeSubjectError();
    }
    version = token;
  }
  return { version, yes };
}

/**
 * The manifest lines that change, in the spelling the committed file uses.
 *
 * Keys are sorted there, so `integrity` precedes `version` here too: the point
 * of showing a diff is that the reader recognises their own file.
 */
function renderPinChange(engine: Manifest["engine"], release: Release): string[] {
  return [
    MANIFEST_PATH,
    `  -   "integrity": "${engine.integrity}"`,
    `  -   "version": "${engine.version}"`,
    `  +   "integrity": "${release.integrity}"`,
    `  +   "version": "${release.version}"`,
  ];
}

/** The extensions this upgrade deliberately left alone, when there are any. */
function pinnedElsewhere(manifest: Manifest, version: string): string[] {
  return Object.entries(manifest.extensions)
    .filter(([, entry]) => entry.version !== version)
    .map(([name]) => name);
}

/** One question, covering both files. `--yes` answers it in advance. */
async function consent(
  options: UpgradeOptions,
  release: Release,
  plan: InstallPlan,
  yes: boolean,
): Promise<void> {
  const { io, manifest } = options;
  io.out(`${ENGINE_PACKAGE} ${manifest.engine.version} → ${release.version}`);
  io.out("");
  for (const line of renderPinChange(manifest.engine, release)) {
    io.out(line);
  }
  for (const line of renderInstallPlan(plan)) {
    io.out(line);
  }
  if (yes) {
    return;
  }
  if (!(await io.confirm(`Move this project to ${release.version}?`))) {
    throw new UpgradeDeclinedError(release.version);
  }
}

export async function upgrade(options: UpgradeOptions): Promise<void> {
  const { io, fetcher, home, root, manifest, manifestFile } = options;
  const request = parseRequest(options.argv);

  // Both refusals come before the first request, so a run that cannot finish an
  // upgrade has not read the registry, written a file, or filled the store.
  if (options.noDownload === true) {
    throw new UpgradeNoDownloadError();
  }
  if ((options.ci === true || !io.interactive) && !(request.yes && request.version !== undefined)) {
    throw new UpgradeUnattendedError();
  }

  const release = await fetchRelease({
    name: ENGINE_PACKAGE,
    ...(request.version === undefined ? {} : { version: request.version }),
    retry: UPGRADE_COMMAND,
    fetcher,
  });

  const plan = planInstall(root, release.version);
  if (manifest.engine.version === release.version && plan.satisfied) {
    io.out(`✓ Already on ${ENGINE_PACKAGE} ${release.version} — nothing to move`);
    return;
  }

  // Serialized before anything is downloaded or installed: a manifest that would
  // not validate is a refusal, not a project half-moved.
  const manifestText = serializeManifest({
    ...manifest,
    engine: { package: ENGINE_PACKAGE, version: release.version, integrity: release.integrity },
  });

  await consent(options, release, plan, request.yes);

  await installPin({
    home,
    kind: "engines",
    pin: { name: ENGINE_PACKAGE, version: release.version, integrity: release.integrity },
    fetcher,
  });
  io.out(`✓ ${ENGINE_PACKAGE} ${release.version} installed`);

  if (!plan.satisfied) {
    try {
      await (options.install ?? installWithPackageManager)(plan);
    } catch {
      throw new UpgradeInstallFailedError(plan.manager, release.version);
    }
    // One line per file, naming every package that landed in it: a closing line
    // that confirms only the dependency penv has always moved says nothing about
    // the one this release introduced.
    for (const landed of installedByManifest(plan)) {
      io.out(`✓ ${landed.manifest} depends on ${landed.packages}`);
    }
  }

  writeFileSync(manifestFile, manifestText);
  io.out(`✓ ${MANIFEST_PATH} pins ${ENGINE_PACKAGE} ${release.version}`);

  const kept = pinnedElsewhere(manifest, release.version);
  if (kept.length > 0) {
    const subject = kept.length === 1 ? "keeps its own pin" : "keep their own pins";
    io.out(`→ ${kept.join(", ")} ${subject} — \`penv add <package>@<version>\` moves one.`);
  }
}
