import { describe, expect, it } from "vitest";
import { GithubUnavailableError } from "./errors.js";
import { createGithubProvider, GhInvocationError, type GhRunner } from "./github.js";

interface Call {
  readonly args: string[];
  readonly input: string | undefined;
}

/** A runner that records what it was asked and answers from a canned table. */
function recording(responses: Readonly<Record<string, string>> = {}): {
  run: GhRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: GhRunner = (args, input) => {
    calls.push({ args: [...args], input });
    return responses[args.join(" ")] ?? "";
  };
  return { run, calls };
}

/** A runner that always fails the way `gh` fails for a given cause. */
function failing(notFound: boolean, status: number | null, stderr: string): GhRunner {
  return (args) => {
    throw new GhInvocationError(notFound, status, stderr, args);
  };
}

/** A runner where `gh auth status` succeeds but every other call fails — an authed but under-scoped token. */
function authOkButFails(stderr: string): GhRunner {
  return (args) => {
    if (args[0] === "auth") {
      return "";
    }
    throw new GhInvocationError(false, 1, stderr, args);
  };
}

describe("GithubProvider.push", () => {
  it("sends the value on stdin and scopes an environment secret with --env", async () => {
    const { run, calls } = recording();
    await createGithubProvider({ repo: "org/app", run }).push("API_URL", "https://x", {
      kind: "environment",
      environment: "production",
    });
    expect(calls[0]?.args).toEqual([
      "secret",
      "set",
      "API_URL",
      "--env",
      "production",
      "--repo",
      "org/app",
    ]);
    expect(calls[0]?.input).toBe("https://x");
  });

  it("omits --env for a repository secret and --repo when none is declared", async () => {
    const { run, calls } = recording();
    await createGithubProvider({ run }).push("SHARED", "v", { kind: "repository" });
    expect(calls[0]?.args).toEqual(["secret", "set", "SHARED"]);
  });

  it("maps a missing gh binary to a loud not-installed refusal", async () => {
    const provider = createGithubProvider({ run: failing(true, null, "") });
    await expect(provider.push("X", "v", { kind: "repository" })).rejects.toBeInstanceOf(
      GithubUnavailableError,
    );
    await expect(provider.push("X", "v", { kind: "repository" })).rejects.toMatchObject({
      reason: "not-installed",
    });
  });

  it("maps an auth failure to not-authenticated", async () => {
    const provider = createGithubProvider({ run: failing(false, 1, "gh auth login required") });
    await expect(provider.push("X", "v", { kind: "repository" })).rejects.toMatchObject({
      reason: "not-authenticated",
    });
  });

  it("maps any other failure to command-failed, carrying gh's own words", async () => {
    const provider = createGithubProvider({
      run: failing(false, 1, "HTTP 404: environment not found"),
    });
    await expect(
      provider.push("X", "v", { kind: "environment", environment: "production" }),
    ).rejects.toMatchObject({ reason: "command-failed" });
  });
});

