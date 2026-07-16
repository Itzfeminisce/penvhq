/**
 * Watch mode's contract is narrow: a change to something that decides the answer
 * produces a fresh answer, and the answer is `penv validate`'s. These tests
 * drive `runWatch` as an object rather than a process — the handle exists so
 * that a test never has to spawn one, and so that a test always closes it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ValidateResult } from "./validate.js";
import type { WatchHandle } from "./watch.js";
import { runWatch } from "./watch.js";

/**
 * Fixture projects live under the workspace's `node_modules` so that the
 * `import { z } from "zod"` in a fixture `.penv/env.ts` resolves the way it
 * would in a real project — by walking up to a `node_modules` that has zod. A
 * project in the OS temp directory has nothing to walk up to.
 */
const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "production"],
  providers: { development: { type: "filesystem" }, production: { type: "filesystem" } },
};

/** Short enough to keep the tests quick, long enough to still coalesce. */
const DEBOUNCE_MS = 20;

const created: string[] = [];
const handles: WatchHandle[] = [];

interface Fixture {
  readonly tree?: Readonly<Record<string, string>>;
  readonly schema?: string;
}

function makeProject(fixture: Fixture): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "watch-"));
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

/** A watcher, plus the results it has produced so far. */
function watching(root: string): {
  readonly results: ValidateResult[];
  readonly errors: unknown[];
  readonly handle: WatchHandle;
} {
  const results: ValidateResult[] = [];
  const errors: unknown[] = [];
  const handle = runWatch({
    cwd: root,
    environment: "production",
    debounceMs: DEBOUNCE_MS,
    onResult: (result) => results.push(result),
    onError: (error) => errors.push(error),
  });
  handles.push(handle);
  return { results, errors, handle };
}

/** Waits for `check` to hold, so a test never sleeps for a fixed guess. */
async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the watcher");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("watch mode", () => {
  it("validates once at the start, before anything changes", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);

    await until(() => results.length >= 1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.environment).toBe("production");
  });

  /** The finding: a change to the tree re-runs validation. */
  it("re-validates when a value file changes", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);

    writeFileSync(join(root, ".penv", "database-url"), "not-a-url-at-all\n", "utf8");

    await until(() => results.length >= 2);
    // The fresh answer, not a repeat of the first one.
    expect(results[results.length - 1]?.ok).toBe(false);
  });

  it("re-validates when a broken value is fixed again", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "not-a-url-at-all" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);
    expect(results[0]?.ok).toBe(false);

    writeFileSync(join(root, ".penv", "database-url"), "postgres://localhost/app\n", "utf8");

    await until(() => results.some((result) => result.ok));
  });

  /** `penv.config.ts` decides what an environment is, so it decides the answer. */
  it("re-validates when penv.config.ts changes", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);

    writeFileSync(
      join(root, "penv.config.ts"),
      `export default ${JSON.stringify({ ...CONFIG, names: { "database-url": "DB_URL" } })};\n`,
      "utf8",
    );

    await until(() => results.length >= 2);
  });

  /**
   * An editor's atomic save is a write to a temp name and a rename, so the file
   * can be absent for an instant. A watcher that crashed on that would be a
   * watcher that dies the first time someone saves in vim.
   */
  it("survives a file that disappears mid-cycle", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url(), apiKey: z.string().optional()",
      tree: { "database-url": "postgres://localhost/app", "api-key": "k" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);

    rmSync(join(root, ".penv", "api-key"));
    await until(() => results.length >= 2);

    // Still watching, and still answering.
    writeFileSync(join(root, ".penv", "api-key"), "k2\n", "utf8");
    await until(() => results.length >= 3);
    expect(results[results.length - 1]?.ok).toBe(true);
  });

  /**
   * A branch switch to a branch without `.penv/` deletes the watched tree. The
   * platform does not stop that watcher and, on Windows, does not error it
   * either: it re-fires `rename` for the absent path tens of thousands of times
   * a second. Unguarded that pinned a core and reset the debounce on every one
   * of those events, so watch went *silent* while burning CPU — the one thing a
   * watch must never do. Deleting the tree is a change like any other, and
   * `validate` has a verdict for it.
   */
  it("reports the verdict when the watched tree is deleted, instead of spinning", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);
    expect(results[0]?.ok).toBe(true);

    const before = process.cpuUsage();
    rmSync(join(root, ".penv"), { recursive: true, force: true });

    // The deletion is answered, not swallowed.
    await until(() => results.length >= 2);
    expect(results[results.length - 1]?.ok).toBe(false);

    // And answering it did not cost a core. A storm ran at ~100% of one.
    const spent = process.cpuUsage(before);
    const elapsed = (spent.user + spent.system) / 1000;
    expect(elapsed).toBeLessThan(500);
  });

  /** The other half of a branch switch: the tree comes back. */
  it("re-arms and re-validates when the deleted tree returns", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);

    rmSync(join(root, ".penv"), { recursive: true, force: true });
    await until(() => results.some((result) => !result.ok));

    mkdirSync(join(root, ".penv"), { recursive: true });
    writeFileSync(
      join(root, ".penv", "env.ts"),
      `import { z } from "zod";\nexport const schema = z.object({databaseUrl: z.url()});\n`,
      "utf8",
    );
    writeFileSync(join(root, ".penv", "database-url"), "postgres://localhost/app\n", "utf8");

    // A watch that stopped at the deletion would report nothing ever again.
    await until(() => results[results.length - 1]?.ok === true);
  });

  it("coalesces a burst of changes into fewer runs than events", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results } = watching(root);
    await until(() => results.length >= 1);
    const initial = results.length;

    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(root, ".penv", "database-url"), `postgres://localhost/app${i}\n`, "utf8");
    }

    await until(() => results.length > initial);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 10));
    expect(results.length - initial).toBeLessThan(10);
  });

  it("stops reporting once it is closed", async () => {
    const root = makeProject({
      schema: "databaseUrl: z.url()",
      tree: { "database-url": "postgres://localhost/app" },
    });

    const { results, handle } = watching(root);
    await until(() => results.length >= 1);

    handle.close();
    const afterClose = results.length;
    writeFileSync(join(root, ".penv", "database-url"), "postgres://localhost/other\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 10));

    expect(results.length).toBe(afterClose);
  });

  it("close is idempotent", async () => {
    const root = makeProject({ schema: "" });
    const { handle } = watching(root);

    handle.close();
    expect(() => {
      handle.close();
    }).not.toThrow();
  });

  /** A watch on a directory that is not a penv project fails once, not per event. */
  it("refuses to start outside a penv project", () => {
    mkdirSync(FIXTURE_PARENT, { recursive: true });
    const root = mkdtempSync(join(FIXTURE_PARENT, "bare-"));
    created.push(root);

    expect(() => runWatch({ cwd: root, environment: "production" })).toThrow(/penv\.config\.ts/);
  });
});
