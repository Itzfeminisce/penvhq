/**
 * `penv push` ships an environment's values to a provider, and what crosses is
 * the destination's declared capability: a projection-holding provider receives
 * `penv generate` pointed at CI (no `.local`, names judged first, all or
 * nothing), a record-holding one receives the tree verbatim. These tests hold
 * both modes to their gates, and the create-on-approval flow to its rule: a
 * missing destination environment is created on an explicit yes and never on a
 * guess.
 *
 * The destination provider is injected, so no test touches the `gh` binary —
 * the provider package's own tests cover that seam.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Meta,
  ParameterRef,
  ProjectionProvider,
  Provider,
  SecretScope,
  ValueFile,
} from "@penvhq/core";
import { formatValueFile, parameterId } from "@penvhq/core";
import { checkGithubNames } from "@penvhq/provider-github";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAST_PUSHED_KEY, runPush } from "./push.js";
import { runSet } from "./set.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-github", location: "org/app" },
  },
  keys: { production: { source: "env", id: "prod" } },
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

interface ProjectionState {
  verifyCalls: number;
  verifyError?: Error;
  targetExists: boolean;
  ensureCalls: string[];
}

function fakeProjection(): {
  provider: ProjectionProvider;
  pushes: Pushed[];
  state: ProjectionState;
} {
  const pushes: Pushed[] = [];
  const state: ProjectionState = { verifyCalls: 0, targetExists: true, ensureCalls: [] };
  const provider: ProjectionProvider = {
    type: "@penvhq/provider-github",
    capabilities: { holds: "projection", readsValues: false },
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
    // The real provider's own grammar, so this fake refuses what a real push would.
    checkNames: (refs, config) => checkGithubNames(refs, config),
    targetExists: async () => state.targetExists,
    ensureTarget: async (environment) => {
      state.ensureCalls.push(environment);
      state.targetExists = true;
    },
  };
  return { provider, pushes, state };
}

/** A minimal record-holding destination that captures what a mirror sends. */
function fakeRecords(): {
  provider: Provider;
  values: Map<string, string>;
  metas: Map<string, Meta>;
} {
  const values = new Map<string, string>();
  const metas = new Map<string, Meta>();
  const provider: Provider = {
    type: "@penvhq/provider-vault",
    read: async (file: ValueFile) => values.get(formatValueFile(file)),
    write: async (file: ValueFile, value: string) => {
      values.set(formatValueFile(file), value);
    },
    list: async () => [],
    remove: async () => {},
    readMeta: async (ref: ParameterRef) => metas.get(parameterId(ref)),
    writeMeta: async (ref: ParameterRef, meta: Meta) => {
      metas.set(parameterId(ref), meta);
    },
    removeMeta: async () => {},
  };
  return { provider, values, metas };
}