describe("GithubProvider.list", () => {
  it("parses name and updatedAt from gh's json", async () => {
    const { run } = recording({
      "secret list --repo org/app --json name,updatedAt": JSON.stringify([
        { name: "A", updatedAt: "2026-01-01T00:00:00Z" },
        { name: "B", updatedAt: "2026-02-01T00:00:00Z" },
      ]),
    });
    const secrets = await createGithubProvider({ repo: "org/app", run }).list({
      kind: "repository",
    });
    expect(secrets).toEqual([
      { name: "A", updatedAt: "2026-01-01T00:00:00Z" },
      { name: "B", updatedAt: "2026-02-01T00:00:00Z" },
    ]);
  });

  it("scopes an environment listing with --env", async () => {
    const { run, calls } = recording({
      "secret list --env production --json name,updatedAt": "[]",
    });
    await createGithubProvider({ run }).list({ kind: "environment", environment: "production" });
    expect(calls[0]?.args).toEqual([
      "secret",
      "list",
      "--env",
      "production",
      "--json",
      "name,updatedAt",
    ]);
  });

  it("refuses when gh returns output that is not JSON", async () => {
    const { run } = recording({ "secret list --json name,updatedAt": "not json at all" });
    await expect(createGithubProvider({ run }).list({ kind: "repository" })).rejects.toMatchObject({
      reason: "command-failed",
    });
  });

  it("drops entries missing a name or updatedAt rather than trusting them", async () => {
    const { run } = recording({
      "secret list --json name,updatedAt": JSON.stringify([
        { name: "GOOD", updatedAt: "2026-01-01T00:00:00Z" },
        { name: "NO_TIME" },
        { updatedAt: "2026-01-01T00:00:00Z" },
      ]),
    });
    const secrets = await createGithubProvider({ run }).list({ kind: "repository" });
    expect(secrets).toEqual([{ name: "GOOD", updatedAt: "2026-01-01T00:00:00Z" }]);
  });
});

describe("GithubProvider.verify", () => {
  it("checks gh auth status, then probes that it can reach the repository's secrets", async () => {
    const { run, calls } = recording();
    await createGithubProvider({ repo: "org/app", run }).verify();
    expect(calls[0]?.args).toEqual(["auth", "status"]);
    expect(calls[1]?.args).toEqual(["secret", "list", "--repo", "org/app", "--json", "name"]);
  });

  it("refuses when gh is not installed", async () => {
    await expect(
      createGithubProvider({ run: failing(true, null, "") }).verify(),
    ).rejects.toMatchObject({
      reason: "not-installed",
    });
  });

  it("refuses when gh is not authenticated", async () => {
    await expect(
      createGithubProvider({ run: failing(false, 1, "not logged in") }).verify(),
    ).rejects.toMatchObject({ reason: "not-authenticated" });
  });

  it("refuses before any push when the repository cannot be reached", async () => {
    // Authenticated, but the token cannot reach this repo's secrets (wrong repo,
    // under-scoped). Caught at verify, not mid-push.
    await expect(
      createGithubProvider({
        repo: "org/nope",
        run: authOkButFails("HTTP 404: Not Found"),
      }).verify(),
    ).rejects.toMatchObject({ reason: "command-failed" });
  });
});

describe("GithubProvider capabilities and targets", () => {
  it("declares a projection that withholds values", () => {
    const { run } = recording();
    const provider = createGithubProvider({ repo: "org/app", run });
    expect(provider.capabilities).toEqual({ holds: "projection", readsValues: false });
    expect(provider.type).toBe("@penvhq/provider-github");
  });

  it("answers false for a 404'd environment and true for one that exists", async () => {
    const { run } = recording({ "api repos/org/app/environments/production": "{}" });
    const provider = createGithubProvider({ repo: "org/app", run });
    expect(await provider.targetExists?.("production")).toBe(true);

    const missing = createGithubProvider({
      repo: "org/app",
      run: authOkButFails("HTTP 404: Not Found"),
    });
    expect(await missing.targetExists?.("production")).toBe(false);
  });

  it("creates the environment with an idempotent PUT", async () => {
    const { run, calls } = recording();
    const provider = createGithubProvider({ repo: "org/app", run });
    await provider.ensureTarget?.("production");
    expect(calls[0]?.args).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/org/app/environments/production",
    ]);
  });

  it("resolves the repository from gh once when no location named one", async () => {
    const { run, calls } = recording({
      "repo view --json nameWithOwner --jq .nameWithOwner": "acme/api\n",
    });
    const provider = createGithubProvider({ run });
    await provider.targetExists?.("production");
    await provider.ensureTarget?.("production");
    const views = calls.filter((call) => call.args[0] === "repo");
    expect(views).toHaveLength(1);
    expect(calls.some((call) => call.args.includes("repos/acme/api/environments/production"))).toBe(
      true,
    );
  });
});
