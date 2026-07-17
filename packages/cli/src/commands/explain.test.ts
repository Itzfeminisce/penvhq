/**
 * `penv get --explain` is the command whose entire job is saying which file won
 * and why the others did not. The cascade has four levels (invariant 4), so an
 * explanation that lists three is not a shorter answer, it is a wrong one: the
 * level it omits is the personal override for one environment, and a developer
 * asking why their `<name>.<env>.local` is being ignored is exactly who runs
 * this. `list` has the same duty in one column — `production.local` and `local`
 * are different files, and printing "local" for both hides which one won.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExplain } from "./get.js";
import { runList } from "./list.js";

const FIXTURE_PARENT = fileURLToPath(new URL("../../node_modules/.penv-test/", import.meta.url));

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
  const root = mkdtempSync(join(FIXTURE_PARENT, "explain-"));
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

/** All four levels present at once, so precedence is the only thing under test. */
const FOUR_LEVELS = {
  "api/key.production.local": "mine-in-prod",
  "api/key.local": "mine",
  "api/key.production": "shared-prod",
  "api/key": "fallback",
};

/** The plaintext rows, in order. `.enc` is orthogonal and only doubles the list. */
function plaintextLocations(candidates: readonly { readonly location: string }[]): string[] {
  return candidates.map((c) => c.location).filter((location) => !location.endsWith(".enc"));
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("penv get --explain", () => {
  it("lists all four cascade levels, most specific first", async () => {
    const root = makeProject(FOUR_LEVELS);

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "production" });

    expect(plaintextLocations(explanation.candidates)).toEqual([
      "api/key.production.local",
      "api/key.local",
      "api/key.production",
      "api/key",
    ]);
  });

  it("marks the environment-scoped personal override as the winner", async () => {
    const root = makeProject(FOUR_LEVELS);

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "production" });

    expect(explanation.location).toBe("api/key.production.local");
    expect(explanation.candidates.filter((c) => c.wins).map((c) => c.location)).toEqual([
      "api/key.production.local",
    ]);
  });

  /**
   * The wording is "a higher-precedence file", not "a more specific scope",
   * because the loser is not always at a lower scope: within one scope the
   * plaintext file is considered before its `.enc` twin, so a skipped candidate
   * can sit at the same scope as the winner. Every one of these three genuinely
   * is at a lower scope — and the line still has to be true for the twin that
   * is not, or it sends that reader hunting for a scope that does not exist.
   */
  it("says the levels below the winner were passed over", async () => {
    const root = makeProject(FOUR_LEVELS);

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "production" });

    for (const location of ["api/key.local", "api/key.production", "api/key"]) {
      const candidate = explanation.candidates.find((c) => c.location === location);
      expect(candidate?.skipped).toBe("skipped, a higher-precedence file wins");
    }
  });

  /** The negative: with the override gone, the next level down wins — order, not luck. */
  it("falls to <name>.local once the environment-scoped override is absent", async () => {
    const root = makeProject({
      "api/key.local": "mine",
      "api/key.production": "shared-prod",
      "api/key": "fallback",
    });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "production" });

    expect(explanation.location).toBe("api/key.local");
  });
});

describe("penv get --explain --env test", () => {
  it("reports both .local levels as skipped", async () => {
    const root = makeProject({
      "api/key.test.local": "mine-in-test",
      "api/key.local": "mine",
      "api/key.test": "shared-test",
      "api/key": "fallback",
    });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "test" });

    for (const location of ["api/key.test.local", "api/key.local"]) {
      const candidate = explanation.candidates.find((c) => c.location === location);
      expect(candidate?.skipped).toBe("skipped, .local never applies in test");
    }
    expect(explanation.location).toBe("api/key.test");
  });

  it("reports both .local levels even when neither file exists", async () => {
    const root = makeProject({ "api/key": "fallback" });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "test" });

    const locations = explanation.candidates.map((c) => c.location);
    expect(locations).toContain("api/key.test.local");
    expect(locations).toContain("api/key.local");
  });

  /**
   * The skipped row names the file the developer actually wrote. Recovering these
   * rows from another environment's cascade would print `api/key.not-test.local`,
   * a filename that cannot exist.
   */
  it("names the skipped override with the environment being explained", async () => {
    const root = makeProject({ "api/key.test.local": "mine-in-test", "api/key": "fallback" });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "test" });

    expect(explanation.candidates.map((c) => c.location)).toContain("api/key.test.local");
    expect(explanation.candidates.every((c) => !c.location.includes("not-test"))).toBe(true);
  });

  /** The same, on the encrypted-winner path, which walks the cascade separately. */
  it("reports both .local levels when the winner is encrypted", async () => {
    const root = makeProject({ "api/key.test.local": "mine-in-test", "api/key.enc": "ciphertext" });

    const explanation = await runExplain({ cwd: root, key: "api.key", environment: "test" });

    for (const location of ["api/key.test.local", "api/key.local"]) {
      const candidate = explanation.candidates.find((c) => c.location === location);
      expect(candidate?.skipped).toBe("skipped, .local never applies in test");
    }
    expect(explanation.location).toBe("api/key.enc");
  });
});

describe("penv list", () => {
  /** The point of the column: which level won, not merely that something did. */
  it("distinguishes the two .local scopes", async () => {
    const root = makeProject({
      "one.production.local": "a",
      "two.local": "b",
      "three.production": "c",
      four: "d",
    });

    const result = await runList({ cwd: root, environment: "production" });
    const scopes = new Map(result.parameters.map((entry) => [entry.parameter, entry.scope]));

    expect(scopes.get("one")).toBe("production.local");
    expect(scopes.get("two")).toBe("local");
    expect(scopes.get("three")).toBe("production");
    expect(scopes.get("four")).toBe("default");
  });

  /**
   * The bug this class of switch produced: a new scope with no case of its own
   * formatted as the unscoped default, so `list` would have called a personal
   * override a shared fallback.
   */
  it("does not call the environment-scoped override a default", async () => {
    const root = makeProject({ "api/key.production.local": "mine-in-prod" });

    const result = await runList({ cwd: root, environment: "production" });

    expect(result.parameters[0]?.scope).toBe("production.local");
    expect(result.parameters[0]?.viaUnscopedFallback).toBe(false);
  });

  it("renders the winning scope in the table", async () => {
    const root = makeProject({ "api/key.production.local": "mine-in-prod" });

    const result = await runList({ cwd: root, environment: "production" });

    expect(result.parameters[0]?.location).toBe("api/key.production.local");
  });
});
