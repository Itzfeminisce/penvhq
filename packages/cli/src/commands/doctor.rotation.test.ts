/**
 * `doctor`'s rotation clocks and cross-provider value drift, tested the way every
 * other `doctor` check is: once on the true positive, once on the case it must
 * stay quiet about. `now` and the stuck threshold are injected, and the source
 * provider is injected the way the sink is — so the clocks are exercised without
 * mocking time and the drift comparison runs without a live backend.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meta, Provider, ValueFile } from "@penvhq/core";
import { createEnvKeySource, sealValue } from "@penvhq/core";
import { createMockProvider } from "@penvhq/provider-mock";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorFinding, DoctorSeverity } from "./doctor.js";
import { runDoctor } from "./doctor.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "doctor-rotation-"));
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

/** The fixed wall-clock reading every rotation test is judged against. */
const NOW = "2026-07-17T00:00:00.000Z";

/** Meta placing rotation policy fields in the production block. */
function rotationMeta(block: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ environments: { production: block } });
}

/** A source-provider value file for one parameter at its production scope. */
function envFile(name: string): ValueFile {
  return {
    namespace: [],
    name,
    scope: { kind: "environment", environment: "production" },
    encrypted: false,
  };
}

/** A mock source provider seeded with a handful of value files, injected like the sink is. */
function mockSource(root: string, values: Readonly<Record<string, string>>): Provider {
  const provider = createMockProvider({ storePath: join(root, ".penv-mock-source.json") });
  for (const [name, value] of Object.entries(values)) {
    void provider.write(envFile(name), value);
  }
  return provider;
}

/** A 32-byte base64 key, exported as `PENV_KEY_PROD` for the encryption-drift tests. */
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

/** The config that points production at a mock backend and reads its key from `PENV_KEY_PROD`. */
const ENC_CONFIG = {
  providers: { development: { type: "filesystem" }, production: { type: "mock" } },
  keys: { production: { source: "env", id: "prod" } },
};

/** Seals `value` for `api-key`'s production scope under `ENC_KEY`, the way `penv set` would. */
function sealApiKey(value: string): string {
  return sealValue(
    {
      namespace: [],
      name: "api-key",
      scope: { kind: "environment", environment: "production" },
      encrypted: true,
    },
    value,
    createEnvKeySource({ source: "env", id: "prod" }),
    "api-key",
    "production",
  );
}

describe("rotation-overdue", () => {
  it("fires when more than the policy's interval has elapsed since the last rotation", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationPolicy: "90d",
          lastRotated: "2026-01-01T00:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });
    const fired = firedFor(report.findings, "rotation-overdue");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe("warning");
    expect(fired[0]?.subject).toBe("api-key");
    expect(fired[0]?.detail).toContain("policy 90d");
    expect(fired[0]?.remedy).toBe("penv rotate api-key --env production");
    // A rotation clock is a warning, never a failure — the value still resolves.
    expect(report.ok).toBe(true);
  });

  it("stays quiet when the last rotation is still within the policy interval", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationPolicy: "90d",
          lastRotated: "2026-07-10T00:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });

    expect(firedFor(report.findings, "rotation-overdue")).toEqual([]);
    expect(severityOf(report.findings, "rotation-overdue")).toBe("pass");
  });

  it("stays quiet when no rotation policy is declared anywhere", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "v" },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });

    expect(firedFor(report.findings, "rotation-overdue")).toEqual([]);
    expect(severityOf(report.findings, "rotation-overdue")).toBe("pass");
  });

  /**
   * The crash defect: an unparseable `rotationPolicy` used to throw straight out
   * of `isOverdue` → `parseDuration`, in an unguarded loop, aborting the whole
   * doctor run through `guard()` — so one bad meta field blinded every other
   * check. Now it is a warning on that one parameter and the rest of the report
   * still renders.
   */
  it("does not crash on an unparseable rotationPolicy — it reports a finding and the other checks still run", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationPolicy: "1h30m",
          lastRotated: "2026-01-01T00:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });
    const fired = firedFor(report.findings, "rotation-overdue");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Rotation policy invalid");
    expect(fired[0]?.detail).toContain("1h30m");
    // The run survived the bad policy: checks after the rotation sweep still ran.
    expect(report.findings.some((f) => f.check === "provider" && f.severity === "pass")).toBe(true);
    expect(report.findings.some((f) => f.check === "schema")).toBe(true);
    // A rotation warning never fails the run.
    expect(report.ok).toBe(true);
  });

  /**
   * The wrong-store defect: `penv rotate` writes rotation state to the
   * environment's SOURCE provider, not the local tree, so the overdue clock has
   * to read there. A stale `lastRotated` in the source flags overdue even when
   * the local meta is clean — which the old code, reading only local meta, never
   * saw for a backend-backed environment.
   */
  it("reads rotation state from the source, so a stale source clock flags overdue with clean local meta", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "v" },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source = createMockProvider({ storePath: join(root, ".penv-mock-source.json") });
    const meta: Meta = {
      environments: {
        production: { rotationPolicy: "90d", lastRotated: "2026-01-01T00:00:00.000Z" },
      },
    };
    await source.writeMeta({ namespace: [], name: "api-key" }, meta);

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW, source });
    const fired = firedFor(report.findings, "rotation-overdue");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.label).toBe("Rotation overdue");
    expect(fired[0]?.subject).toBe("api-key");
    expect(fired[0]?.detail).toContain("policy 90d");
  });
});

