/**
 * Every `doctor` check is tested twice: once on a true positive, and once on the
 * case it must stay quiet about. A check that only ever fires is indistinguish-
 * able from a check that always fires, and a report is only worth reading if
 * every line in it is true.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorFinding, DoctorSeverity } from "./doctor.js";
import { runDoctor } from "./doctor.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod. A
 * project in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};

const created: string[] = [];

interface Fixture {
  /** Files below `.penv/`, keyed by path — `"redis/password.production"`. */
  readonly tree?: Readonly<Record<string, string>>;
  /** The body of `z.object({ ... })` in `.penv/env.ts`. */
  readonly schema?: string;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "doctor-"));
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

function findingsOf(findings: readonly DoctorFinding[], check: DoctorCheck): DoctorFinding[] {
  return findings.filter((finding) => finding.check === check);
}

/** The findings for one check that are not its passing line. */
function firedFor(findings: readonly DoctorFinding[], check: DoctorCheck): DoctorFinding[] {
  return findingsOf(findings, check).filter((finding) => finding.severity !== "pass");
}

function severityOf(findings: readonly DoctorFinding[], check: DoctorCheck): DoctorSeverity {
  const finding = findingsOf(findings, check)[0];
  if (finding === undefined) {
    throw new Error(`doctor reported no line at all for the ${check} check`);
  }
  return finding.severity;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("missing", () => {
  it("fires when meta requires a parameter for this environment and nothing resolves", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string().optional() })",
      tree: {
        "redis/password.development": "dev-secret",
        "redis/password.json": JSON.stringify({ environments: { production: { required: true } } }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "missing");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Missing parameter");
    expect(fired[0]?.subject).toBe("redis.password");
    expect(fired[0]?.detail).toBe("required for production, absent");
    expect(report.ok).toBe(false);
  });

  it("stays quiet when the required parameter resolves for this environment", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() })",
      tree: {
        "redis/password.production": "prod-secret",
        "redis/password.json": JSON.stringify({ environments: { production: { required: true } } }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "missing")).toEqual([]);
    expect(severityOf(report.findings, "missing")).toBe("pass");
  });

  /** Requiredness is per-environment meta policy, never a second schema. */
  it("stays quiet when the parameter is required for a different environment", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string().optional() })",
      tree: {
        "redis/password.production": "prod-secret",
        "redis/password.json": JSON.stringify({ environments: { production: { required: true } } }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "development" });

    expect(firedFor(report.findings, "missing")).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("weak", () => {
  it("fires when the value is shorter than the schema's declared minimum", async () => {
    const root = makeProject({
      schema: "app: z.object({ jwtSecret: z.string().min(32) })",
      tree: { "app/jwt-secret": "18-chars-exactly!!" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "weak");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Weak secret");
    expect(fired[0]?.subject).toBe("app.jwt-secret");
    expect(fired[0]?.detail).toBe("18 chars, schema requires ≥32");
    expect(report.ok).toBe(false);
  });

  it("stays quiet when the value meets the minimum", async () => {
    const root = makeProject({
      schema: "app: z.object({ jwtSecret: z.string().min(8) })",
      tree: { "app/jwt-secret": "18-chars-exactly!!" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "weak")).toEqual([]);
    expect(severityOf(report.findings, "weak")).toBe("pass");
  });

  it("stays quiet when the field declares no minimum at all", async () => {
    const root = makeProject({
      schema: "app: z.object({ jwtSecret: z.string() })",
      tree: { "app/jwt-secret": "x" },
    });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "weak"),
    ).toEqual([]);
  });

  /**
   * The minimum survives `.optional()`, which is a wrapper rather than a shape:
   * unwrapping it is what keeps the check from silently skipping optional secrets.
   */
  it("fires through an optional wrapper", async () => {
    const root = makeProject({
      schema: "app: z.object({ jwtSecret: z.string().min(32).optional() })",
      tree: { "app/jwt-secret": "too-short" },
    });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "weak"),
    ).toHaveLength(1);
  });

  /** Introspection that is not reliable skips the field rather than guessing. */
  it("stays quiet on a field it cannot introspect", async () => {
    const root = makeProject({
      schema: "app: z.object({ jwtSecret: z.stringbool() })",
      tree: { "app/jwt-secret": "true" },
    });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "weak"),
    ).toEqual([]);
  });
});

