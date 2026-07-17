/**
 * `doctor` against a sink. Three tiers, rendered by verdict: names are exact
 * (the one read a write-only destination allows), values are permanently
 * `unknown`, and a hand-edit is caught indirectly — GitHub's `updatedAt` newer
 * than penv's own last-push time. The sink is injected, so no test runs `gh`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretScope, Sink, SinkSecret } from "@penv/core";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorCheck, DoctorFinding } from "./doctor.js";
import { runDoctor } from "./doctor.js";
import { LAST_PUSHED_KEY } from "./push.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["production"],
  providers: { production: { type: "filesystem" } },
  sinks: { production: { type: "github" } },
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
  const root = mkdtempSync(join(FIXTURE_PARENT, "doctor-sink-"));
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

interface SinkFixture {
  readonly repo?: readonly SinkSecret[];
  readonly env?: readonly SinkSecret[];
  readonly verifyError?: Error;
  readonly listError?: Error;
}

function fakeSink(fixture: SinkFixture = {}): Sink {
  return {
    type: "github",
    verify: async () => {
      if (fixture.verifyError !== undefined) throw fixture.verifyError;
    },
    push: async () => {},
    list: async (scope: SecretScope) => {
      if (fixture.listError !== undefined) throw fixture.listError;
      return [...(scope.kind === "repository" ? (fixture.repo ?? []) : (fixture.env ?? []))];
    },
  };
}

function findingsOf(findings: readonly DoctorFinding[], check: DoctorCheck): DoctorFinding[] {
  return findings.filter((finding) => finding.check === check);
}

/** Meta declaring when penv last pushed this parameter for production. */
function pushedMeta(iso: string): string {
  return JSON.stringify({ environments: { production: { [LAST_PUSHED_KEY]: iso } } });
}

describe("doctor sink checks", () => {
  it("flags a secret edited outside penv — updatedAt newer than the last push", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": pushedMeta("2026-01-01T00:00:00.000Z"),
      },
    });
    const sink = fakeSink({ env: [{ name: "API_KEY", updatedAt: "2026-06-01T00:00:00Z" }] });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const edits = findingsOf(report.findings, "sink-manual-edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.severity).toBe("warning");
    expect(edits[0]?.subject).toBe("API_KEY");
    // A hand-edit is a warning, never a failure.
    expect(report.ok).toBe(true);
  });

  it("does not flag a hand-edit when the destination is no newer than the last push", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: {
        "api-key.production": "v",
        "api-key.json": pushedMeta("2026-06-01T00:00:00.000Z"),
      },
    });
    const sink = fakeSink({ env: [{ name: "API_KEY", updatedAt: "2026-01-01T00:00:00Z" }] });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    expect(findingsOf(report.findings, "sink-manual-edit")[0]?.severity).toBe("pass");
  });

  it("names a declared parameter absent from the destination", async () => {
    const root = makeProject({
      schema: "apiKey: z.string()",
      tree: { "api-key.production": "v" },
    });
    const sink = fakeSink({ env: [] });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const drift = findingsOf(report.findings, "sink-name-drift");
    expect(drift.some((f) => f.severity === "warning" && f.subject === "API_KEY")).toBe(true);
  });

  it("names a destination secret with no declared parameter", async () => {
    const root = makeProject({ tree: {} });
    const sink = fakeSink({ env: [{ name: "STALE", updatedAt: "2026-01-01T00:00:00Z" }] });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const drift = findingsOf(report.findings, "sink-name-drift");
    expect(drift.some((f) => f.subject === "STALE")).toBe(true);
  });

  it("always reports value drift as unknown — it cannot be read back", async () => {
    const root = makeProject({ tree: {} });
    const report = await runDoctor({ cwd: root, environment: "production", sink: fakeSink() });

    const value = findingsOf(report.findings, "sink-value-drift")[0];
    expect(value?.severity).toBe("unknown");
  });

  it("reports the whole sink as unknown when the destination cannot be reached", async () => {
    const root = makeProject({ tree: { "api-key.production": "v" }, schema: "apiKey: z.string()" });
    const sink = fakeSink({ verifyError: new Error("gh not installed") });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const unreachable = findingsOf(report.findings, "sink-unreachable");
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]?.severity).toBe("unknown");
    expect(report.ok).toBe(true);
  });

  it("reports unknown when the destination is reachable but listing secrets fails", async () => {
    const root = makeProject({ tree: { "api-key.production": "v" }, schema: "apiKey: z.string()" });
    const sink = fakeSink({ listError: new Error("HTTP 403: forbidden") });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const unreachable = findingsOf(report.findings, "sink-unreachable");
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]?.severity).toBe("unknown");
    expect(unreachable[0]?.subject).toContain("could not list");
    expect(report.ok).toBe(true);
  });

  it("does not flag another environment's repository default as undeclared", async () => {
    // FOO has an unscoped default (a repository secret) and a production override.
    // Doctoring production, whose winner is the env-scoped override, must not call
    // the shared repository secret undeclared.
    const root = makeProject({
      schema: "foo: z.string()",
      tree: { foo: "shared-default", "foo.production": "prod-override" },
    });
    const sink = fakeSink({
      repo: [{ name: "FOO", updatedAt: "2026-01-01T00:00:00Z" }],
      env: [{ name: "FOO", updatedAt: "2026-01-01T00:00:00Z" }],
    });

    const report = await runDoctor({ cwd: root, environment: "production", sink });

    const undeclared = findingsOf(report.findings, "sink-name-drift").filter(
      (f) => f.label === "In destination, not declared",
    );
    expect(undeclared).toEqual([]);
  });

  it("adds no sink findings when the environment declares no sink", async () => {
    const root = makeProject({ tree: { "api-key.production": "v" }, config: { sinks: {} } });

    const report = await runDoctor({ cwd: root, environment: "production" });

    expect(report.findings.some((f) => f.check.startsWith("sink-"))).toBe(false);
  });
});