describe("rotation-stuck", () => {
  it("fires when a dual-valid window has been open past the stuck threshold", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationMechanism: "dual-valid",
          rotationState: "rotating",
          rotatingSince: "2026-07-14T00:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });
    const fired = firedFor(report.findings, "rotation-stuck");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe("warning");
    expect(fired[0]?.subject).toBe("api-key");
    expect(fired[0]?.remedy).toBe("penv rotate api-key --complete --env production");
    expect(report.ok).toBe(true);
  });

  /**
   * The false positive the RFC and roadmap both single out: an atomic-cutover
   * parameter overlaps only at the infra layer, so a long-lived `rotatingSince` on
   * one is not a stuck penv-layer grace window and must never be flagged. `isStuck`
   * gates to dual-valid; this proves doctor leans on that gate and never re-derives.
   */
  it("does not flag an atomic-cutover parameter with an old rotatingSince", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationMechanism: "atomic-cutover",
          rotationState: "rotating",
          rotatingSince: "2026-01-01T00:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });

    expect(firedFor(report.findings, "rotation-stuck")).toEqual([]);
    expect(severityOf(report.findings, "rotation-stuck")).toBe("pass");
  });

  it("stays quiet when the window is still within the threshold", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": rotationMeta({
          rotationMechanism: "dual-valid",
          rotationState: "rotating",
          rotatingSince: "2026-07-16T18:00:00.000Z",
        }),
      },
    });

    const report = await runDoctor({ cwd: root, environment: "production", now: NOW });

    expect(firedFor(report.findings, "rotation-stuck")).toEqual([]);
    expect(severityOf(report.findings, "rotation-stuck")).toBe("pass");
  });
});

