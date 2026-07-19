/**
 * `penv fill` closes the gap the schema-first flow opens: the user writes
 * `.penv/env.ts`, and now has to turn each declared parameter into a value file
 * whose name they should not have to derive. `fill` asks for each missing value
 * and writes it under the derived kebab name, so these tests assert two things a
 * user could otherwise get wrong — that the prompt carries the derived key, not
 * the schema key, and that a blank answer writes nothing rather than an empty
 * value.
 *
 * `runFill` is exercised with a fake `ask`, never a spawned process: the readline
 * half lives in the wrapper, so the logic here is a plain function call.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PenvError } from "@penvhq/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FillPrompt } from "./fill.js";
import { runFill } from "./fill.js";
import { runGet } from "./get.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it would
 * in a real project — by walking up to a `node_modules` that has zod. A project
 * in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
  keys: { production: { source: "env", id: "prod" } },
};

/** Only production declares a key source, so a secret fill targets that environment. */
const KEY_VARIABLE = "PENV_KEY_PROD";

/** A real key, not a fixed one: a constant in a test is a constant in a habit. */
function freshKey(): string {
  return randomBytes(32).toString("base64");
}

const created: string[] = [];
const savedEnv = new Map<string, string | undefined>();

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  /** The inner object body of the schema, e.g. `databaseUrl: z.url()`. */
  readonly schema?: string;
  /** The whole schema module, verbatim — overrides `schema` when a fixture needs
   * its own imports (e.g. the scaffolded eager `load`). */
  readonly schemaModule?: string;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "fill-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    fixture.schemaModule ??
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

/** Records every prompt, and answers each from a supplied map (absent → skip). */
function scriptedAsk(answers: Readonly<Record<string, string | undefined>>): {
  readonly ask: (prompt: FillPrompt) => Promise<string | undefined>;
  readonly prompted: FillPrompt[];
} {
  const prompted: FillPrompt[] = [];
  const ask = (prompt: FillPrompt): Promise<string | undefined> => {
    prompted.push(prompt);
    return Promise.resolve(answers[prompt.parameter]);
  };
  return { ask, prompted };
}

