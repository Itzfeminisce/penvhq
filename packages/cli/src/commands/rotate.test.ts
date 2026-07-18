/**
 * `penv rotate` turns one parameter over by the mechanism its meta declares,
 * against the environment's source-of-truth provider. These tests exercise it
 * against the retaining `mock` provider, which is what makes a `dual-valid`
 * rehearsal possible: it keeps the prior version, so the grace window is real.
 *
 * Three properties are held:
 *  - a `dual-valid` begin opens the window (`active → rotating`, `rotatingSince`
 *    stamped) with the new value live *and the previous one still readable via
 *    `readPrevious`* — the overlap that is the whole point — and a later complete
 *    closes it (`rotating → active`, `rotatingSince` cleared, `lastRotated` set);
 *  - a `dual-valid` begin is refused up front against a non-retaining provider,
 *    because a window whose old value cannot be read back is a fiction;
 *  - an `atomic-cutover` flip writes the new value and stamps `lastRotated` in one
 *    step, and never touches `rotatingSince` — there is no penv-layer window.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meta, ParameterRef, ValueFile } from "@penvhq/core";
import { PenvError, parseEnvelope, rotationOf } from "@penvhq/core";
import { createFilesystemProvider } from "@penvhq/provider-filesystem";
import { createMockProvider } from "@penvhq/provider-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGet } from "./get.js";
import { runRotate } from "./rotate.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    // A non-retaining source of truth, for the refusal test.
    development: { type: "filesystem" },
    // A retaining source of truth, for the dual-valid and cutover tests.
    production: { type: "mock" },
  },
};

const REF: ParameterRef = { namespace: [], name: "api-key" };

/** The value file a rotation writes: the parameter at its environment scope. */
function fileFor(environment: string): ValueFile {
  return {
    namespace: [],
    name: "api-key",
    scope: { kind: "environment", environment },
    encrypted: false,
  };
}

const created: string[] = [];

function makeProject(config: Record<string, unknown> = {}): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "rotate-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify({ ...CONFIG, ...config })};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(join(root, ".penv", "env.ts"), "export const schema = {};\n", "utf8");
  return root;
}

/** The mock source, at the same path the registry builds it from. */
function mockSource(root: string) {
  return createMockProvider({ storePath: join(root, ".penv", ".penv-mock.json") });
}

/** The filesystem source for `development`, the same store the registry builds. */
function filesystemSource(root: string) {
  return createFilesystemProvider({ root: join(root, ".penv"), config: CONFIG });
}

const T_BEGIN = "2026-01-01T00:00:00.000Z";
const T_COMPLETE = "2026-02-01T00:00:00.000Z";
const T_CUTOVER = "2026-03-01T00:00:00.000Z";

/** The key `development` seals under in the local-tree rotation tests. */
const KEY_VARIABLE = "PENV_KEY_DEV";
const KEYS = { keys: { development: { source: "env", id: "dev" } } };

/** A real key, not a fixed one: a constant in a test is a constant in a habit. */
function freshKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * A value file's contents below `.penv/`, or `undefined` when absent — the
 * provider terminates a written file with a newline, so it is dropped here.
 */
function valueFile(root: string, location: string): string | undefined {
  const file = join(root, ".penv", location);
  if (!existsSync(file)) {
    return undefined;
  }
  const contents = readFileSync(file, "utf8");
  return contents.endsWith("\n") ? contents.slice(0, -1) : contents;
}

/** Writes the parameter's meta file into the local tree, the way `readMeta` reads it. */
function writeMetaFile(root: string, meta: Record<string, unknown>): void {
  writeFileSync(join(root, ".penv", "api-key.json"), JSON.stringify(meta), "utf8");
}

/**
 * The seal key is saved and cleared per test rather than merely restored, so a
 * key exported by the machine running the suite cannot make a test pass for a
 * reason it never stated.
 */
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.set(KEY_VARIABLE, process.env[KEY_VARIABLE]);
  delete process.env[KEY_VARIABLE];
});