describe("provider-value-drift", () => {
  it("fails when the local tree and the source hold different values for one address", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "local-value" },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source = mockSource(root, { "api-key": "source-value" });

    const report = await runDoctor({ cwd: root, environment: "production", source });
    const fired = firedFor(report.findings, "provider-value-drift");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe("failure");
    expect(fired[0]?.subject).toBe("api-key.production");
    expect(report.ok).toBe(false);
  });

  it("passes when every value matches the source", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "same-value" },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source = mockSource(root, { "api-key": "same-value" });

    const report = await runDoctor({ cwd: root, environment: "production", source });

    expect(firedFor(report.findings, "provider-value-drift")).toEqual([]);
    expect(severityOf(report.findings, "provider-value-drift")).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("warns naming the side that holds a value the other does not", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "local-only" },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source = mockSource(root, {});

    const report = await runDoctor({ cwd: root, environment: "production", source });
    const fired = firedFor(report.findings, "provider-value-drift");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe("warning");
    expect(fired[0]?.subject).toBe("api-key.production");
    expect(fired[0]?.label).toBe("Only in the local tree");
    // A value present on one side only is a warning, never a failure.
    expect(report.ok).toBe(true);
  });

  /**
   * A filesystem-only environment has no second system of record, so penv looked
   * and there was one copy by design. That is a plain pass — "not applicable" — the
   * opposite of the write-only sink's permanent `unknown`, which is "penv could not
   * look".
   */
  it("reports a filesystem-only environment as a pass, not unknown", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "v" },
    });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(severityOf(report.findings, "provider-value-drift")).toBe("pass");
    expect(findingsOf(report.findings, "provider-value-drift")[0]?.subject).toContain(
      "no other source of truth",
    );
  });

  it("reports unknown when the source cannot be reached", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "v" },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source: Provider = {
      type: "mock",
      read: async () => undefined,
      write: async () => {},
      list: async () => {
        throw new Error("connection refused");
      },
      remove: async () => {},
      readMeta: async () => undefined,
      writeMeta: async () => {},
      removeMeta: async () => {},
    };

    const report = await runDoctor({ cwd: root, environment: "production", source });
    const drift = findingsOf(report.findings, "provider-value-drift");

    expect(drift).toHaveLength(1);
    expect(drift[0]?.severity).toBe("unknown");
    expect(drift[0]?.detail).toContain("connection refused");
    // Unknown never fails the run.
    expect(report.ok).toBe(true);
  });

  /**
   * The wrong-scope defect: the old check compared the ENTIRE local tree against
   * one env's source, so `--env production` flagged every development value as
   * "Only in the local tree". Only the pushable set — unscoped and this env's own
   * scope — has a source twin, so another environment's value is not drift.
   */
  it("does not flag another environment's values as drift", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "shared",
        "api-key.development": "dev-only",
      },
      config: { providers: { development: { type: "filesystem" }, production: { type: "mock" } } },
    });
    const source = mockSource(root, { "api-key": "shared" });

    const report = await runDoctor({ cwd: root, environment: "production", source });

    expect(firedFor(report.findings, "provider-value-drift")).toEqual([]);
    expect(severityOf(report.findings, "provider-value-drift")).toBe("pass");
    expect(report.ok).toBe(true);
  });

  /**
   * The ciphertext-key defect: keying by `formatValueFile` (which encodes `.enc`)
   * split an encrypted-local value from its plaintext-source twin into a false
   * one-sided drift, and the byte compare never ran. Keying by logical identity
   * and comparing PLAINTEXT — opening the sealed local value — makes an
   * encrypted-local vs plaintext-source pair with the same secret read as in sync.
   */
  it("treats an encrypted-local value with the same plaintext as the source as in sync", async () => {
    process.env.PENV_KEY_PROD = ENC_KEY;
    try {
      const root = makeProject({ schema: "apiKey: z.string()", config: ENC_CONFIG });
      writeFileSync(
        join(root, ".penv", "api-key.production.enc"),
        sealApiKey("shared-secret"),
        "utf8",
      );
      const source = mockSource(root, { "api-key": "shared-secret" });

      const report = await runDoctor({ cwd: root, environment: "production", source });

      expect(firedFor(report.findings, "provider-value-drift")).toEqual([]);
      expect(severityOf(report.findings, "provider-value-drift")).toBe("pass");
      expect(report.ok).toBe(true);
    } finally {
      delete process.env.PENV_KEY_PROD;
    }
  });

  it("flags an encrypted-local value whose plaintext differs from the source as a failure", async () => {
    process.env.PENV_KEY_PROD = ENC_KEY;
    try {
      const root = makeProject({ schema: "apiKey: z.string()", config: ENC_CONFIG });
      writeFileSync(
        join(root, ".penv", "api-key.production.enc"),
        sealApiKey("local-secret"),
        "utf8",
      );
      const source = mockSource(root, { "api-key": "source-secret" });

      const report = await runDoctor({ cwd: root, environment: "production", source });
      const fired = firedFor(report.findings, "provider-value-drift");

      expect(fired).toHaveLength(1);
      expect(fired[0]?.severity).toBe("failure");
      // The subject names the actual local file, sealed, so it carries `.enc`.
      expect(fired[0]?.subject).toBe("api-key.production.enc");
      expect(report.ok).toBe(false);
    } finally {
      delete process.env.PENV_KEY_PROD;
    }
  });
});
