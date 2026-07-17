/**
 * `set` is the only thing that writes a value, so it is the only thing that can
 * write a secret in plaintext — and before v0.3 it always did. It hardcoded the
 * plaintext branch while `doctor` reported a `secret: true` parameter with an
 * unencrypted value file as a failure (invariant 14), so the CLI's own writer
 * manufactured the exact finding the CLI's own checker complained about. These
 * tests are the reconciliation: what `set` writes must be what `doctor` accepts.
 *
 * The policy is meta's, never the command line's. There is no `--encrypt` flag to
 * test, and that absence is the design — so each test here fixes the policy in
 * meta and asserts what `set` did about it, including the two cases where the
 * only honest answer is to write nothing at all.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError, parseEnvelope } from "@penvhq/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "./doctor.js";
import { runGet } from "./get.js";
import { runSet } from "./set.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

/** Only production declares a key source, so `development` is the no-key case too. */
const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
  keys: { production: { source: "env", id: "prod" } },
};

const KEY_VARIABLE = "PENV_KEY_PROD";

/** A real key, not a fixed one: a constant in a test is a constant in a habit. */
function freshKey(): string {
  return randomBytes(32).toString("base64");
}

const created: string[] = [];
const savedEnv = new Map<string, string | undefined>();

/**
 * The environment is saved and cleared per test rather than merely restored, so
 * a key exported by the machine running the suite cannot make the no-key tests
 * pass for a reason the test never stated.
 */
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

interface Fixture {
  /** Files below `.penv/`, keyed by path — `"db-password.json"`. */
  readonly tree?: Readonly<Record<string, string>>;
  /** The body of `z.object({ ... })` in `.penv/env.ts`. */
  readonly schema?: string;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "set-enc-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    `import { z } from "zod";\nexport const schema = z.object({${fixture.schema ?? ""}});\n`,
    "utf8",
  );

  for (const [name, contents] of Object.entries(fixture.tree ?? {})) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

/**
 * A value file's contents, or `undefined` when it does not exist. The provider
 * terminates a written file with a newline, so it is dropped here.
 */
function valueFile(root: string, location: string): string | undefined {
  const file = join(root, ".penv", location);
  if (!existsSync(file)) {
    return undefined;
  }
  const contents = readFileSync(file, "utf8");
  return contents.endsWith("\n") ? contents.slice(0, -1) : contents;
}

/** The code of the refusal, or a failure naming the call that did not refuse. */
async function refusalOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(PenvError);
    return (error as PenvError).code;
  }
  throw new Error("the call resolved where it was required to refuse");
}

const SECRET = JSON.stringify({ secret: true });

describe("a secret with a key", () => {
  /**
   * The load-bearing one. `set` used to write `db-password.production` in
   * plaintext for exactly this fixture, which is the `plaintext-secret` failure
   * doctor reports — the writer and the checker disagreeing about one file. The
   * doctor run is half the assertion: an envelope doctor still rejects would be
   * the same disagreement with more steps.
   */
  it("seals the value and leaves doctor clean", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({
      schema: "dbPassword: z.string()",
      tree: { "db-password.json": SECRET },
    });

    const result = await runSet({
      cwd: root,
      key: "db-password",
      value: "hunter2",
      environment: "production",
    });

    expect(result.location).toBe("db-password.production.enc");
    const stored = valueFile(root, "db-password.production.enc");
    expect(parseEnvelope(stored ?? "")?.keyId).toBe("prod");
    // The `.enc` twin is the only file: a plaintext one beside it would satisfy
    // every assertion above and still leave the secret on disk.
    expect(valueFile(root, "db-password.production")).toBeUndefined();
    expect(stored).not.toContain("hunter2");

    const report = await runDoctor({ cwd: root, environment: "production" });
    // Nothing actionable: `unknown` ("could not look", e.g. no `publicPrefixes`
    // declared) is not a problem, so it is excluded alongside `pass`.
    expect(
      report.findings.filter(
        (finding) => finding.severity === "warning" || finding.severity === "failure",
      ),
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  /** Meta decided it, not the flag, so the caller is told — `renderSet` says so. */
  it("reports encrypted: true so the caller can say the marker was not a surprise", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({ tree: { "db-password.json": SECRET } });

    const result = await runSet({
      cwd: root,
      key: "db-password",
      value: "hunter2",
      environment: "production",
    });

    expect(result.encrypted).toBe(true);
  });
});

describe("a parameter meta does not declare secret", () => {
  /** The stays-quiet half: policy-driven means it seals what meta names, and nothing else. */
  it("writes plaintext with no .enc suffix", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({});

    const result = await runSet({
      cwd: root,
      key: "api/url",
      value: "https://api.example.com",
      environment: "production",
    });

    expect(result.location).toBe("api/url.production");
    expect(result.encrypted).toBe(false);
    expect(valueFile(root, "api/url.production")).toBe("https://api.example.com");
    expect(valueFile(root, "api/url.production.enc")).toBeUndefined();
  });

  /**
   * Meta merges shallow, base→env (invariant 5): a parameter that is secret in
   * production's block only is not a secret in development, and sealing it there
   * would apply one environment's policy to another's file — with a key
   * development does not even declare, so `set` would refuse a write that is
   * perfectly legal.
   */
  it("writes plaintext in development when only production's block declares it secret", async () => {
    const root = makeProject({
      tree: {
        "db-password.json": JSON.stringify({ environments: { production: { secret: true } } }),
      },
    });

    const result = await runSet({
      cwd: root,
      key: "db-password",
      value: "dev-password",
      environment: "development",
    });

    expect(result.location).toBe("db-password.development");
    expect(result.encrypted).toBe(false);
    expect(valueFile(root, "db-password.development")).toBe("dev-password");
    expect(valueFile(root, "db-password.development.enc")).toBeUndefined();
  });
});