afterEach(() => {
  for (const [variable, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[variable];
    } else {
      process.env[variable] = value;
    }
  }
  savedEnv.clear();
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runRotate", () => {
  it("dual-valid begin then complete: active → rotating → active, previous readable in the window", async () => {
    const root = makeProject();
    const source = mockSource(root);
    // The parameter declares dual-valid, and already holds a value — the one the
    // window keeps alive after begin writes the new one.
    await source.writeMeta(REF, { rotationMechanism: "dual-valid" });
    await source.write(fileFor("production"), "old-secret");

    // Precondition: active, never rotated.
    expect(rotationOf(await source.readMeta(REF), "production").state).toBe("active");

    const begun = await runRotate({
      cwd: root,
      key: "api-key",
      environment: "production",
      begin: true,
      value: "new-secret",
      now: T_BEGIN,
    });

    // The result and the persisted meta agree: the window is open.
    expect(begun.phase).toBe("begin");
    expect(begun.state).toBe("rotating");
    expect(begun.rotatingSince).toBe(T_BEGIN);
    expect(begun.lastRotated).toBeNull();
    const midMeta: Meta | undefined = await source.readMeta(REF);
    expect(rotationOf(midMeta, "production").state).toBe("rotating");
    expect(rotationOf(midMeta, "production").rotatingSince).toBe(T_BEGIN);

    // The overlap that is the whole point: the new value is live, and the previous
    // one is still readable while the window stays open.
    expect(await source.read(fileFor("production"))).toBe("new-secret");
    expect(await source.readPrevious(fileFor("production"))).toBe("old-secret");

    const done = await runRotate({
      cwd: root,
      key: "api-key",
      environment: "production",
      complete: true,
      now: T_COMPLETE,
    });

    // The window closes: back to active, the start-clock cleared, the completion stamped.
    expect(done.phase).toBe("complete");
    expect(done.wroteValue).toBe(false);
    expect(done.state).toBe("active");
    expect(done.rotatingSince).toBeNull();
    expect(done.lastRotated).toBe(T_COMPLETE);
    const endMeta: Meta | undefined = await source.readMeta(REF);
    expect(rotationOf(endMeta, "production").state).toBe("active");
    expect(rotationOf(endMeta, "production").rotatingSince).toBeNull();
    expect(rotationOf(endMeta, "production").lastRotated).toBe(T_COMPLETE);
  });

  it("refuses a dual-valid begin when the environment's provider does not retain", async () => {
    const root = makeProject();
    // development's source of truth is the filesystem, which has no `readPrevious`.
    const source = filesystemSource(root);
    await source.writeMeta(REF, { rotationMechanism: "dual-valid" });

    await expect(
      runRotate({
        cwd: root,
        key: "api-key",
        environment: "development",
        begin: true,
        value: "new-secret",
        now: T_BEGIN,
      }),
    ).rejects.toMatchObject({ code: "ROTATION_NOT_RETAINING" });

    // Refused before any write: the value was never placed.
    expect(await source.read(fileFor("development"))).toBeUndefined();
  });

  it("also surfaces the refusal as a PenvError", async () => {
    const root = makeProject();
    await filesystemSource(root).writeMeta(REF, { rotationMechanism: "dual-valid" });

    await expect(
      runRotate({
        cwd: root,
        key: "api-key",
        environment: "development",
        begin: true,
        value: "new-secret",
      }),
    ).rejects.toBeInstanceOf(PenvError);
  });

  it("atomic-cutover flips the value and stamps lastRotated, never setting rotatingSince", async () => {
    const root = makeProject();
    const source = mockSource(root);
    await source.writeMeta(REF, { rotationMechanism: "atomic-cutover" });
    await source.write(fileFor("production"), "old-secret");

    const result = await runRotate({
      cwd: root,
      key: "api-key",
      environment: "production",
      value: "new-secret",
      now: T_CUTOVER,
    });

    // A single flip: value replaced, completion stamped, no window opened.
    expect(result.phase).toBe("cutover");
    expect(result.wroteValue).toBe(true);
    expect(result.state).toBe("active");
    expect(result.rotatingSince).toBeNull();
    expect(result.lastRotated).toBe(T_CUTOVER);
    expect(await source.read(fileFor("production"))).toBe("new-secret");

    const meta: Meta | undefined = await source.readMeta(REF);
    expect(rotationOf(meta, "production").state).toBe("active");
    expect(rotationOf(meta, "production").rotatingSince).toBeNull();
    expect(rotationOf(meta, "production").lastRotated).toBe(T_CUTOVER);
  });
});

