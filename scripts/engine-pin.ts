/**
 * The release seam ISSUE-11 designed and left unbuilt.
 *
 * `packages/launcher/src/pins.ts` carries a development placeholder, so a
 * launcher built from this repository refuses to write a manifest after `penv
 * init` — which is correct, and which means a published launcher has to carry
 * something else. This script is the something else, in three verbs:
 *
 *   publish-pinned — the release: everything but the launcher goes out through
 *                    changesets, the engine's integrity is read back from the
 *                    registry, and the launcher builds and publishes carrying it.
 *   embed          — the rewrite alone, from a locally packed tarball. Dev
 *                    tooling; its bytes are NOT what npm records (packers are
 *                    not reproducible), which is why the release reads back.
 *   verify         — after publishing: ask the registry what it stored and fail
 *                    the release loudly if it is not what the launcher pinned,
 *                    and warn as loudly when it stored no provenance.
 *
 * These run in CI only. The committed pin stays the placeholder, because the
 * refusal it triggers is a tested behavior of the launcher.
 *
 * Run with `node --experimental-strip-types scripts/engine-pin.ts <verb>`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enginePackageDir = join(repoRoot, "packages", "cli");
const pinsFile = join(repoRoot, "packages", "launcher", "src", "pins.ts");

/**
 * The source repository, spelled the way npm's provenance check compares it.
 *
 * The registry rejects a provenance bundle whose subject `repository.url` does
 * not match the workflow's repository, and the match is case-sensitive on the
 * owner — so this is the one place the URL is written, and every published
 * package is checked against it before a release goes out.
 */
export const REPOSITORY_URL = "git+https://github.com/Itzfeminisce/penvhq.git";

/**
 * The flag that makes a publish attach one.
 *
 * pnpm 11 publishes natively and no longer reads `npm_config_*`, so the release
 * workflow's `NPM_CONFIG_PROVENANCE` reached nobody and every `@penvhq/*` release
 * shipped unattested — while the trust model's official tier, the one `penv add`
 * skips every question for, rests on exactly that attestation. The workflow now
 * sets `PNPM_CONFIG_PROVENANCE` for the changesets path, which forwards no flags
 * of its own; this publish states it outright.
 */
export const PROVENANCE_FLAG = "--provenance";

/** The launcher's own publish, which changesets never sees. */
export const LAUNCHER_PUBLISH_ARGS: readonly string[] = [
  "--filter",
  "@penvhq/launcher",
  "publish",
  "--access",
  "public",
  PROVENANCE_FLAG,
  "--no-git-checks",
];

/** The engine's identity, as its own manifest states it. */
export interface EnginePin {
  readonly version: string;
  readonly integrity: string;
}

/** The npm SSRI of a tarball: the only name a manifest can pin bytes by. */
export function integrityOf(tarball: Uint8Array): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

/** What a real one looks like. A pin that is not this shape can never be verified. */
const SSRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

const PIN_BLOCK = /(BUNDLED_ENGINE_PIN: ManifestEngine = \{)([\s\S]*?)(\n\};)/;

function refuse(message: string, remedy: string): never {
  console.error(`✗ ${message}`);
  console.error(`  → ${remedy}`);
  process.exit(1);
}

function field(body: string, name: string): string {
  const match = new RegExp(`\\n\\s*${name}:\\s*([^\\n,]+),`).exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`pins.ts declares no \`${name}\` in BUNDLED_ENGINE_PIN`);
  }
  return match[1];
}

function setField(body: string, name: string, value: string): string {
  return body.replace(
    new RegExp(`(\\n\\s*${name}:\\s*)[^\\n,]+(,)`),
    `$1${JSON.stringify(value)}$2`,
  );
}

/** The placeholder values, read from the file rather than restated here. */
export function developmentPin(source: string): EnginePin {
  const version = /export const DEV_PIN_VERSION = "([^"]+)";/.exec(source)?.[1];
  const integrity = /export const DEV_PIN_INTEGRITY = "([^"]+)";/.exec(source)?.[1];
  if (version === undefined || integrity === undefined) {
    throw new Error("pins.ts declares no DEV_PIN_VERSION / DEV_PIN_INTEGRITY");
  }
  return { version, integrity };
}

