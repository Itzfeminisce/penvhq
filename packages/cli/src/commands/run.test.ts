/**
 * `penv run` is the command an adopted project starts through, so what it must
 * be trusted with is: the command after `--` reaching the operating system
 * unchanged, an environment penv owns rather than decorates, a refusal before
 * anything starts, and no provider contacted on the way.
 *
 * The spawning tests use a real child — a small node process that writes back
 * the argv and environment it was given — because argument boundaries and
 * variable ownership are properties of what actually crosses the process
 * boundary, and a mocked spawn would assert penv's own intentions instead.
 * Everything else uses the injected seams, so a refusal or a `--watch` cycle is
 * decided rather than timed.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordsDir } from "@penvhq/core";
import { RUN_MARKER } from "@penvhq/runtime";
import { runCommand as runCittyCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildHandle } from "../child.js";
import type { PullOptions, PullResult } from "./pull.js";
import type { RunOptions, RunResult } from "./run.js";
import { runCommand, runRun } from "./run.js";

/**
 * Counts every construction of the mock provider, which is the only provider a
 * fixture here declares as an environment's source of truth. A run that
 * contacted one would have built it, so zero is the network-forbidden proof.
 */
const constructions = vi.hoisted(() => ({ count: 0 }));

vi.mock("@penvhq/provider-mock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penvhq/provider-mock")>();
  return {
    ...actual,
    createMockProvider: (...args: Parameters<typeof actual.createMockProvider>) => {
      constructions.count += 1;
      return actual.createMockProvider(...args);
    },
  };
});

/** Fixture projects live under `node_modules` so a fixture's `import { z } from "zod"` resolves. */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

/** Development's values live in a provider, so there is something to pull from. */
const REMOTE_CONFIG = {
  ...CONFIG,
  providers: { ...CONFIG.providers, development: { type: "@penvhq/provider-mock" } },
};

const SCHEMA =
  "databaseUrl: z.string(), redis: z.object({ password: z.string().optional() }).optional()";

const TREE: Readonly<Record<string, string>> = { "database-url": "postgres://local/app" };

const created: string[] = [];
const originalCwd = process.cwd();
const originalPenvEnv = process.env.PENV_ENV;
const originalNodeEnv = process.env.NODE_ENV;

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
  readonly config?: unknown;
  /** Meta files, keyed the way the tree is: `api-key.json`. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

function makeProject(fixture: Fixture = {}): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "run-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(fixture.config ?? CONFIG)};\n`,
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
  for (const [name, contents] of Object.entries(fixture.tree ?? TREE)) {
    const file = join(recordsDir(root), name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  for (const [name, contents] of Object.entries(fixture.meta ?? {})) {
    writeFileSync(join(recordsDir(root), name), JSON.stringify(contents), "utf8");
  }
  return root;
}

/** A child that reports what it was given, then exits with the code it was told to. */
function reporter(out: string, exitCode = 0): string[] {
  const script =
    "const fs = require('fs');" +
    "fs.writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), env: process.env }));" +
    `process.exit(${exitCode});`;
  return [process.execPath, "-e", script, out];
}