/**
 * When an environment has no separate `providers` entry — or one that IS the
 * filesystem — its source of truth is the local `.penv` tree, which penv owns the
 * envelope of. Rotating a value into it must obey the same seal-and-twin physics
 * `set` does: a secret is sealed, its plaintext twin removed. The defect these
 * cover was `rotate` hard-coding `encrypted: false` and skipping the twin removal,
 * so the live credential landed as cleartext `.penv/<name>.<env>` — committed to
 * git, and (plaintext outranks `.enc` at one scope) shadowing any sealed copy.
 */
describe("runRotate against the local filesystem tree", () => {
  it("atomic-cutover of a secret seals into the tree and leaves no plaintext value file", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject(KEYS);
    writeMetaFile(root, { secret: true, rotationMechanism: "atomic-cutover" });

    const result = await runRotate({
      cwd: root,
      key: "api-key",
      environment: "development",
      value: "new-secret",
      now: T_CUTOVER,
    });

    // A cutover flip, but sealed per meta rather than written verbatim.
    expect(result.phase).toBe("cutover");
    const sealed = valueFile(root, "api-key.development.enc");
    expect(parseEnvelope(sealed ?? "")?.keyId).toBe("dev");
    expect(sealed).not.toContain("new-secret");
    // No cleartext value file beside it — the whole defect.
    expect(valueFile(root, "api-key.development")).toBeUndefined();
    // And the sealed file opens to the new value.
    expect(await runGet({ cwd: root, key: "api-key", environment: "development" })).toBe(
      "new-secret",
    );
  });

  it("removes a pre-existing plaintext twin, so exactly one value file remains at the scope", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject(KEYS);
    // A stale cleartext value the old code would have left winning beside the seal.
    writeFileSync(join(root, ".penv", "api-key.development"), "old-plaintext\n", "utf8");
    writeMetaFile(root, { secret: true, rotationMechanism: "atomic-cutover" });

    await runRotate({
      cwd: root,
      key: "api-key",
      environment: "development",
      value: "new-secret",
      now: T_CUTOVER,
    });

    // The twin is gone; only the sealed file is left, and it is the new value.
    expect(valueFile(root, "api-key.development")).toBeUndefined();
    expect(parseEnvelope(valueFile(root, "api-key.development.enc") ?? "")).toBeDefined();
    expect(await runGet({ cwd: root, key: "api-key", environment: "development" })).toBe(
      "new-secret",
    );
  });

  it("atomic-cutover of a non-secret writes plaintext and removes any .enc twin", async () => {
    const root = makeProject(KEYS);
    // A stale ciphertext twin from when the parameter was a secret.
    writeFileSync(
      join(root, ".penv", "api-key.development.enc"),
      "penv:1:dev:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDQ4PEA\n",
      "utf8",
    );
    writeMetaFile(root, { rotationMechanism: "atomic-cutover" });

    const result = await runRotate({
      cwd: root,
      key: "api-key",
      environment: "development",
      value: "now-public",
      now: T_CUTOVER,
    });

    expect(result.phase).toBe("cutover");
    expect(valueFile(root, "api-key.development")).toBe("now-public");
    expect(valueFile(root, "api-key.development.enc")).toBeUndefined();
    expect(await runGet({ cwd: root, key: "api-key", environment: "development" })).toBe(
      "now-public",
    );
  });
});