describe("a secret penv cannot seal", () => {
  /**
   * The refusal must leave nothing behind. Writing the plaintext and letting
   * `doctor` report it afterwards would put the secret on disk in order to
   * complain about it — worse than either honest outcome, because the value is
   * committed by the time anyone reads the complaint.
   */
  it("refuses and writes nothing when the key is not exported", async () => {
    const root = makeProject({ tree: { "db-password.json": SECRET } });

    const code = await refusalOf(
      runSet({ cwd: root, key: "db-password", value: "hunter2", environment: "production" }),
    );

    expect(code).toBe("KEY_UNAVAILABLE");
    expect(valueFile(root, "db-password.production")).toBeUndefined();
    expect(valueFile(root, "db-password.production.enc")).toBeUndefined();
  });

  /**
   * A key source declared nowhere is a different situation from a key that is
   * missing, and both refuse: development declares no `keys` block, so penv was
   * never told where to look rather than having looked and found nothing.
   */
  it("refuses when the environment declares no key source at all", async () => {
    const root = makeProject({ tree: { "db-password.json": SECRET } });

    const code = await refusalOf(
      runSet({ cwd: root, key: "db-password", value: "hunter2", environment: "development" }),
    );

    expect(code).toBe("KEY_UNAVAILABLE");
    expect(valueFile(root, "db-password.development")).toBeUndefined();
    expect(valueFile(root, "db-password.development.enc")).toBeUndefined();
  });

  /**
   * Keys are declared per environment, so a file every environment falls back to
   * has no key penv can choose. Reaching for the ambient environment's key would
   * seal the unscoped default under one environment's key and leave every other
   * environment unable to open the file it reads.
   */
  it("refuses a secret at the unscoped scope rather than picking an environment", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({ tree: { "db-password.json": SECRET } });

    const code = await refusalOf(runSet({ cwd: root, key: "db-password", value: "hunter2" }));

    expect(code).toBe("SECRET_SCOPE_AMBIGUOUS");
    expect(valueFile(root, "db-password")).toBeUndefined();
    expect(valueFile(root, "db-password.enc")).toBeUndefined();
  });
});

/**
 * Found by pointing penv at a real project, and the worst kind of bug: `set`
 * reported success and `get` handed back something else.
 *
 * `.enc` is orthogonal to precedence, so `<name>.<env>` and `<name>.<env>.enc`
 * are two candidates at one address and the plaintext is considered first.
 * Marking an already-imported parameter `secret: true` and running `penv set`
 * therefore wrote the sealed file, printed a ✓ naming it, and left the stale
 * plaintext sitting on top of it — where it went on winning every read. The new
 * secret was inert on disk. One scope holds one value, so the twin goes.
 */
describe("the twin at the scope being written", () => {
  it("removes the plaintext when the value becomes a secret", async () => {
    const key = freshKey();
    process.env[KEY_VARIABLE] = key;
    const root = makeProject({
      tree: {
        "db-password.production": "stale-plaintext",
        "db-password.json": JSON.stringify({ secret: true }),
      },
    });

    await runSet({
      cwd: root,
      key: "db-password",
      value: "hunter2",
      environment: "production",
    });

    expect(valueFile(root, "db-password.production")).toBeUndefined();
    expect(parseEnvelope(valueFile(root, "db-password.production.enc") ?? "")).toBeDefined();
  });

  /** The value you set is the value you get. That is the whole of it. */
  it("makes the written secret the value that resolves", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({
      tree: {
        "db-password.production": "stale-plaintext",
        "db-password.json": JSON.stringify({ secret: true }),
      },
    });

    await runSet({
      cwd: root,
      key: "db-password",
      value: "hunter2",
      environment: "production",
    });

    expect(await runGet({ cwd: root, key: "db-password", environment: "production" })).toBe(
      "hunter2",
    );
  });

  /** And doctor is clean afterwards, rather than reporting the twin `set` left. */
  it("leaves no plaintext secret for doctor to find", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({
      tree: {
        "db-password.production": "stale-plaintext",
        "db-password.json": JSON.stringify({ secret: true }),
      },
    });

    await runSet({
      cwd: root,
      key: "db-password",
      value: "hunter2",
      environment: "production",
    });
    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(
      report.findings.filter((f) => f.check === "plaintext-secret" && f.severity !== "pass"),
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  /** The mirror: a parameter that stops being secret must not keep its ciphertext. */
  it("removes the ciphertext when the value stops being a secret", async () => {
    const root = makeProject({
      tree: { "db-password.production.enc": "penv:1:prod:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDQ4PEA" },
    });

    await runSet({
      cwd: root,
      key: "db-password",
      value: "now-public",
      environment: "production",
    });

    expect(valueFile(root, "db-password.production.enc")).toBeUndefined();
    expect(valueFile(root, "db-password.production")).toBe("now-public");
  });

  /** Only the scope being written. A twin at another scope is another value. */
  it("leaves other scopes alone", async () => {
    const root = makeProject({
      tree: { "db-password": "the-default", "db-password.development": "for-dev" },
    });

    await runSet({
      cwd: root,
      key: "db-password",
      value: "for-prod",
      environment: "production",
    });

    expect(valueFile(root, "db-password")).toBe("the-default");
    expect(valueFile(root, "db-password.development")).toBe("for-dev");
  });
});