/** The pin the file currently carries. Literals only — an identifier is the placeholder's shape. */
export function readPin(source: string): EnginePin {
  const block = PIN_BLOCK.exec(source);
  if (block?.[2] === undefined) {
    throw new Error("pins.ts declares no BUNDLED_ENGINE_PIN object");
  }
  const literal = (name: string): string => {
    const raw = field(block[2] as string, name);
    if (raw.startsWith('"')) {
      return JSON.parse(raw) as string;
    }
    // An identifier — the placeholder's shape. Resolve it to the constant it names.
    const constant = new RegExp(`export const ${raw} = "([^"]+)";`).exec(source)?.[1];
    if (constant === undefined) {
      throw new Error(
        `pins.ts gives \`${name}\` the value \`${raw}\`, which is not a local constant`,
      );
    }
    return constant;
  };
  return { version: literal("version"), integrity: literal("integrity") };
}

/**
 * The rewrite, as a pure function so it can be tested against a copy of the real
 * file. `package` is checked rather than written: the engine's name is a constant
 * both sides already share, and rewriting it would only let them disagree.
 *
 * Idempotent — a second run replaces the same two literals with the same values.
 */
export function embedPin(source: string, pin: EnginePin): string {
  const block = PIN_BLOCK.exec(source);
  if (block?.[2] === undefined) {
    throw new Error("pins.ts declares no BUNDLED_ENGINE_PIN object");
  }
  const declared = field(block[2], "package");
  if (declared !== "ENGINE_PACKAGE") {
    throw new Error(`BUNDLED_ENGINE_PIN.package is \`${declared}\`, not the shared ENGINE_PACKAGE`);
  }
  if (!SSRI.test(pin.integrity)) {
    throw new Error(`\`${pin.integrity}\` is not an npm sha512 integrity`);
  }
  const development = developmentPin(source);
  if (pin.version === development.version || pin.integrity === development.integrity) {
    throw new Error("the pin to embed is the development placeholder");
  }

  let body = setField(block[2], "version", pin.version);
  body = setField(body, "integrity", pin.integrity);
  return source.replace(PIN_BLOCK, `$1${body}$3`);
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly repository?: { readonly url?: string; readonly directory?: string } | string;
}

function manifestOf(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
}

