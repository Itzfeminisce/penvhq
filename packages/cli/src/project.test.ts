/**
 * `describeResolution` answers the question `penv get --explain` exists to ask:
 * which file wins, and why did the others not. "Why not" includes candidates the
 * cascade never even read — invariant 4 skips `.local` in `test`, and a
 * developer whose override is being ignored is precisely the person running
 * `--explain`. A row that is missing from the explanation is an unanswered
 * question, so these tests assert the skipped rows are there.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFilesystemProvider } from "@penv/provider-filesystem";
import { afterEach, describe, expect, it } from "vitest";
import { runExplain } from "./commands/get.js";
import { describeResolution } from "./project.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../node_modules/.penv-test/", import.meta.url));

const CONFIG = {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};

const created: string[] = [];

function makeProject(tree: Readonly<Record<string, string>>): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "project-"));
  created.push(root);

  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    'import { z } from "zod";\nexport const schema = z.object({});\n',
    "utf8",
  );
  for (const [name, contents] of Object.entries(tree)) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return root;
}

function providerFor(root: string) {
  return createFilesystemProvider({ root: join(root, ".penv"), config: CONFIG });
}

const API_KEY = { namespace: ["api"], name: "key" };

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("describeResolution in the test environment", () => {
  /** The finding: a present `.local` file that was skipped must say so. */
  it("reports the skipped .local candidate", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    const local = resolution.candidates.find((c) => c.location === "api/key.local");
    expect(local).toBeDefined();
    expect(local?.skippedReason).toBe("local-skipped-in-test");
    expect(resolution.winner?.location).toBe("api/key");
    expect(resolution.value).toBe("shared");
  });

  /** Skipped means never read, so it is reported as absent rather than losing. */
  it("does not report the skipped .local candidate as merely lower-precedence", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    const local = resolution.candidates.find((c) => c.location === "api/key.local");
    expect(local?.skippedReason).not.toBe("lower-precedence");
  });

  it("reports the skipped .local candidate even when no .local file exists", async () => {
    const root = makeProject({ "api/key": "shared" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    expect(resolution.candidates.map((c) => c.location)).toContain("api/key.local");
  });

  /** The negative: outside `test`, `.local` is considered and there is nothing to skip. */
  it("lets .local win outside the test environment", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const resolution = await describeResolution(API_KEY, "development", providerFor(root));

    expect(resolution.winner?.location).toBe("api/key.local");
    expect(resolution.value).toBe("mine");
    expect(resolution.candidates.every((c) => c.skippedReason !== "local-skipped-in-test")).toBe(
      true,
    );
  });
});

describe("describeResolution with an encrypted winner", () => {
  /**
   * The one thing core refuses and this must not: `--explain` and `doctor`'s
   * plaintext-secret check ask which file wins, not what it says, and both have
   * to be able to see an `.enc` winner rather than be stopped by it.
   */
  it("describes the winner instead of refusing it", async () => {
    // Only the encrypted file: within one scope the plaintext is considered
    // first, so a plaintext sibling would legitimately win and prove nothing.
    const root = makeProject({ "api/key.enc": "ciphertext" });

    const resolution = await describeResolution(API_KEY, "production", providerFor(root));

    expect(resolution.winner?.location).toBe("api/key.enc");
    // Present, and unreadable: it wins, and it has no value here.
    expect(resolution.value).toBeUndefined();
  });

  /** The two fixes meet: an encrypted winner in `test` still reports the skip. */
  it("still reports the skipped .local candidate in the test environment", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key.enc": "ciphertext" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    const local = resolution.candidates.find((c) => c.location === "api/key.local");
    expect(local?.skippedReason).toBe("local-skipped-in-test");
    expect(resolution.winner?.location).toBe("api/key.enc");
  });

  /**
   * Both `.local` scopes are skipped in `test`, so both must leave a row on this
   * path too — the walk here is separate from core's and can drop rows on its own.
   */
  it("reports the skipped <env>.local candidate as well", async () => {
    const root = makeProject({ "api/key.test.local": "mine-in-test", "api/key.enc": "ciphertext" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    const local = resolution.candidates.find((c) => c.location === "api/key.test.local");
    expect(local?.skippedReason).toBe("local-skipped-in-test");
  });

  /**
   * The skipped rows name the environment being explained. They cannot be
   * recovered from another environment's cascade any more: `<name>.<env>.local`
   * carries the environment in the filename, so a stand-in environment would
   * print a file that cannot exist.
   */
  it("names the skipped rows with the environment being resolved", async () => {
    const root = makeProject({ "api/key.enc": "ciphertext" });

    const resolution = await describeResolution(API_KEY, "test", providerFor(root));

    expect(resolution.candidates.map((c) => c.location)).toContain("api/key.test.local");
    expect(resolution.candidates.every((c) => !c.location.includes("not-test"))).toBe(true);
  });
});

describe("describeResolution across all four levels", () => {
  /** Dropping a level widens scope; the order is the whole contract. */
  it("prefers <env>.local over .local over <env> over the unscoped default", async () => {
    const tree: Record<string, string> = {
      "api/key.production.local": "mine-in-prod",
      "api/key.local": "mine",
      "api/key.production": "shared-prod",
      "api/key": "fallback",
    };
    const expected = ["api/key.production.local", "api/key.local", "api/key.production", "api/key"];

    for (const [index, winner] of expected.entries()) {
      const root = makeProject(Object.fromEntries(Object.entries(tree).slice(index)));

      const resolution = await describeResolution(API_KEY, "production", providerFor(root));

      expect(resolution.winner?.location).toBe(winner);
      expect(resolution.value).toBe(tree[winner]);
    }
  });

  /** Only the unscoped default is a fallback; a `.local` winner is a deliberate override. */
  it("does not call an <env>.local winner an unscoped fallback", async () => {
    const root = makeProject({ "api/key.production.local": "mine-in-prod" });

    const resolution = await describeResolution(API_KEY, "production", providerFor(root));

    expect(resolution.viaUnscopedFallback).toBe(false);
  });

  it("still calls an unscoped winner a fallback", async () => {
    const root = makeProject({ "api/key": "fallback" });

    const resolution = await describeResolution(API_KEY, "production", providerFor(root));

    expect(resolution.viaUnscopedFallback).toBe(true);
  });
});

describe("penv get --explain --env test", () => {
  /**
   * The end-to-end shape of the finding: the render branch for the skipped row
   * was dead code, because nothing ever produced the row it renders.
   */
  it("tells the developer their .local file was skipped", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "test" });

    const local = explanation.candidates.find((c) => c.location === "api/key.local");
    expect(local?.skipped).toBe("skipped, .local never applies in test");
    expect(explanation.location).toBe("api/key");
  });
});
