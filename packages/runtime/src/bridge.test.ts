/**
 * The two refusals the typed bridge is responsible for, and their copy.
 *
 * Both are sealed in the PRD (friction item 10) because they are the two a
 * newcomer meets first — a teammate who cloned and has not pulled, and someone
 * starting an adopted app the way they always started it. The strings are
 * asserted verbatim here, so changing either is a deliberate act rather than a
 * refactor's side effect.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DirectStartError, MissingMaterializationError, recordsDir } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { RUN_MARKER, resetRunMarker } from "./child-env.js";
import { load } from "./load.js";

const created: string[] = [];
const originalMarker = process.env[RUN_MARKER];
const originalArgv = process.argv;

/** Development's values live in a provider, so pulling them is a real thing to do. */
const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-vault", location: "secret/app" },
    production: { type: "@penvhq/provider-vault", location: "secret/app" },
  },
};

/** The other cohort: the local tree is the source of truth, so there is nothing to pull. */
const LOCAL_CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

const schema = z.object({
  databaseUrl: z.url(),
  redis: z.object({ host: z.string(), password: z.string().optional() }),
});

/**
 * A tree that was pulled and is still one parameter short. `redis/password`
 * keeps the namespace present, so the schema reports the leaf `redis.host`
 * rather than the whole of `redis`.
 */
const PARTLY_FILLED: Readonly<Record<string, string>> = {
  "database-url": "postgres://local/app",
  "redis/password": "hunter2",
};

function makeProject(files: Readonly<Record<string, string>>, config: unknown = CONFIG): string {
  const root = mkdtempSync(join(tmpdir(), "penv-bridge-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
    "utf8",
  );
  for (const [name, value] of Object.entries(files)) {
    const file = join(recordsDir(root), name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  }
  return root;
}

function loadFails(cwd: string): unknown {
  try {
    load(schema, { cwd, environment: "development" });
  } catch (error) {
    return error;
  }
  throw new Error("expected load to refuse");
}

afterEach(() => {
  resetRunMarker();
  if (originalMarker === undefined) {
    delete process.env[RUN_MARKER];
  } else {
    process.env[RUN_MARKER] = originalMarker;
  }
  process.argv = originalArgv;
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the first missing pull", () => {
  /** Sealed copy. The two halves join as `No materialized values for development. Run: penv pull`. */
  it("names the environment and the one command, and nothing else", () => {
    const error = loadFails(makeProject({}));

    expect(error).toBeInstanceOf(MissingMaterializationError);
    expect((error as MissingMaterializationError).message.split("\n")[0]).toBe(
      "No materialized values for development",
    );
    expect((error as MissingMaterializationError).remedy).toBe("Run: penv pull");
  });

  /**
   * The negative case, and the reason the two refusals are different objects: a
   * tree that holds *something* is a tree that was pulled, so a gap in it is not
   * a missing pull.
   */
  it("is not what a partly-filled tree gets", () => {
    const error = loadFails(makeProject(PARTLY_FILLED));

    expect(error).not.toBeInstanceOf(MissingMaterializationError);
  });

  /**
   * The other negative case: an environment backed by the local tree has nowhere
   * to pull from, so `penv pull` would be a command with nothing to do — the
   * remedy there is to set the values, not to fetch them.
   */
  it("is not what a local-only project gets", () => {
    const error = loadFails(makeProject({}, LOCAL_CONFIG));

    expect(error).not.toBeInstanceOf(MissingMaterializationError);
  });
});

describe("a direct start, outside penv run", () => {
  /** Sealed copy: the missing parameter, and the exact `penv run --` shape. */
  it("names the missing parameter and the command to start it with", () => {
    process.argv = ["/usr/bin/node", "index.js"];
    const error = loadFails(makeProject(PARTLY_FILLED));

    expect(error).toBeInstanceOf(DirectStartError);
    const refusal = error as DirectStartError;
    expect(refusal.message.split("\n")[0]).toBe(
      "Missing required parameter redis.host for environment development, " +
        "and this process was not started by `penv run`",
    );
    expect(refusal.remedy).toBe("Start it with `penv run -- node index.js`.");
  });

  /** It is still the validation failure it always was, issues and all. */
  it("carries the schema issues, so nothing downstream loses them", () => {
    const error = loadFails(makeProject(PARTLY_FILLED));

    expect((error as DirectStartError).issues.map((issue) => issue.parameter)).toEqual([
      "redis.host",
    ]);
  });

  /**
   * Inside `penv run` the environment was prepared by penv, so a failure there is
   * about the values — telling that reader to use `penv run` would be telling
   * them to do what they just did.
   */
  it("is not what a process penv started hears", () => {
    process.env[RUN_MARKER] = "penv run -- node index.js";
    resetRunMarker();

    const error = loadFails(makeProject(PARTLY_FILLED));

    expect(error).not.toBeInstanceOf(DirectStartError);
    expect((error as Error).message).toContain("does not match the schema");
  });

  /** A value the schema rejects is not a missing one, whoever started the process. */
  it("is not what an invalid value gets", () => {
    const error = loadFails(
      makeProject({ "database-url": "not-a-url", "redis/host": "127.0.0.1" }),
    );

    expect(error).not.toBeInstanceOf(DirectStartError);
  });
});

describe("the run marker, from the application's side", () => {
  /**
   * The ordering the seal asks for, seen from the other end: a nested penv finds
   * the marker because it checks before anything loads, and the application never
   * does because loading is its first act.
   */
  it("is gone from process.env once the bridge has read it", () => {
    process.env[RUN_MARKER] = "penv run -- node index.js";
    resetRunMarker();
    const cwd = makeProject({ "database-url": "postgres://local/app", "redis/host": "127.0.0.1" });

    load(schema, { cwd, environment: "development" });

    expect(process.env[RUN_MARKER]).toBeUndefined();
  });
});