/** Every package this repository publishes, as directories relative to its root. */
export function publishedPackageDirs(root: string = repoRoot): string[] {
  const found: string[] = [];
  const scan = (parent: string): void => {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${parent}/${entry.name}`;
      if (entry.name === "providers") {
        scan(dir);
        continue;
      }
      try {
        if (manifestOf(join(root, dir)).private !== true) {
          found.push(dir);
        }
      } catch {
        // Not a package. A directory under `packages/` without a manifest is
        // nothing npm will ever see.
      }
    }
  };
  scan("packages");
  return found.sort();
}

/**
 * What is wrong with one package's `repository`, or nothing.
 *
 * npm attaches no provenance to a package whose `repository.url` does not match
 * the repository the workflow ran in — the registry rejects the bundle outright
 * — and every `@penvhq/*` manifest shipped without the field at all.
 */
export function repositoryProblem(
  manifest: PackageManifest,
  directory: string,
): string | undefined {
  const declared = manifest.repository;
  if (declared === undefined || typeof declared === "string") {
    return `${manifest.name} declares no \`repository\` object, so npm will not attest it`;
  }
  if (declared.url !== REPOSITORY_URL) {
    return `${manifest.name} declares repository.url \`${String(declared.url)}\`, not \`${REPOSITORY_URL}\``;
  }
  if (declared.directory !== directory) {
    return `${manifest.name} declares repository.directory \`${String(declared.directory)}\`, not \`${directory}\``;
  }
  return undefined;
}

/** The same check over the whole repository, in the order a reader would read it. */
export function repositoryProblems(root: string = repoRoot): string[] {
  return publishedPackageDirs(root)
    .map((dir) => repositoryProblem(manifestOf(join(root, dir)), dir))
    .filter((problem): problem is string => problem !== undefined);
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
}

/** Builds and packs the engine, and answers with the bytes npm will receive. */
function packEngine(): Uint8Array {
  const staging = mkdtempSync(join(tmpdir(), "penv-engine-pin-"));
  try {
    run("pnpm", ["build"], repoRoot);
    const tarball = run("pnpm", ["pack", "--pack-destination", staging], enginePackageDir)
      .trim()
      .split(/\r?\n/)
      .at(-1);
    if (tarball === undefined) {
      throw new Error("pnpm pack printed no tarball path");
    }
    // pnpm prints the path relative to the package it packed.
    return readFileSync(resolve(enginePackageDir, tarball));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function embed(): void {
  const engine = manifestOf(enginePackageDir);
  const pin: EnginePin = { version: engine.version, integrity: integrityOf(packEngine()) };
  const source = readFileSync(pinsFile, "utf8");
  writeFileSync(pinsFile, embedPin(source, pin), "utf8");
  // Only the launcher rebuilds — its dist bundles the pin. The engine's dist must
  // stay the packed bytes, so publish must not build again after this step.
  run("pnpm", ["--filter", "@penvhq/launcher", "build"], repoRoot);
  console.log(`✓ ${engine.name} ${pin.version} pinned in packages/launcher/src/pins.ts`);
  console.log(`  ${pin.integrity}`);
}

const REGISTRY = "https://registry.npmjs.org";
/** npm's read replicas trail a publish by seconds. This is that wait, and no more. */
const ATTEMPTS = 12;
const PAUSE_MS = 5_000;

/** What npm recorded for one published version: the bytes, and whether it signed them. */
export interface PublishedDist {
  readonly integrity?: string;
  readonly attestations?: { readonly url?: string };
}

async function publishedDist(
  name: string,
  version: string,
  attempts = ATTEMPTS,
): Promise<PublishedDist | undefined> {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}/${version}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const manifest = (await response.json()) as { dist?: PublishedDist };
      return manifest.dist ?? {};
    }
    if (response.status !== 404) {
      throw new Error(`${url} answered ${response.status}`);
    }
    if (attempt < attempts) {
      await new Promise((settle) => setTimeout(settle, PAUSE_MS));
    }
  }
  return undefined;
}

async function publishedIntegrity(
  name: string,
  version: string,
  attempts = ATTEMPTS,
): Promise<string | undefined> {
  return (await publishedDist(name, version, attempts))?.integrity;
}

/**
 * The release that went out unattested, said out loud.
 *
 * A warning rather than a failure: the bytes are published and correct, and
 * failing the job after the fact fixes nothing. `dist.attestations` is the same
 * signal `penv add` reads and writes into every committed declaration, so this is
 * penv checking its own packages by the standard it holds every other one to.
 */
export function attestationWarning(name: string, version: string, dist: PublishedDist): string[] {
  if (dist.attestations?.url !== undefined) {
    return [];
  }
  return [
    `⚠ npm records no provenance attestation for ${name} ${version}`,
    "  → `penv add` calls `@penvhq/*` official and asks nothing, and an attestation is the only " +
      "evidence a scope name cannot fake. Check that the publish carried " +
      `\`${PROVENANCE_FLAG}\` — pnpm reads \`PNPM_CONFIG_PROVENANCE\`, never \`NPM_CONFIG_*\` — and ` +
      "that every package.json's `repository.url` matches this repository.",
  ];
}

/**
 * The publish that makes the pin true by construction. Tarball bytes are not
 * reproducible across packers or machines — pnpm pack, npm pack and the registry
 * each disagreed — so nothing predicted before publishing can be trusted. The
 * registry is the one authority, so the engine publishes first, the pin is read
 * back from what npm recorded, and only then does the launcher build and publish.
 */
async function publishPinned(): Promise<void> {
  const engine = manifestOf(enginePackageDir);
  const launcherDir = join(repoRoot, "packages", "launcher");
  const launcherManifestFile = join(launcherDir, "package.json");
  const launcherSource = readFileSync(launcherManifestFile, "utf8");
  const launcher = JSON.parse(launcherSource) as PackageManifest;

  if ((await publishedIntegrity(launcher.name, launcher.version, 1)) !== undefined) {
    console.log(`✓ ${launcher.name} ${launcher.version} is already on npm`);
    return;
  }

  // Before anything is published: the registry rejects a provenance bundle whose
  // repository does not match, and a release that quietly drops its attestation
  // is the one failure nothing downstream can tell apart from a fine one.
  const problems = repositoryProblems();
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    refuse(
      "these packages cannot be published with provenance",
      `Give every published package.json a \`repository\` naming ${REPOSITORY_URL} and its own ` +
        "directory, then run the release again.",
    );
  }

  run("pnpm", ["build"], repoRoot);

  // Everything but the launcher goes out through changesets, which skips a
  // private package — the launcher's turn comes once the registry can answer.
  const hidden = { ...(JSON.parse(launcherSource) as Record<string, unknown>), private: true };
  writeFileSync(launcherManifestFile, `${JSON.stringify(hidden, null, 2)}\n`);
  try {
    run("pnpm", ["exec", "changeset", "publish"], repoRoot);
  } finally {
    writeFileSync(launcherManifestFile, launcherSource);
  }

  const integrity = await publishedIntegrity(engine.name, engine.version);
  if (integrity === undefined) {
    refuse(
      `${engine.name} ${engine.version} did not appear on ${REGISTRY}`,
      "The launcher cannot pin what npm does not hold. Re-run the release once the engine is up.",
    );
  }

  const source = readFileSync(pinsFile, "utf8");
  writeFileSync(pinsFile, embedPin(source, { version: engine.version, integrity }), "utf8");
  run("pnpm", ["--filter", "@penvhq/launcher", "build"], repoRoot);
  run("pnpm", [...LAUNCHER_PUBLISH_ARGS], repoRoot);
  const tag = `${launcher.name}@${launcher.version}`;
  run("git", ["tag", tag], repoRoot);
  run("git", ["push", "origin", tag], repoRoot);
  console.log(`✓ ${launcher.name} ${launcher.version} published pinning ${integrity}`);
}

