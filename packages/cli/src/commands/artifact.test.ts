/**
 * `penv artifact build` — what CI hands a release.
 *
 * Three things are tested, and the third is the one that matters most: the bytes
 * are canonical and reproducible, the refusals fire before anything is written,
 * and the artifact *does not contain* what an artifact must never contain. The
 * last is asserted as a scan of the written file rather than as a property of
 * the writer, because the failure it prevents is a plaintext secret or a
 * developer's `.local` override sitting in a release image.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ValueFile } from "@penvhq/core";
import { createEnvKeySource, KEY_BYTES, recordsDir, sealValue } from "@penvhq/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineVersion } from "../install.js";
import { runArtifactBuild } from "./artifact.js";

/** Fixture projects live under `node_modules` so a fixture's `import { z } from "zod"` resolves. */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: {
    development: "@penvhq/provider-filesystem",
    production: "@penvhq/provider-filesystem",
  },
};

const SCHEMA =
  "databaseUrl: z.string(), redis: z.object({ password: z.string().optional() }), region: z.string().optional()";

const created: string[] = [];
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;

const KEY_ID = "prod";
/** Not a real key — a real one is 32 random bytes, and this only has to be 32. */
const KEY = Buffer.alloc(KEY_BYTES, 7).toString("base64");

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  /** Meta files, keyed the way the tree is: `api-key.json`. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

function makeProject(fixture: Fixture = {}): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "artifact-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify({ ...CONFIG, ...fixture.config })};\n`,
    "utf8",
  );
  const schemaFile = join(root, ".penv", "env.ts");
  mkdirSync(dirname(schemaFile), { recursive: true });
  writeFileSync(
    schemaFile,
    `import { z } from "zod";\nexport const schema = z.object({${fixture.schema ?? SCHEMA}});\n`,
    "utf8",
  );
  mkdirSync(recordsDir(root), { recursive: true });
  for (const [name, contents] of Object.entries(fixture.tree ?? {})) {
    const file = join(recordsDir(root), name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  for (const [name, contents] of Object.entries(fixture.meta ?? {})) {
    writeFileSync(join(recordsDir(root), name), JSON.stringify(contents), "utf8");
  }
  return root;
}

/** Where a release keeps its artifact: outside the project it was built from. */
function outsideOf(root: string): string {
  const out = join(dirname(root), `${root.split(/[\\/]/).pop()}.artifact.json`);
  created.push(out);
  return out;
}

function seal(file: ValueFile, value: string): string {
  process.env.PENV_KEY_PROD = KEY;
  return sealValue(
    file,
    value,
    createEnvKeySource({ source: "env", id: KEY_ID }),
    file.name,
    "production",
  );
}

function refusalFrom(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; remedy?: string }> {
  return promise.then(
    () => {
      throw new Error("expected penv artifact build to refuse");
    },
    (error: { code: string; message: string; remedy?: string }) => error,
  );
}