interface Reported {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

function reported(out: string): Reported {
  return JSON.parse(readFileSync(out, "utf8")) as Reported;
}

/** A run with no ambient environment behind it — every fixture states its own host. */
function run(options: RunOptions): Promise<RunResult> {
  return runRun({ host: { PATH: process.env.PATH ?? "" }, ...options });
}

function refusalFrom(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; remedy?: string }> {
  return promise.then(
    () => {
      throw new Error("expected penv run to refuse");
    },
    (error: { code: string; message: string; remedy?: string }) => error,
  );
}

/** A child that runs until the test lets it end. */
function pending(): ChildHandle & { end: (result?: { exitCode: number }) => void } {
  let finish: (value: { exitCode: number; signal: null }) => void = () => undefined;
  const ended = new Promise<{ exitCode: number; signal: null }>((resolve) => {
    finish = resolve;
  });
  return {
    ended,
    kill: () => finish({ exitCode: 0, signal: null }),
    end: (result) => finish({ exitCode: result?.exitCode ?? 0, signal: null }),
  };
}

/**
 * The runner's own `NODE_ENV=test` is an environment these fixtures do not
 * declare, and how `--env` is settled is one of the things under test — so the
 * ambient answer is cleared and each test states what it means.
 */
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
  constructions.count = 0;
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the command after --", () => {
  it("reaches the child with its argument boundaries intact", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    const result = await run({
      cwd: root,
      environment: "development",
      command: [...reporter(out), "a b", "--flag", "-e", ""],
    });

    expect(reported(out).argv).toEqual(["a b", "--flag", "-e", ""]);
    expect(result.exitCode).toBe(0);
  });

  it("forwards the child's exit code", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    const result = await run({
      cwd: root,
      environment: "development",
      command: reporter(out, 3),
    });

    expect(result.exitCode).toBe(3);
  });

  it("forwards the signal a child died from", async () => {
    const root = makeProject();
    const child = {
      ended: Promise.resolve({ exitCode: 1, signal: "SIGTERM" as const }),
      kill: vi.fn(),
    };

    const result = await run({
      cwd: root,
      environment: "development",
      command: ["irrelevant"],
      start: () => child,
    });

    expect(result.signal).toBe("SIGTERM");
  });

  it("refuses when nothing follows --", async () => {
    const root = makeProject();

    const error = await refusalFrom(run({ cwd: root, environment: "development", command: [] }));

    expect(error.code).toBe("RUN_NO_COMMAND");
    expect(error.remedy).toContain("penv run -- pnpm dev");
  });
});

describe("the command line", () => {
  /**
   * Through the real command, because where `--` falls is the whole contract:
   * the command is taken from the raw arguments, so a flag *after* `--` is the
   * child's and a flag before it is penv's.
   */
  it("splits at --, leaving penv's flags on penv's side", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");
    process.chdir(root);
    process.exitCode = 0;
    try {
      await runCittyCommand(runCommand, {
        rawArgs: ["--env", "development", "--", ...reporter(out), "--env", "production"],
      });
      expect(reported(out).argv).toEqual(["--env", "production"]);
      expect(reported(out).env.PENV_ENV).toBe("development");
      expect(process.exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = 0;
    }
  });

  it("exits with the child's code", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");
    process.chdir(root);
    process.exitCode = 0;
    try {
      await runCittyCommand(runCommand, {
        rawArgs: ["--env", "development", "--", ...reporter(out, 4)],
      });
      expect(process.exitCode).toBe(4);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = 0;
    }
  });
});

describe("the environment the child gets", () => {
  it("writes every resolved parameter and leaves unrelated variables alone", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    await run({
      cwd: root,
      environment: "development",
      command: reporter(out),
      host: { PATH: process.env.PATH ?? "", EDITOR: "vim" },
    });

    const { env } = reported(out);
    expect(env.DATABASE_URL).toBe("postgres://local/app");
    expect(env.EDITOR).toBe("vim");
    expect(env.PENV_ENV).toBe("development");
  });

  it("deletes an optional parameter the tree has no value for", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    const result = await run({
      cwd: root,
      environment: "development",
      command: reporter(out),
      host: { PATH: process.env.PATH ?? "", REDIS_PASSWORD: "left over from yesterday" },
    });

    expect(reported(out).env.REDIS_PASSWORD).toBeUndefined();
    expect(result.deleted).toBe(1);
  });

  it("strips penv's key material before the child starts", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    const result = await run({
      cwd: root,
      environment: "development",
      command: reporter(out),
      host: { PATH: process.env.PATH ?? "", PENV_KEY_DEV: "AAAA" },
    });

    expect(reported(out).env.PENV_KEY_DEV).toBeUndefined();
    expect(result.stripped).toContain("PENV_KEY_DEV");
  });

  it("marks the child, so a nested penv can see the wrapper it is inside", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    await run({ cwd: root, environment: "development", command: reporter(out) });

    expect(reported(out).env[RUN_MARKER]).toContain("penv run --env development --");
  });
});

