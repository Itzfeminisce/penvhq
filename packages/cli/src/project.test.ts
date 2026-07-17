/**
 * `penv get --explain` answers the question it exists to ask: which file wins,
 * and why did the others not. "Why not" includes candidates the cascade never
 * even read — invariant 4 skips `.local` in `test`, and a developer whose
 * override is being ignored is precisely the person running `--explain`. A row
 * that is missing from the explanation is an unanswered question, so these tests
 * assert the skipped rows are there.
 *
 * They drive `runExplain` rather than a walker beneath it. The CLI used to own a
 * second cascade walk, which existed only because core refused an `.enc` winner
 * instead of describing one; that walk is what silently dropped these rows in the
 * first place. Core describes the winner now, the second walk is gone, and these
 * tests point at the surface a user actually types — which is the only place the
 * rows can still go missing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExplain } from "./commands/get.js";

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

const API_KEY = "api/key";

/** The rendered skip reason, so a test names what a reader of `--explain` sees. */
const SKIPPED_IN_TEST = "skipped, .local never applies in test";

function explain(root: string, environment: string) {
  return runExplain({ cwd: root, key: API_KEY, environment });
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("--explain in the test environment", () => {
  /** The finding: a present `.local` file that was skipped must say so. */
  it("reports the skipped .local candidate", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const explanation = await explain(root, "test");

    const local = explanation.candidates.find((c) => c.location === "api/key.local");
    expect(local).toBeDefined();
    expect(local?.skipped).toBe(SKIPPED_IN_TEST);
    expect(explanation.location).toBe("api/key");
  });

  it("reports the skipped .local candidate even when no .local file exists", async () => {
    const root = makeProject({ "api/key": "shared" });

    const explanation = await explain(root, "test");

    expect(explanation.candidates.map((c) => c.location)).toContain("api/key.local");
  });

  /**
   * The skipped rows name the environment being explained. They cannot be
   * recovered from another environment's cascade: `<name>.<env>.local` carries
   * the environment in the filename, so a stand-in environment would print a file
   * that cannot exist.
   */
  it("names the skipped rows with the environment being resolved", async () => {
    const root = makeProject({ "api/key": "shared" });

    const explanation = await explain(root, "test");

    expect(explanation.candidates.map((c) => c.location)).toContain("api/key.test.local");
    expect(explanation.candidates.every((c) => !c.location.includes("not-test"))).toBe(true);
  });

  /** The negative: outside `test`, `.local` is considered and there is nothing to skip. */
  it("lets .local win outside the test environment", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key": "shared" });

    const explanation = await explain(root, "development");

    expect(explanation.location).toBe("api/key.local");
    expect(explanation.candidates.every((c) => c.skipped !== SKIPPED_IN_TEST)).toBe(true);
  });
});

describe("--explain with an encrypted winner", () => {
  /**
   * The one thing a command asking for a *value* refuses and this must not:
   * `--explain` asks which file wins, not what it says, so it has to see an
   * `.enc` winner rather than be stopped by it — including with no key at all,
   * which is exactly when someone runs it.
   */
  it("describes the winner instead of refusing it", async () => {
    // Only the encrypted file: within one scope the plaintext is considered
    // first, so a plaintext sibling would legitimately win and prove nothing.
    const root = makeProject({ "api/key.enc": "ciphertext" });

    const explanation = await explain(root, "production");

    expect(explanation.location).toBe("api/key.enc");
    expect(explanation.undecryptable).toBeDefined();
  });

  /**
   * A winner that did not open is still the winner, and the plaintext below it
   * still loses. Promoting the loser because the winner was unreadable would hand
   * production the unscoped default — the scope-widening leak the cascade exists
   * to refuse, arriving by way of a missing key.
   *
   * The sealed file sits at a *higher* scope than the plaintext deliberately:
   * within one scope the plaintext twin is considered first, so a sibling at the
   * same scope would legitimately win and prove nothing.
   */
  it("does not report the unopened winner as a skipped candidate", async () => {
    const root = makeProject({ "api/key.production.enc": "ciphertext", "api/key": "fallback" });

    const explanation = await explain(root, "production");

    const winner = explanation.candidates.find((c) => c.location === "api/key.production.enc");
    expect(winner?.wins).toBe(true);
    expect(winner?.skipped).toBeUndefined();
    expect(explanation.location).toBe("api/key.production.enc");
    expect(explanation.undecryptable).toBeDefined();
  });

  /** The two fixes meet: an encrypted winner in `test` still reports the skip. */
  it("still reports the skipped .local candidate in the test environment", async () => {
    const root = makeProject({ "api/key.local": "mine", "api/key.enc": "ciphertext" });

    const explanation = await explain(root, "test");

    const local = explanation.candidates.find((c) => c.location === "api/key.local");
    expect(local?.skipped).toBe(SKIPPED_IN_TEST);
    expect(explanation.location).toBe("api/key.enc");
  });

  /**
   * Both `.local` scopes are skipped in `test`, so both must leave a row here too.
   */
  it("reports the skipped <env>.local candidate as well", async () => {
    const root = makeProject({ "api/key.test.local": "mine-in-test", "api/key.enc": "ciphertext" });

    const explanation = await explain(root, "test");

    const local = explanation.candidates.find((c) => c.location === "api/key.test.local");
    expect(local?.skipped).toBe(SKIPPED_IN_TEST);
  });
});

describe("--explain across all four levels", () => {
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

      const explanation = await explain(root, "production");

      expect(explanation.location).toBe(winner);
    }
  });
});
