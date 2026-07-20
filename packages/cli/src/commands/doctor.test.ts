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
    development: { type: "@penvhq/provider-filesystem" },
    test: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

const created: string[] = [];

interface Fixture {
  /** Files below `.penv/`, keyed by path — `"redis/password.production"`. */
  readonly tree?: Readonly<Record<string, string>>;
  /** The body of `z.object({ ... })` in `.penv/env.ts`. */
  readonly schema?: string;
  /** Keys merged over {@link CONFIG} — `publicPrefixes`, `override`. */
  readonly config?: Readonly<Record<string, unknown>>;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "doctor-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify({ ...CONFIG, ...fixture.config })};\n`,
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

describe("declared", () => {
  it("fires when the schema declares a parameter with no value for this environment", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() })",
      tree: { "redis/password.development": "dev-secret" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "declared");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Declared, no value");
    expect(fired[0]?.subject).toBe("redis.password");
    expect(fired[0]?.detail).toBe("declared in .penv/env.ts, no value for production");
    expect(fired[0]?.remedy).toBe("penv set redis/password --env production");
  });

  /**
   * The case no tree-driven check can reach: a parameter with no file anywhere
   * has no meta either, so `missing` never sees it. Before this check, the only
   * report of it was a raw Zod issue from `validate`.
   */
  it("fires for a declared parameter with no file at all", async () => {
    const root = makeProject({ schema: "databaseUrl: z.string()", tree: {} });

    const fired = firedFor(
      (await runDoctor({ cwd: root, environment: "production" })).findings,
      "declared",
    );

    expect(fired).toHaveLength(1);
    expect(fired[0]?.subject).toBe("database-url");
    expect(fired[0]?.remedy).toBe("penv set database-url --env production");
  });

  /** Drift is reported, never enforced: `validate` is where the verdict is reached. */
  it("does not fail the run", async () => {
    const root = makeProject({ schema: "databaseUrl: z.string()", tree: {} });

    expect((await runDoctor({ cwd: root, environment: "production" })).ok).toBe(true);
  });

  it("stays quiet when the declared parameter has a value for this environment", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() })",
      tree: { "redis/password.production": "prod-secret" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "declared")).toEqual([]);
    expect(severityOf(report.findings, "declared")).toBe("pass");
  });

  it("stays quiet when the unscoped default supplies the value", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() })",
      tree: { "redis/password": "default-secret" },
    });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "declared"),
    ).toEqual([]);
  });

  /** The schema itself says absence is legal, so absence is a declaration, not drift. */
  it("stays quiet on an optional field with no value", async () => {
    const root = makeProject({ schema: "databaseUrl: z.string().optional()", tree: {} });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "declared"),
    ).toEqual([]);
  });

  it("stays quiet on a field with a default", async () => {
    const root = makeProject({ schema: 'port: z.string().default("3000")', tree: {} });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "declared"),
    ).toEqual([]);
  });

  /**
   * Absence permission is inherited. Judged on its own wrapper, `password` is a
   * bare string and would be reported — while the schema is perfectly happy with
   * the whole `redis` namespace absent.
   */
  it("stays quiet beneath an optional namespace", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() }).optional()",
      tree: {},
    });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "declared"),
    ).toEqual([]);
  });

  /**
   * `.nullable()` accepts null, which no value file can produce: a missing file
   * is `undefined`, and that is what the schema rejects. So absence is drift.
   */
  it("fires on a nullable field with no value", async () => {
    const root = makeProject({ schema: "databaseUrl: z.string().nullable()", tree: {} });

    expect(
      firedFor((await runDoctor({ cwd: root, environment: "production" })).findings, "declared"),
    ).toHaveLength(1);
  });

  /**
   * `apiURL` kebabs to `api-url`, which camels back to `apiUrl` — so no value
   * file penv can name ever reaches this key. Reported as drift `penv set`
   * cannot close, rather than with a paste line that would write a file the
   * schema still would not see.
   */
  it("names the rename when no filename reaches the declared key", async () => {
    const root = makeProject({ schema: "apiURL: z.string()", tree: {} });

    const fired = firedFor(
      (await runDoctor({ cwd: root, environment: "production" })).findings,
      "declared",
    );

    expect(fired).toHaveLength(1);
    expect(fired[0]?.subject).toBe("apiURL");
    expect(fired[0]?.detail).toBe("declared, no filename reaches it");
    expect(fired[0]?.remedy).not.toContain("penv set");
    expect(fired[0]?.remedy).toContain("Rename");
  });

  /**
   * A reserved token is unreachable for the same reason `apiURL` is: the grammar
   * refuses it as a parameter name, so no value file resolves to the key. The
   * paste line would have been `penv set local --env production` — a command
   * that errors, offered as the fix.
   */
  it("names the rename when the declared key is a reserved token", async () => {
    const root = makeProject({ schema: "local: z.string(), production: z.string()", tree: {} });

    const fired = firedFor(
      (await runDoctor({ cwd: root, environment: "production" })).findings,
      "declared",
    );

    expect(fired.map((finding) => finding.subject)).toEqual(["local", "production"]);
    for (const finding of fired) {
      expect(finding.detail).toBe("declared, no filename reaches it");
      expect(finding.remedy).not.toContain("penv set");
    }
  });

  /**
   * One absence, one line. `missing` is the same fact with meta's stronger
   * verdict on it, and it carries the same paste line, so this must not repeat it.
   */
  it("does not repeat an absence the missing check already reported", async () => {
    const root = makeProject({
      schema: "redis: z.object({ password: z.string() })",
      tree: {
        // A value for another environment, so the parameter is in the tree and
        // `missing` can see it: a parameter with only meta is listed nowhere.
        "redis/password.development": "dev-secret",
        "redis/password.json": JSON.stringify({ environments: { production: { required: true } } }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "missing")).toHaveLength(1);
    expect(firedFor(report.findings, "missing")[0]?.remedy).toBe(
      "penv set redis/password --env production",
    );
    expect(firedFor(report.findings, "declared")).toEqual([]);
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

/**
 * The contradiction only penv can see: meta says secret, the generated name says
 * the framework will inline it into the client bundle. The framework reads the
 * prefix as the intent and the app's env module never sees the meta, so a false
 * negative here ships a secret to every browser — and a false positive fires on
 * `NEXT_PUBLIC_*`, which is the overwhelmingly common and correct case, and makes
 * the whole report something people learn to skip.
 */
describe("public-secret", () => {
  it("fires when meta declares a secret whose variable carries a public prefix", async () => {
    const root = makeProject({
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
      schema: "nextPublicStripeKey: z.string()",
      tree: {
        "next-public-stripe-key.production": "sk_live_1234",
        "next-public-stripe-key.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "public-secret");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Secret exposed to the browser");
    expect(fired[0]?.subject).toBe("NEXT_PUBLIC_STRIPE_KEY");
    expect(fired[0]?.detail).toBe(
      "meta declares this a secret, and the `NEXT_PUBLIC_` prefix makes it public",
    );
    expect(fired[0]?.remedy).toContain("rename the parameter");
    expect(report.ok).toBe(false);
  });

  /**
   * The negative that decides whether the check is usable at all. A public-
   * prefixed parameter that is not secret is the prefix working as designed;
   * firing here would flag every correct `NEXT_PUBLIC_*` in the project.
   */
  it("stays quiet on a public-prefixed parameter that meta does not declare secret", async () => {
    const root = makeProject({
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
      schema: "nextPublicLandingOrigin: z.string()",
      tree: { "next-public-landing-origin.production": "https://example.com" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "public-secret")).toEqual([]);
    expect(severityOf(report.findings, "public-secret")).toBe("pass");
    expect(findingsOf(report.findings, "public-secret")[0]?.subject).toBe(
      "no secret is exposed to the browser for production",
    );
    expect(report.ok).toBe(true);
  });

  it("stays quiet on a secret whose variable carries no public prefix", async () => {
    const root = makeProject({
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
      schema: "stripeKey: z.string()",
      tree: {
        "stripe-key.production.enc": "AAAA-ciphertext",
        "stripe-key.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(firedFor(report.findings, "public-secret")).toEqual([]);
    expect(severityOf(report.findings, "public-secret")).toBe("pass");
  });

  /**
   * A prefix penv was never told about is one it cannot recognise, so the line
   * must say it did not look. Reporting this as a clean check would be the worst
   * possible lie: silence read as "no secret reaches the browser" by a reader
   * whose config never named a prefix to find.
   */
  it("says it could not check when no publicPrefixes are declared", async () => {
    const root = makeProject({
      schema: "nextPublicStripeKey: z.string()",
      tree: {
        "next-public-stripe-key.production": "sk_live_1234",
        "next-public-stripe-key.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const line = findingsOf(report.findings, "public-secret")[0];

    expect(line?.subject).toContain("not checked");
    expect(line?.subject).not.toContain("no secret is exposed");
    expect(line?.detail).toContain("cannot tell");
  });

  /** Meta merges base→env (invariant 5): the policy applies where it is declared. */
  it("fires for the environment whose meta block declares it secret", async () => {
    const fixture = {
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
      schema: "nextPublicStripeKey: z.string()",
      tree: {
        "next-public-stripe-key.development": "pk_test_1234",
        "next-public-stripe-key.production": "sk_live_1234",
        "next-public-stripe-key.json": JSON.stringify({
          environments: { production: { secret: true } },
        }),
      },
    } as const;

    expect(
      firedFor(
        (await runDoctor({ cwd: makeProject(fixture), environment: "production" })).findings,
        "public-secret",
      ),
    ).toHaveLength(1);
    expect(
      firedFor(
        (await runDoctor({ cwd: makeProject(fixture), environment: "development" })).findings,
        "public-secret",
      ),
    ).toEqual([]);
  });

  /**
   * The variable the framework inlines is the generated one, and an `override`
   * override is the one place a public prefix can appear with nothing in the
   * tree hinting at it: the file is `stripe-key`, and it still ships.
   */
  it("reads the generated variable, not the parameter name", async () => {
    const root = makeProject({
      config: {
        publicPrefixes: ["NEXT_PUBLIC_"],
        override: { "stripe-key": "NEXT_PUBLIC_STRIPE_KEY" },
      },
      schema: "stripeKey: z.string()",
      tree: {
        "stripe-key.production": "sk_live_1234",
        "stripe-key.json": JSON.stringify({ secret: true }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });
    const fired = firedFor(report.findings, "public-secret");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.subject).toBe("NEXT_PUBLIC_STRIPE_KEY");
    expect(report.ok).toBe(false);
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
    for (const check of ["declared", "weak", "unused"] as const) {
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
      // Declared so the browser-exposure check reaches a real `pass` rather than
      // the `unknown` it now returns when it has no prefixes to check against.
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.check)).toEqual([
      "schema",
      "missing",
      "declared",
      "weak",
      "unused",
      "unscoped-fallback",
      "plaintext-secret",
      "public-secret",
      "encryption",
      "rotation-overdue",
      "rotation-stuck",
      "provider-value-drift",
      "provider",
    ]);
    expect(report.findings.every((finding) => finding.severity === "pass")).toBe(true);
    // By check rather than by index: every new check shifts the positions, and a
    // test that has to be renumbered to stay green is one that gets renumbered
    // without being read.
    expect(findingsOf(report.findings, "schema")[0]?.label).toBe("Schema valid");
    expect(findingsOf(report.findings, "provider")[0]?.subject).toBe("@penvhq/provider-filesystem");
  });
});