beforeEach(() => {
  delete process.env.PENV_ENV;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  if (originalPenvEnv !== undefined) {
    process.env.PENV_ENV = originalPenvEnv;
  }
  if (originalNodeEnv !== undefined) {
    process.env.NODE_ENV = originalNodeEnv;
  }
  delete process.env.PENV_KEY_PROD;
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * The canonical form, in full. Written out rather than recomputed, because a
 * fixture derived from the writer would still pass after the writer changed —
 * and these bytes are what every reader of every release parses.
 */
describe("the bytes", () => {
  const SEEDED: Fixture = {
    // An `override` so the artifact carries a delivery mapping the default
    // transform would not produce — the case the bridge cannot guess.
    config: { override: { "redis.password": "REDIS_AUTH" } },
    tree: {
      "database-url.production": "postgres://production/app",
      "redis/password.production": "prod-secret",
    },
  };

  const CANONICAL =
    `{\n` +
    `  "engineVersion": "${engineVersion()}",\n` +
    `  "environment": "production",\n` +
    `  "format": 1,\n` +
    `  "keySource": "none",\n` +
    `  "schemaDigest": "sha256-dahboIeQkKJzntIyzF-kBUQeQPWWBNSGbf79eswGdyw",\n` +
    `  "values": {\n` +
    `    "database-url": {\n` +
    `      "kind": "plain",\n` +
    `      "value": "postgres://production/app",\n` +
    `      "variable": "DATABASE_URL"\n` +
    `    },\n` +
    `    "redis.password": {\n` +
    `      "kind": "plain",\n` +
    `      "value": "prod-secret",\n` +
    `      "variable": "REDIS_AUTH"\n` +
    `    },\n` +
    `    "region": {\n` +
    `      "kind": "absent",\n` +
    `      "variable": "REGION"\n` +
    `    }\n` +
    `  }\n` +
    `}\n`;

  it("are the canonical artifact, byte for byte", async () => {
    const root = makeProject(SEEDED);
    const out = outsideOf(root);

    await runArtifactBuild({ cwd: root, environment: "production", out });

    expect(readFileSync(out, "utf8")).toBe(CANONICAL);
  });

  /**
   * A schema-declared mapping with no non-local winner is carried as `absent`
   * rather than omitted. It is what lets a run from the artifact *delete* the
   * variable, so a stale value in the container cannot stand in for one penv
   * resolved to nothing.
   */
  it("carry every declared mapping, including the ones with no value", async () => {
    const root = makeProject(SEEDED);
    const out = outsideOf(root);

    const result = await runArtifactBuild({ cwd: root, environment: "production", out });

    expect(result).toMatchObject({ values: 2, sealed: 0, absent: 1, insideRepo: false });
  });

  it("are identical on a rebuild, sealed values included", async () => {
    const root = makeProject({
      config: {
        environments: {
          ...CONFIG.environments,
          production: {
            provider: "@penvhq/provider-filesystem",
            keySource: { source: "env", id: KEY_ID },
          },
        },
      },
      tree: {
        "database-url.production.enc": seal(
          {
            namespace: [],
            name: "database-url",
            scope: { kind: "environment", environment: "production" },
            encrypted: true,
          },
          "postgres://production/app",
        ),
        "redis/password.production": "prod-secret",
      },
    });
    const first = outsideOf(root);
    const second = `${first}.2`;
    created.push(second);

    await runArtifactBuild({ cwd: root, environment: "production", out: first });
    await runArtifactBuild({ cwd: root, environment: "production", out: second });

    // Ciphertext travels verbatim rather than being re-sealed, so two builds of
    // one tree are the same bytes — a re-seal would draw a new nonce each time.
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
    expect(readFileSync(first, "utf8")).toContain(`"keySource": "env:${KEY_ID}"`);
  });
});

/**
 * What an artifact must never carry, asserted against the written file. The
 * shape is closed, so provider fields have nowhere to go; these are the ones a
 * value could smuggle in.
 */
describe("what never reaches the artifact", () => {
  const SECRET_FILE: ValueFile = {
    namespace: [],
    name: "database-url",
    scope: { kind: "environment", environment: "production" },
    encrypted: true,
  };

  function fullProject(): string {
    return makeProject({
      config: {
        environments: {
          development: "@penvhq/provider-filesystem",
          production: {
            provider: "@penvhq/provider-vault",
            path: "secret/app",
            keySource: { source: "env", id: KEY_ID },
          },
        },
      },
      tree: {
        "database-url.production.enc": seal(SECRET_FILE, "postgres://production/app"),
        "database-url.production.local": "postgres://laptop/app",
        "database-url": "postgres://shared/app",
        "redis/password.production": "prod-secret",
      },
    });
  }

  it("holds no plaintext of a sealed value, and no key material", async () => {
    const root = fullProject();
    const out = outsideOf(root);

    await runArtifactBuild({ cwd: root, environment: "production", out });
    const text = readFileSync(out, "utf8");

    expect(text).not.toContain("postgres://production/app");
    expect(text).toContain("penv:1:prod:");
    expect(text).not.toContain(KEY);
  });

  it("holds no .local value, and no losing fallback record", async () => {
    const root = fullProject();
    const out = outsideOf(root);

    await runArtifactBuild({ cwd: root, environment: "production", out });
    const text = readFileSync(out, "utf8");

    // The `.local` file wins the cascade for a developer and must never win for
    // a release; the unscoped default lost and is not a record to carry either.
    expect(text).not.toContain("postgres://laptop/app");
    expect(text).not.toContain("postgres://shared/app");
    expect(text).not.toContain(".local");
  });

  it("holds no provider configuration and no key source beyond its name", async () => {
    const root = fullProject();
    const out = outsideOf(root);

    await runArtifactBuild({ cwd: root, environment: "production", out });
    const artifact = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;

    expect(Object.keys(artifact)).toEqual([
      "engineVersion",
      "environment",
      "format",
      "keySource",
      "schemaDigest",
      "values",
    ]);
    expect(readFileSync(out, "utf8")).not.toContain("@penvhq/provider-vault");
    expect(readFileSync(out, "utf8")).not.toContain("secret/app");
    // The identifier says where the key lives. It is not the key, and not a path.
    expect(artifact.keySource).toBe(`env:${KEY_ID}`);
  });

  it("generates nothing beside itself", async () => {
    const root = fullProject();
    const out = outsideOf(root);
    const before = readFileSync(join(root, "penv.config.ts"), "utf8");

    await runArtifactBuild({ cwd: root, environment: "production", out });

    // No bundler file, no scaffold, no rewritten config: the artifact is the
    // only thing the command writes.
    expect(readFileSync(join(root, "penv.config.ts"), "utf8")).toBe(before);
    expect(() => readFileSync(join(root, "penv.snapshot.ts"), "utf8")).toThrow();
  });
});

describe("the refusals", () => {
  it("will not default the environment, even where a default is declared", async () => {
    const root = makeProject({
      config: { defaultEnvironment: "development" },
      tree: { "database-url": "postgres://default/app", "redis/password": "shh" },
    });
    process.env.PENV_ENV = "development";

    const error = await refusalFrom(runArtifactBuild({ cwd: root, out: outsideOf(root) }));

    expect(error.code).toBe("ARTIFACT_ENV_REQUIRED");
    expect(error.remedy).toContain("penv artifact build --env <environment>");
  });

  it("will not default the path", async () => {
    const root = makeProject({ tree: { "database-url": "postgres://default/app" } });

    const error = await refusalFrom(runArtifactBuild({ cwd: root, environment: "production" }));

    expect(error.code).toBe("ARTIFACT_OUT_REQUIRED");
    expect(error.remedy).toContain("--out <path>");
  });

  it("refuses a secret whose winning value file is plaintext", async () => {
    const root = makeProject({
      tree: { "database-url.production": "postgres://production/app" },
      meta: { "database-url.json": { secret: true } },
    });
    const out = outsideOf(root);

    const error = await refusalFrom(
      runArtifactBuild({ cwd: root, environment: "production", out }),
    );

    expect(error.code).toBe("ARTIFACT_PLAINTEXT_SECRET");
    expect(error.message).toContain("database-url.production");
    expect(error.remedy).toContain("penv encrypt database-url --env production");
    // Refused before anything was written.
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  it("refuses a secret the public prefix would publish to the browser", async () => {
    const root = makeProject({
      config: { publicPrefixes: ["NEXT_PUBLIC_"] },
      schema: "nextPublicToken: z.string()",
      tree: { "next-public-token.production": "shhh" },
      meta: { "next-public-token.json": { secret: true } },
    });

    const error = await refusalFrom(
      runArtifactBuild({ cwd: root, environment: "production", out: outsideOf(root) }),
    );

    expect(error.code).toBe("RUN_PUBLIC_SECRET");
    expect(error.remedy).toContain("penv artifact build --env production");
  });

  /**
   * Invariant 12, at the other delivery. `inject` refuses this before it writes
   * a child environment; the artifact has to refuse it too, or a container reads
   * two mappings under one variable and takes whichever penv wrote last —
   * silently, where there is nobody left to notice.
   */
  it("refuses an override that maps two parameters to one variable", async () => {
    const root = makeProject({
      config: { override: { "redis.password": "DATABASE_URL" } },
      tree: {
        "database-url.production": "postgres://production/app",
        "redis/password.production": "prod-secret",
      },
    });
    const out = outsideOf(root);

    const error = await refusalFrom(
      runArtifactBuild({ cwd: root, environment: "production", out }),
    );

    expect(error.code).toBe("NAME_COLLISION");
    expect(error.message).toContain("DATABASE_URL");
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  it("refuses an override that delivers into penv's own channel", async () => {
    const root = makeProject({
      config: { override: { "database-url": "PENV_RUN" } },
      tree: { "database-url.production": "postgres://production/app" },
    });
    const out = outsideOf(root);

    const error = await refusalFrom(
      runArtifactBuild({ cwd: root, environment: "production", out }),
    );

    expect(error.code).toBe("DELIVERY_NAME_RESERVED");
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  it("refuses when the schema does not load, because it cannot tell what to deliver", async () => {
    const root = makeProject();
    writeFileSync(join(root, ".penv", "env.ts"), "export const schema = 42;\n", "utf8");

    const error = await refusalFrom(
      runArtifactBuild({ cwd: root, environment: "production", out: outsideOf(root) }),
    );

    expect(error.code).toBe("ARTIFACT_NO_SCHEMA");
    expect(error.remedy).toContain("penv artifact build --env production");
  });
});

/**
 * An artifact in the repository is a `doctor` finding, not a refusal — the
 * command still writes what it was told to write. It says so while the path can
 * still be changed.
 */
describe("an artifact written inside the project", () => {
  it("is reported, and still written", async () => {
    const root = makeProject({ tree: { "database-url.production": "postgres://production/app" } });
    const out = join(root, "dist", "penv.artifact.json");

    const result = await runArtifactBuild({ cwd: root, environment: "production", out });

    expect(result.insideRepo).toBe(true);
    expect(readFileSync(out, "utf8")).toContain('"environment": "production"');
  });

  it("is not reported for one written outside it", async () => {
    const root = makeProject({ tree: { "database-url.production": "postgres://production/app" } });

    const result = await runArtifactBuild({
      cwd: root,
      environment: "production",
      out: outsideOf(root),
    });

    expect(result.insideRepo).toBe(false);
  });
});