async function verify(): Promise<void> {
  const engine = manifestOf(enginePackageDir);
  const source = readFileSync(pinsFile, "utf8");
  const pin = readPin(source);
  const development = developmentPin(source);

  if (pin.version === development.version || pin.integrity === development.integrity) {
    refuse(
      "the launcher was published carrying the development engine pin",
      "Every project adopted by that launcher will refuse to write a manifest. Publish a patch " +
        "through `publish-pinned`, which takes the pin from the registry.",
    );
  }
  if (pin.version !== engine.version) {
    refuse(
      `the pin names ${engine.name} ${pin.version}, but this tree builds ${engine.version}`,
      "Run the embed step again against the version being published.",
    );
  }

  const dist = await publishedDist(engine.name, pin.version);
  if (dist?.integrity === undefined) {
    refuse(
      `${engine.name} ${pin.version} is not on ${REGISTRY}`,
      "The launcher pins bytes nobody can install. Publish the engine, then re-run this check.",
    );
  }
  if (dist.integrity !== pin.integrity) {
    refuse(
      `${engine.name} ${pin.version} on npm is not the tarball the launcher pinned`,
      `The registry holds ${dist.integrity}; the launcher pins ${pin.integrity}. Every install of ` +
        "that pin will fail its integrity check — publish a patch with a pin taken from the registry.",
    );
  }
  console.log(`✓ ${engine.name} ${pin.version} on npm matches the launcher's pin`);
  for (const line of attestationWarning(engine.name, pin.version, dist)) {
    console.error(line);
  }
}

const VERBS: Record<string, () => void | Promise<void>> = {
  embed,
  verify,
  "publish-pinned": publishPinned,
};

async function main(): Promise<void> {
  const verb = process.argv[2];
  const chosen = verb === undefined ? undefined : VERBS[verb];
  if (chosen === undefined) {
    refuse(
      `\`${String(verb)}\` is not something this script does`,
      `Run it as \`node --experimental-strip-types scripts/engine-pin.ts ${Object.keys(VERBS).join("|")}\`.`,
    );
  }
  await chosen();
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
