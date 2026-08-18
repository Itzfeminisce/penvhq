/**
 * The release seam ISSUE-11 designed and left unbuilt.
 *
 * `packages/launcher/src/pins.ts` carries a development placeholder, so a
 * launcher built from this repository refuses to write a manifest after `penv
 * init` — which is correct, and which means a published launcher has to carry
 * something else. This script is the something else, in two verbs:
 *
 *   embed  — before publishing: build and pack `@penvhq/cli`, take the npm SSRI
 *            of that tarball, and rewrite the pin's `version` and `integrity`.
 *   verify — after publishing: ask the registry what it stored for that version
 *            and fail the release if it is not the same bytes.
 *
 * `embed` runs in CI only. The committed pin stays the placeholder, because the
 * refusal it triggers is a tested behavior of the launcher.
 *
 * Run with `node --experimental-strip-types scripts/engine-pin.ts <verb>`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enginePackageDir = join(repoRoot, "packages", "cli");
const pinsFile = join(repoRoot, "packages", "launcher", "src", "pins.ts");

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
}

function manifestOf(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
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
  const source = readFileSync(pinsFile, "utf8");
  const pin: EnginePin = { version: engine.version, integrity: integrityOf(packEngine()) };
  writeFileSync(pinsFile, embedPin(source, pin), "utf8");
  console.log(`✓ ${engine.name} ${pin.version} pinned in packages/launcher/src/pins.ts`);
  console.log(`  ${pin.integrity}`);
}

const REGISTRY = "https://registry.npmjs.org";
/** npm's read replicas trail a publish by seconds. This is that wait, and no more. */
const ATTEMPTS = 12;
const PAUSE_MS = 5_000;

async function publishedIntegrity(name: string, version: string): Promise<string | undefined> {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}/${version}`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const manifest = (await response.json()) as { dist?: { integrity?: string } };
      return manifest.dist?.integrity;
    }
    if (response.status !== 404) {
      throw new Error(`${url} answered ${response.status}`);
    }
    await new Promise((settle) => setTimeout(settle, PAUSE_MS));
  }
  return undefined;
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
        "with the embed step running before `pnpm release`.",
    );
  }
  if (pin.version !== engine.version) {
    refuse(
      `the pin names ${engine.name} ${pin.version}, but this tree builds ${engine.version}`,
      "Run the embed step again against the version being published.",
    );
  }

  const published = await publishedIntegrity(engine.name, pin.version);
  if (published === undefined) {
    refuse(
      `${engine.name} ${pin.version} is not on ${REGISTRY}`,
      "The launcher pins bytes nobody can install. Publish the engine, then re-run this check.",
    );
  }
  if (published !== pin.integrity) {
    refuse(
      `${engine.name} ${pin.version} on npm is not the tarball the launcher pinned`,
      `The registry holds ${published}; the launcher pins ${pin.integrity}. Every install of that ` +
        "pin will fail its integrity check — publish a patch with a pin taken from the registry.",
    );
  }
  console.log(`✓ ${engine.name} ${pin.version} on npm matches the launcher's pin`);
}

const VERBS: Record<string, () => void | Promise<void>> = { embed, verify };

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