/**
 * The key variable is cleared per test and restored after, so a key exported by
 * the machine running the suite cannot make a secret fill pass for a reason the
 * test never stated — nor leak into the tests that write plaintext.
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

describe("penv fill", () => {
  /**
   * The scaffolded module ends in an eager `export const env = load(schema)`. In
   * a project with no values yet that load used to throw during the schema read,
   * the module namespace vanished with it, and `fill` reported "nothing to fill"
   * against an empty drift — the exact gap it exists to close, invisible. The
   * schema-harvest pin makes `load` defer during the read, so the schema is
   * reachable and every declared parameter is prompted for.
   */
  it("prompts for every missing parameter even when the module loads eagerly", async () => {
    const root = makeProject({
      schemaModule:
        'import { z } from "zod";\n' +
        'import { load } from "@penvhq/runtime";\n' +
        "export const schema = z.object({ databaseUrl: z.url(), apiKey: z.string() });\n" +
        "export const env = load(schema);\n",
    });
    const { ask, prompted } = scriptedAsk({
      "database-url": "postgres://localhost/app",
      "api-key": "k-123",
    });

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted.map((prompt) => prompt.parameter)).toEqual(["database-url", "api-key"]);
    expect(result.written.map((entry) => entry.parameter)).toEqual(["database-url", "api-key"]);
    await expect(
      runGet({ cwd: root, key: "database-url", environment: "production" }),
    ).resolves.toBe("postgres://localhost/app");
  });

  /**
   * The whole point: the schema says `databaseUrl`, the file is `database-url`,
   * and the user is asked for the derived key — never the schema one. The written
   * value is then readable through the same cascade `get` walks.
   */
  it("prompts with the derived key and writes the value file", async () => {
    const root = makeProject({ schema: "databaseUrl: z.url()" });
    const { ask, prompted } = scriptedAsk({ "database-url": "postgres://localhost/app" });

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted.map((prompt) => prompt.parameter)).toEqual(["database-url"]);
    expect(result.written).toEqual([
      { parameter: "database-url", location: "database-url.production", encrypted: false },
    ]);
    expect(result.skipped).toEqual([]);
    await expect(
      runGet({ cwd: root, key: "database-url", environment: "production" }),
    ).resolves.toBe("postgres://localhost/app");
  });

  /** A blank answer is not a value: nothing is written, and the parameter is skipped. */
  it("skips a parameter rather than inventing a value", async () => {
    const root = makeProject({ schema: "apiKey: z.string()" });
    const { ask } = scriptedAsk({ "api-key": "" });

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["api-key"]);
    await expect(
      runGet({ cwd: root, key: "api-key", environment: "production" }),
    ).rejects.toBeInstanceOf(PenvError);
  });

  it("treats an undefined answer as a skip too", async () => {
    const root = makeProject({ schema: "apiKey: z.string()" });
    const { ask, prompted } = scriptedAsk({});

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted.map((prompt) => prompt.parameter)).toEqual(["api-key"]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(["api-key"]);
  });

  /**
   * `apiURL` kebabs to `api-url`, which camels back to `apiUrl` — no value file
   * reaches it, so `fill` cannot ask for a value it could never write. It carries
   * the rename remedy out instead of prompting for a file that would error.
   */
  it("does not prompt for a key no filename reaches", async () => {
    const root = makeProject({ schema: "apiURL: z.url()" });
    const { ask, prompted } = scriptedAsk({});

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]?.subject).toBe("apiURL");
    expect(result.unreachable[0]?.remedy).toContain("Rename");
  });

  /** A parameter the tree already has a value for is not drift, so it is not asked. */
  it("does not prompt for an already-valued parameter", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });
    const { ask, prompted } = scriptedAsk({});

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  /**
   * A schema that does not load is a `config` blocker, not a silent "nothing to
   * do": `fill` refuses and points at `validate`, rather than writing into a tree
   * whose declared shape it could not read.
   */
  it("refuses when the schema does not load", async () => {
    const root = makeProject({ schema: "databaseUrl: z.url()" });
    // A schema module that throws never produces a namespace, so nothing loads.
    writeFileSync(join(root, ".penv", "env.ts"), "throw new Error('boom');\n", "utf8");
    const { ask, prompted } = scriptedAsk({});

    await expect(runFill({ cwd: root, environment: "production", ask })).rejects.toMatchObject({
      code: "FILL_BLOCKED",
    });
    expect(prompted).toEqual([]);
  });

  /**
   * A tree that already fails validation for a structural reason is one `fill`
   * must not write into: two files colliding on one generated variable would drop
   * a value on `generate`, so `fill` refuses and writes nothing — it does not fill
   * the unrelated gap and report a green success over a broken tree.
   */
  it("refuses and writes nothing when the tree has a name collision", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      // `redis/host` and `redis-host` both generate REDIS_HOST — a collision.
      tree: { "redis/host": "one", "redis-host": "two" },
    });
    const { ask, prompted } = scriptedAsk({ "database-url": "postgres://localhost/app" });

    await expect(runFill({ cwd: root, environment: "production", ask })).rejects.toMatchObject({
      code: "FILL_BLOCKED",
    });
    expect(prompted).toEqual([]);
    // The unrelated missing parameter was never written despite an answer being ready.
    await expect(
      runGet({ cwd: root, key: "database-url", environment: "production" }),
    ).rejects.toBeInstanceOf(PenvError);
  });

  /**
   * The namespace path: `redis: { password }` is the parameter `redis/password`,
   * and the prompt carries that slashed key — never `redis.password` — so the
   * value lands at `.penv/redis/password.<env>` where the cascade reads it.
   */
  it("fills a namespaced parameter under its slashed key", async () => {
    const root = makeProject({ schema: "redis: z.object({ password: z.string() })" });
    const { ask, prompted } = scriptedAsk({ "redis/password": "s3cret" });

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(prompted.map((prompt) => prompt.parameter)).toEqual(["redis/password"]);
    expect(result.written).toEqual([
      { parameter: "redis.password", location: "redis/password.production", encrypted: false },
    ]);
    await expect(
      runGet({ cwd: root, key: "redis/password", environment: "production" }),
    ).resolves.toBe("s3cret");
  });

  /**
   * `fill` owns neither the write nor the seal — it hands the value to `runSet`,
   * which seals per meta. So a parameter meta marks secret is written encrypted,
   * and the result says so, exactly as a `penv set` of the same parameter would.
   */
  it("seals a parameter its meta marks secret", async () => {
    process.env[KEY_VARIABLE] = freshKey();
    const root = makeProject({
      schema: "dbPassword: z.string()",
      tree: { "db-password.json": JSON.stringify({ secret: true }) },
    });
    const { ask } = scriptedAsk({ "db-password": "hunter2" });

    const result = await runFill({ cwd: root, environment: "production", ask });

    expect(result.written).toEqual([
      { parameter: "db-password", location: "db-password.production.enc", encrypted: true },
    ]);
    await expect(
      runGet({ cwd: root, key: "db-password", environment: "production" }),
    ).resolves.toBe("hunter2");
  });
});