describe("unused", () => {
  it("fires when a value file has no key in the schema", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.string()",
      tree: { "database-url": "postgres://localhost/app", "legacy-api-key": "abc123" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "unused");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Unused parameter");
    expect(fired[0]?.subject).toBe("LEGACY_API_KEY");
    expect(fired[0]?.detail).toBe("present, not in schema");
  });

  /** Unused is a warning: an extra file loses nothing, so it does not fail the run. */
  it("does not fail the run", async () => {
    const root = makeProject({ schema: "", tree: { "legacy-api-key": "abc123" } });

    expect((await runDoctor({ cwd: root, environment: "production" })).ok).toBe(true);
  });

  it("stays quiet when every value file has a schema key", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.string(), redis: z.object({ password: z.string() })",
      tree: { "database-url": "postgres://localhost/app", "redis/password": "secret" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "unused")).toEqual([]);
    expect(severityOf(report.findings, "unused")).toBe("pass");
  });
});

describe("unscoped-fallback", () => {
  it("fires when a real environment resolves via the unscoped default", async () => {
    const root = makeProject({
      schema: "apiUrl: z.string()",
      tree: { "api-url": "https://api.example.com" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "unscoped-fallback");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Unscoped fallback in use");
    expect(fired[0]?.subject).toBe("api-url");
    expect(fired[0]?.detail).toBe("production resolving to default");
  });

  it("stays quiet when the environment's own value file wins", async () => {
    const root = makeProject({
      schema: "apiUrl: z.string()",
      tree: { "api-url": "https://api.example.com", "api-url.production": "https://prod.example" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "unscoped-fallback")).toEqual([]);
    expect(severityOf(report.findings, "unscoped-fallback")).toBe("pass");
  });
});

describe("plaintext-secret", () => {
  it("fires when meta declares a secret and the winning value file is plaintext", async () => {
    const root = makeProject({
      schema: "dbPassword: z.string()",
      tree: {
        "db-password.production": "hunter2",
        "db-password.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "plaintext-secret");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Plaintext secret");
    expect(fired[0]?.subject).toBe("db-password.production");
    expect(fired[0]?.detail).toBe("value file is not encrypted");
    expect(report.ok).toBe(false);
  });

  /** Policy-driven, not filename-driven: the `.enc` marker satisfies the policy. */
  it("stays quiet when the secret's winning value file is encrypted", async () => {
    const root = makeProject({
      schema: "dbPassword: z.string().optional()",
      tree: {
        "db-password.production.enc": "AAAA-ciphertext",
        "db-password.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "plaintext-secret")).toEqual([]);
    expect(severityOf(report.findings, "plaintext-secret")).toBe("pass");
  });

  /** A plaintext value file is only a failure when meta says the parameter is secret. */
  it("stays quiet on a plaintext value that meta does not declare secret", async () => {
    const root = makeProject({
      schema: "apiUrl: z.string()",
      tree: { "api-url.production": "https://api.example.com" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "plaintext-secret")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  /**
   * Meta merges base→env: a parameter that is secret in production only is not a
   * plaintext failure in development, where the policy does not apply.
   */
  it("stays quiet where the environment's meta block does not declare it secret", async () => {
    const root = makeProject({
      schema: "dbPassword: z.string()",
      tree: {
        "db-password.development": "dev-password",
        "db-password.json": JSON.stringify({ environments: { production: { secret: true } } }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "development" });

    expect(firedFor(report.findings, "plaintext-secret")).toEqual([]);
  });
});

describe("a schema that does not load", () => {
  /**
   * The checks that need the schema cannot run, and the report says so. Printing
   * nothing where a check belongs reads as "nothing found" — the one thing a
   * report must never imply.
   */
  it("reports the checks it could not run rather than omitting them", async () => {
    const root = makeProject({ schema: "", tree: { "api-url": "https://api.example.com" } });
    writeFileSync(join(root, ".penv", "env.ts"), "export const nope = 1;\n", "utf8");

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(severityOf(report.findings, "schema")).toBe("failure");
    expect(report.ok).toBe(false);
    for (const check of ["weak", "unused"] as const) {
      expect(findingsOf(report.findings, check)).toHaveLength(1);
      expect(findingsOf(report.findings, check)[0]?.detail).toContain("could not run");
    }
    // The checks that need no schema still run.
    expect(firedFor(report.findings, "unscoped-fallback")).toHaveLength(1);
  });
});

describe("the report", () => {
  it("prints a passing line for every check when nothing is wrong", async () => {
    const root = makeProject({
      schema: "apiUrl: z.string()",
      tree: { "api-url.production": "https://api.example.com" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.check)).toEqual([
      "schema",
      "missing",
      "weak",
      "unused",
      "unscoped-fallback",
      "plaintext-secret",
      "provider",
    ]);
    expect(report.findings.every((finding) => finding.severity === "pass")).toBe(true);
    expect(report.findings[0]?.label).toBe("Schema valid");
    expect(report.findings[6]?.subject).toBe("filesystem");
  });
});
