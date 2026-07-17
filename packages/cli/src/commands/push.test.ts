/**
 * `penv push` is `penv generate` pointed at CI. These tests hold it to the v0.4
 * gate: it places every declared parameter, a developer's `.production.local`
 * override is provably not among them, a parameter that generates a reserved
 * GitHub name is refused before a single secret is written, and the push records
 * what it did in committed meta so `doctor` can later catch a hand-edit.
 *
 * The sink is injected, so no test touches the `gh` binary — the sink's own tests
 * cover that seam.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretScope, Sink } from "@penv/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAST_PUSHED_KEY, runPush } from "./push.js";
import { runSet } from "./set.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "filesystem" },
    production: { type: "filesystem" },
  },
  keys: { production: { source: "env", id: "prod" } },
  sinks: { production: { type: "github", repo: "org/app" } },
};

const KEY_VARIABLE = "PENV_KEY_PROD";
const created: string[] = [];
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

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly config?: Readonly<Record<string, unknown>>;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "push-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify({ ...CONFIG, ...fixture.config })};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(join(root, ".penv", "env.ts"), "export const schema = {};\n", "utf8");

  for (const [name, contents] of Object.entries(fixture.tree ?? {})) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

interface Pushed {
  readonly name: string;
  readonly value: string;
  readonly scope: SecretScope;
}

function fakeSink(): {
  sink: Sink;
  pushes: Pushed[];
  state: { verifyCalls: number; verifyError?: Error };
} {
  const pushes: Pushed[] = [];
  const state: { verifyCalls: number; verifyError?: Error } = { verifyCalls: 0 };
  const sink: Sink = {
    type: "github",
    verify: async () => {
      state.verifyCalls += 1;
      if (state.verifyError !== undefined) {
        throw state.verifyError;
      }
    },
    push: async (name, value, scope) => {
      pushes.push({ name, value, scope });
    },
    list: async () => [],
  };
  return { sink, pushes, state };
}

function metaOf(root: string, location: string): Record<string, unknown> | undefined {
  const file = join(root, ".penv", location);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

describe("runPush", () => {
  it("pushes every parameter, mapping env scope to an environment secret and the default to a repository secret", async () => {
    const root = makeProject({
      tree: {
        "db-url.production": "postgres://prod",
        "api-key": "shared-default",
      },
    });
    const { sink, pushes } = fakeSink();

    const result = await runPush({ cwd: root, environment: "production", sink, now: NOW });

    expect(result.pushed).toBe(2);
    expect(result.environmentSecrets).toBe(1);
    expect(result.repositorySecrets).toBe(1);
    expect(pushes).toContainEqual({
      name: "DB_URL",
      value: "postgres://prod",
      scope: { kind: "environment", environment: "production" },
    });
    expect(pushes).toContainEqual({
      name: "API_KEY",
      value: "shared-default",
      scope: { kind: "repository" },
    });
  });

  it("never pushes a .production.local personal override — CI receives what CI would read", async () => {
    const root = makeProject({
      tree: {
        "db-url.production": "postgres://prod",
        "db-url.production.local": "postgres://my-laptop",
      },
    });
    const { sink, pushes } = fakeSink();

    await runPush({ cwd: root, environment: "production", sink, now: NOW });

    expect(pushes.map((p) => p.value)).toEqual(["postgres://prod"]);
    expect(pushes.map((p) => p.value)).not.toContain("postgres://my-laptop");
  });

  it("verifies the destination is reachable before it pushes anything", async () => {
    const root = makeProject({ tree: { "api-key": "v" } });
    const { sink, pushes, state } = fakeSink();
    state.verifyError = new Error("gh not installed");

    await expect(runPush({ cwd: root, environment: "production", sink, now: NOW })).rejects.toThrow(
      "gh not installed",
    );
    expect(state.verifyCalls).toBe(1);
    // The guarantee, not just that verify ran: a failed verify places nothing, so
    // a reorder that pushed before verifying would fail here.
    expect(pushes).toHaveLength(0);
  });

  it("refuses a parameter whose variable GitHub reserves, before any push or verify", async () => {
    const root = makeProject({ tree: { "github-token.production": "x", "api-key": "v" } });
    const { sink, pushes, state } = fakeSink();

    await expect(
      runPush({ cwd: root, environment: "production", sink, now: NOW }),
    ).rejects.toMatchObject({ code: "GITHUB_NAME" });
    expect(pushes).toHaveLength(0);
    expect(state.verifyCalls).toBe(0);
  });

  it("refuses when the environment declares no sink", async () => {
    const root = makeProject({ tree: { "api-key": "v" }, config: { sinks: {} } });
    const { sink } = fakeSink();

    await expect(
      runPush({ cwd: root, environment: "production", sink, now: NOW }),
    ).rejects.toMatchObject({ code: "NO_SINK" });
  });

  it("records penv's push time per environment in committed meta", async () => {
    const root = makeProject({ tree: { "api-key": "v" } });
    const { sink } = fakeSink();

    await runPush({ cwd: root, environment: "production", sink, now: NOW });

    const meta = metaOf(root, "api-key.json");
    const block = (meta?.environments as Record<string, Record<string, unknown>> | undefined)
      ?.production;
    expect(block?.[LAST_PUSHED_KEY]).toBe(NOW);
  });

  it("refuses a sealed value without --allow-decrypt, and pushes it as plaintext with it", async () => {
    process.env[KEY_VARIABLE] = randomBytes(32).toString("base64");
    const root = makeProject({
      tree: { "db-password.json": JSON.stringify({ secret: true }) },
    });
    // `set` seals it because meta declares it a secret — no flag at the keyboard.
    await runSet({ cwd: root, key: "db-password", value: "hunter2", environment: "production" });

    const refused = fakeSink();
    await expect(
      runPush({ cwd: root, environment: "production", sink: refused.sink, now: NOW }),
    ).rejects.toMatchObject({ code: "ENCRYPTED_VALUE_REFUSED" });
    expect(refused.pushes).toHaveLength(0);

    const allowed = fakeSink();
    const result = await runPush({
      cwd: root,
      environment: "production",
      sink: allowed.sink,
      allowDecrypt: true,
      now: NOW,
    });
    expect(result.decrypted).toBe(1);
    expect(allowed.pushes[0]?.value).toBe("hunter2");
  });

  it("reports nothing to push when no value resolves", async () => {
    const root = makeProject({ tree: {} });
    const { sink, pushes } = fakeSink();

    const result = await runPush({ cwd: root, environment: "production", sink, now: NOW });

    expect(result.pushed).toBe(0);
    expect(pushes).toHaveLength(0);
  });
});

const NOW = "2026-07-17T00:00:00.000Z";