function metaOf(root: string, location: string): Record<string, unknown> | undefined {
  const file = join(root, ".penv", location);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

describe("runPush to a projection-holding provider", () => {
  it("pushes every parameter, mapping env scope to an environment secret and the default to a repository secret", async () => {
    const root = makeProject({
      tree: {
        "db-url.production": "postgres://prod",
        "api-key": "shared-default",
      },
    });
    const { provider, pushes } = fakeProjection();

    const result = await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect(result.mode).toBe("projection");
    expect(result.pushed).toBe(2);
    expect(result.environmentSecrets).toBe(1);
    expect(result.repositorySecrets).toBe(1);
    expect(result.location).toBe("org/app");
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
    const { provider, pushes } = fakeProjection();

    await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect(pushes.map((p) => p.value)).toEqual(["postgres://prod"]);
    expect(pushes.map((p) => p.value)).not.toContain("postgres://my-laptop");
  });

  it("verifies the destination is reachable before it pushes anything", async () => {
    const root = makeProject({ tree: { "api-key": "v" } });
    const { provider, pushes, state } = fakeProjection();
    state.verifyError = new Error("gh not installed");

    await expect(
      runPush({ cwd: root, environment: "production", provider, now: NOW }),
    ).rejects.toThrow("gh not installed");
    expect(state.verifyCalls).toBe(1);
    // The guarantee, not just that verify ran: a failed verify places nothing, so
    // a reorder that pushed before verifying would fail here.
    expect(pushes).toHaveLength(0);
  });

  it("refuses a parameter whose variable GitHub reserves, before any push or verify", async () => {
    const root = makeProject({ tree: { "github-token.production": "x", "api-key": "v" } });
    const { provider, pushes, state } = fakeProjection();

    await expect(
      runPush({ cwd: root, environment: "production", provider, now: NOW }),
    ).rejects.toMatchObject({ code: "GITHUB_NAME" });
    expect(pushes).toHaveLength(0);
    expect(state.verifyCalls).toBe(0);
  });

  it("records penv's push time per environment in committed meta", async () => {
    const root = makeProject({ tree: { "api-key": "v" } });
    const { provider } = fakeProjection();

    await runPush({ cwd: root, environment: "production", provider, now: NOW });

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

    const refused = fakeProjection();
    await expect(
      runPush({ cwd: root, environment: "production", provider: refused.provider, now: NOW }),
    ).rejects.toMatchObject({ code: "ENCRYPTED_VALUE_REFUSED" });
    expect(refused.pushes).toHaveLength(0);

    const allowed = fakeProjection();
    const result = await runPush({
      cwd: root,
      environment: "production",
      provider: allowed.provider,
      allowDecrypt: true,
      now: NOW,
    });
    expect(result.decrypted).toBe(1);
    expect(allowed.pushes[0]?.value).toBe("hunter2");
  });

  it("reports nothing to push when no value resolves", async () => {
    const root = makeProject({ tree: {} });
    const { provider, pushes } = fakeProjection();

    const result = await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect(result.pushed).toBe(0);
    expect(pushes).toHaveLength(0);
  });
});

describe("the missing destination target", () => {
  it("creates it when --yes pre-approves, before any secret lands", async () => {
    const root = makeProject({ tree: { "db-url.production": "postgres://prod" } });
    const { provider, pushes, state } = fakeProjection();
    state.targetExists = false;

    const result = await runPush({
      cwd: root,
      environment: "production",
      provider,
      yes: true,
      now: NOW,
    });

    expect(state.ensureCalls).toEqual(["production"]);
    expect(result.createdTarget).toBe(true);
    expect(pushes).toHaveLength(1);
  });

  it("creates it when the prompt answers yes, and refuses when it answers no", async () => {
    const root = makeProject({ tree: { "db-url.production": "postgres://prod" } });

    const approved = fakeProjection();
    approved.state.targetExists = false;
    const yes = await runPush({
      cwd: root,
      environment: "production",
      provider: approved.provider,
      confirm: async () => true,
      now: NOW,
    });
    expect(yes.createdTarget).toBe(true);

    const refused = fakeProjection();
    refused.state.targetExists = false;
    await expect(
      runPush({
        cwd: root,
        environment: "production",
        provider: refused.provider,
        confirm: async () => false,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "MISSING_TARGET" });
    expect(refused.state.ensureCalls).toEqual([]);
    expect(refused.pushes).toHaveLength(0);
  });

  it("never asks when only repository-scoped secrets are pushed", async () => {
    const root = makeProject({ tree: { "api-key": "shared-default" } });
    const { provider, state } = fakeProjection();
    state.targetExists = false;

    const result = await runPush({
      cwd: root,
      environment: "production",
      provider,
      confirm: async () => {
        throw new Error("the prompt must not run");
      },
      now: NOW,
    });

    expect(result.createdTarget).toBe(false);
    expect(state.ensureCalls).toEqual([]);
  });
});

describe("runPush to a record-holding provider", () => {
  const VAULT_CONFIG = {
    providers: {
      development: { type: "@penvhq/provider-filesystem" },
      production: { type: "@penvhq/provider-vault", location: "penv/prod" },
    },
  };

  it("mirrors the unscoped and environment-scoped files verbatim, with their meta", async () => {
    const root = makeProject({
      config: VAULT_CONFIG,
      tree: {
        "db-url.production": "postgres://prod",
        "api-key": "shared-default",
        "api-key.json": JSON.stringify({ description: "the shared key" }),
      },
    });
    const { provider, values, metas } = fakeRecords();

    const result = await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect(result.mode).toBe("records");
    expect(result.pushed).toBe(2);
    expect(result.meta).toBe(1);
    expect(values.get("db-url.production")).toBe("postgres://prod");
    expect(values.get("api-key")).toBe("shared-default");
    expect(metas.get("api-key")).toEqual({ description: "the shared key" });
  });

  it("keeps both .local scopes and other environments' scopes home", async () => {
    const root = makeProject({
      config: VAULT_CONFIG,
      tree: {
        "db-url.production": "postgres://prod",
        "db-url.production.local": "postgres://my-laptop",
        "db-url.local": "postgres://also-mine",
        "db-url.development": "postgres://dev",
      },
    });
    const { provider, values } = fakeRecords();

    await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect([...values.keys()]).toEqual(["db-url.production"]);
  });

  it("mirrors a sealed value byte-for-byte without needing the key", async () => {
    process.env[KEY_VARIABLE] = randomBytes(32).toString("base64");
    const root = makeProject({
      config: VAULT_CONFIG,
      tree: { "db-password.json": JSON.stringify({ secret: true }) },
    });
    await runSet({ cwd: root, key: "db-password", value: "hunter2", environment: "production" });
    // The key is gone: a mirror of records must not need it.
    delete process.env[KEY_VARIABLE];
    const { provider, values } = fakeRecords();

    const result = await runPush({ cwd: root, environment: "production", provider, now: NOW });

    expect(result.pushed).toBe(1);
    const sealed = values.get("db-password.production.enc");
    expect(sealed).toBeDefined();
    expect(sealed).toMatch(/^penv:1:/);
    expect(sealed).not.toContain("hunter2");
  });
});

describe("the destination itself", () => {
  it("refuses when the environment's provider is the local tree", async () => {
    const root = makeProject({
      tree: { "api-key": "v" },
      config: {
        providers: {
          development: { type: "@penvhq/provider-filesystem" },
          production: { type: "@penvhq/provider-filesystem" },
        },
      },
    });

    await expect(runPush({ cwd: root, environment: "production", now: NOW })).rejects.toMatchObject(
      { code: "NO_DESTINATION" },
    );
  });

  it("pushes once to a --destination override without touching the declared provider", async () => {
    const root = makeProject({
      tree: { "api-key": "v" },
      config: {
        providers: {
          development: { type: "@penvhq/provider-filesystem" },
          production: { type: "@penvhq/provider-filesystem" },
        },
      },
    });
    const { provider, pushes } = fakeProjection();

    const result = await runPush({
      cwd: root,
      environment: "production",
      destination: "@penvhq/provider-github",
      location: "acme/api",
      provider,
      now: NOW,
    });

    expect(result.destination).toBe("@penvhq/provider-github");
    expect(result.location).toBe("acme/api");
    expect(pushes).toHaveLength(1);
  });
});

const NOW = "2026-07-17T00:00:00.000Z";