describe("a nested run", () => {
  /** Seal 1: the outer wrapper and the inner one are both named. */
  it("refuses, naming both invocations", async () => {
    const root = makeProject();

    const error = await refusalFrom(
      run({
        cwd: root,
        environment: "development",
        command: ["next", "dev"],
        host: { PATH: "", [RUN_MARKER]: "penv run --env development -- pnpm dev" },
      }),
    );

    expect(error.code).toBe("RUN_NESTED");
    expect(error.message).toContain("penv run --env development -- next dev");
    expect(error.message).toContain("penv run --env development -- pnpm dev");
    expect(error.remedy).toContain("penv run --env development -- pnpm dev");
  });

  /** The negative case: an unmarked environment is an ordinary first wrapper. */
  it("starts normally when no outer wrapper marked the environment", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    await expect(
      run({ cwd: root, environment: "development", command: reporter(out) }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("--source", () => {
  it("defaults to the project tree", async () => {
    const root = makeProject();
    const out = join(root, "reported.json");

    const result = await run({ cwd: root, environment: "development", command: reporter(out) });

    expect(result.source).toBe("project");
  });

  /** Seal 2: `snapshot` is grammar, and this engine says plainly that it cannot open one. */
  it("refuses snapshot by naming the artifact, not by half-reading one", async () => {
    const root = makeProject();

    const error = await refusalFrom(
      run({ cwd: root, environment: "development", source: "snapshot", command: ["node", "x.js"] }),
    );

    expect(error.code).toBe("RUN_SOURCE_SNAPSHOT");
    expect(error.message).toContain("sealed deployment artifact");
    expect(error.remedy).toContain("penv run --env development -- node x.js");
  });

  it("refuses a source it has never heard of", async () => {
    const root = makeProject();

    const error = await refusalFrom(
      run({ cwd: root, environment: "development", source: "provider", command: ["node", "x.js"] }),
    );

    expect(error.code).toBe("RUN_SOURCE_UNKNOWN");
    expect(error.remedy).toContain("`project`");
  });
});

describe("--env", () => {
  /** Seal 3: the declared default is what makes `penv run -- pnpm dev` the daily form. */
  it("falls back to the config's defaultEnvironment", async () => {
    const root = makeProject({ config: { ...CONFIG, defaultEnvironment: "development" } });
    const out = join(root, "reported.json");

    const result = await run({ cwd: root, command: reporter(out) });

    expect(result.environment).toBe("development");
  });

  it("refuses with both remedies when neither the flag nor the default answers", async () => {
    const root = makeProject();

    const error = await refusalFrom(run({ cwd: root, command: ["node", "x.js"] }));

    expect(error.remedy).toContain("--env <environment>");
    expect(error.remedy).toContain("defaultEnvironment");
  });
});

describe("the public-prefix policy", () => {
  const PUBLIC = {
    config: { ...CONFIG, publicPrefixes: ["NEXT_PUBLIC_"] },
    schema: "nextPublicToken: z.string()",
    tree: { "next-public-token": "shhh" },
    meta: { "next-public-token.json": { secret: true } },
  };

  it("refuses before the child starts, naming the parameter", async () => {
    const root = makeProject(PUBLIC);
    const start = vi.fn(() => pending());

    const error = await refusalFrom(
      run({ cwd: root, environment: "development", command: ["node", "x.js"], start }),
    );

    expect(error.code).toBe("RUN_PUBLIC_SECRET");
    expect(error.message).toContain("next-public-token");
    expect(error.message).toContain("NEXT_PUBLIC_TOKEN");
    expect(start).not.toHaveBeenCalled();
  });

  /** The negative case: the same name, not declared secret, is just a public variable. */
  it("stays quiet when the parameter's meta does not call it a secret", async () => {
    const root = makeProject({ ...PUBLIC, meta: { "next-public-token.json": { secret: false } } });
    const out = join(root, "reported.json");

    await expect(
      run({ cwd: root, environment: "development", command: reporter(out) }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe("a tree nothing has been pulled into", () => {
  /** Sealed copy, from the command side this time. */
  it("names the environment and the one command", async () => {
    const root = makeProject({ config: REMOTE_CONFIG, tree: {} });

    const error = await refusalFrom(
      run({ cwd: root, environment: "development", command: ["node", "x.js"] }),
    );

    expect(error.code).toBe("NO_MATERIALIZED_VALUES");
    expect(error.message.split("\n")[0]).toBe("No materialized values for development");
    expect(error.remedy).toBe("Run: penv pull");
  });
});

describe("the network", () => {
  /**
   * The whole point of the command: a run reads what is already on disk. The
   * environment here declares the mock provider as its source of truth, and a
   * run that reached for it would have constructed one.
   */
  it("is never touched — no provider is constructed", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const out = join(root, "reported.json");

    await run({ cwd: root, environment: "development", command: reporter(out) });

    expect(constructions.count).toBe(0);
  });

  /** The negative case: `--watch` is the one mode that may sync, and it does. */
  it("is reached under --watch, which is the one mode allowed to sync", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const out = join(root, "reported.json");

    await run({
      cwd: root,
      environment: "development",
      watch: true,
      command: reporter(out),
      changes: () => ({ close: () => undefined }),
    });

    expect(constructions.count).toBeGreaterThan(0);
  });
});

describe("--watch", () => {
  function pulls(): { seam: (options: PullOptions) => Promise<PullResult>; calls: PullOptions[] } {
    const calls: PullOptions[] = [];
    return {
      calls,
      seam: async (options) => {
        calls.push(options);
        return {
          environment: options.environment ?? "development",
          source: "@penvhq/provider-mock",
          localSource: false,
          values: 0,
          meta: 0,
          refs: 0,
        };
      },
    };
  }

  it("is opt-in: a plain run pulls nothing", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const out = join(root, "reported.json");
    const { seam, calls } = pulls();

    await run({ cwd: root, environment: "development", command: reporter(out), pull: seam });

    expect(calls).toEqual([]);
  });

  it("syncs before it starts the child", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const out = join(root, "reported.json");
    const { seam, calls } = pulls();

    await run({
      cwd: root,
      environment: "development",
      watch: true,
      command: reporter(out),
      pull: seam,
      changes: () => ({ close: () => undefined }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.environment).toBe("development");
  });

  it("replaces the child when the tree changes", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const { seam } = pulls();
    const children = [pending(), pending()];
    let started = 0;
    let fire: () => void = () => undefined;

    const finished = run({
      cwd: root,
      environment: "development",
      watch: true,
      command: ["node", "x.js"],
      pull: seam,
      start: () => children[started++] as ChildHandle,
      changes: (onChange) => {
        fire = onChange;
        return { close: () => undefined };
      },
    });

    // The first child is running; a change replaces it, and the second child's
    // ending is what ends the run.
    await vi.waitFor(() => expect(started).toBe(1));
    fire();
    await vi.waitFor(() => expect(started).toBe(2));
    children[1]?.end({ exitCode: 7 });

    await expect(finished).resolves.toMatchObject({ exitCode: 7, restarts: 1 });
  });

  /** A provider that will not answer must not take the running child down with it. */
  it("leaves the child running when the sync fails", async () => {
    const root = makeProject({ config: REMOTE_CONFIG });
    const child = pending();
    let started = 0;
    let attempts = 0;
    let fire: () => void = () => undefined;

    const finished = run({
      cwd: root,
      environment: "development",
      watch: true,
      command: ["node", "x.js"],
      pull: async () => {
        attempts += 1;
        throw new Error("the provider is down");
      },
      start: () => {
        started += 1;
        return child;
      },
      changes: (onChange) => {
        fire = onChange;
        return { close: () => undefined };
      },
    });

    // The first sync failed and the child started anyway — a provider being down
    // is not a reason an application cannot start.
    await vi.waitFor(() => expect(started).toBe(1));
    fire();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(started).toBe(1);

    child.end({ exitCode: 0 });
    await expect(finished).resolves.toMatchObject({ exitCode: 0, restarts: 0 });
  });
});
