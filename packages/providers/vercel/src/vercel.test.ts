/**
 * The Vercel provider's proof. Every call goes through an injected transport, so
 * the suite touches no network: the assertions are about what penv sends, how it
 * partitions Vercel's one target axis into penv's two push scopes, and that every
 * refusal names its own remedy.
 *
 * The behavioural `runProviderContractSuite` is deliberately absent — it is the
 * record contract, over `read`/`write`/`readMeta`, and a projection-holding
 * destination is a different declared kind. The GitHub provider makes the same
 * omission for the same reason.
 */

import type { SecretScope } from "@penvhq/core";
import { describe, expect, it } from "vitest";
import { VercelTargetError, VercelUnavailableError } from "./errors.js";
import { penvProviderFactory } from "./factory.js";
import type { VercelRequest, VercelResponse, VercelTransport } from "./transport.js";
import { defaultVercelTransport } from "./transport.js";
import { createVercelProvider } from "./vercel.js";

const PRODUCTION: SecretScope = { kind: "environment", environment: "production" };
const REPOSITORY: SecretScope = { kind: "repository" };
const TARGETS = { production: "production", staging: "preview" } as const;

interface Answer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** A transport that records what it was asked and answers from a canned queue. */
function recording(answers: Readonly<Record<string, Answer>> = {}): {
  transport: VercelTransport;
  calls: VercelRequest[];
} {
  const calls: VercelRequest[] = [];
  const transport: VercelTransport = async (request) => {
    calls.push(request);
    const answer = answers[request.method] ?? {};
    const response: VercelResponse = {
      status: answer.status ?? (request.method === "POST" ? 201 : 200),
      headers: answer.headers ?? {},
      body: answer.body ?? (request.method === "POST" ? { failed: [] } : { envs: [] }),
    };
    return response;
  };
  return { transport, calls };
}

function provider(answers: Readonly<Record<string, Answer>> = {}, teamId?: string) {
  const { transport, calls } = recording(answers);
  const instance = createVercelProvider({
    project: "prj_app",
    targets: TARGETS,
    transport,
    now: () => 1_700_000_000_000,
    ...(teamId === undefined ? {} : { teamId }),
  });
  return { provider: instance, calls };
}

/** A listing body shaped the way Vercel's list endpoint answers. */
function envs(...entries: readonly Record<string, unknown>[]): Answer {
  return { body: { envs: entries } };
}

describe("VercelProvider.push", () => {
  it("writes an environment's value to the single target that environment declares", async () => {
    const { provider: p, calls } = provider();
    await p.push("API_URL", "https://x", PRODUCTION);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.path).toBe("/v10/projects/prj_app/env");
    expect(post?.body).toEqual({
      key: "API_URL",
      value: "https://x",
      type: "encrypted",
      target: ["production"],
    });
  });

  it("maps a penv environment through the declared mapping, not through its own name", async () => {
    const { provider: p, calls } = provider();
    await p.push("API_URL", "https://x", { kind: "environment", environment: "staging" });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ target: ["preview"] });
  });

  it("spreads the unscoped default across all three targets", async () => {
    const { provider: p, calls } = provider();
    await p.push("SHARED", "v", REPOSITORY);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ target: ["production", "preview", "development"] });
  });

  it("upserts, so a second push of the same variable replaces rather than collides", async () => {
    const { provider: p, calls } = provider({
      GET: envs({ key: "API_URL", type: "encrypted", target: ["production"], updatedAt: 1 }),
    });
    await p.push("API_URL", "next", PRODUCTION);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.query).toMatchObject({ upsert: "true" });
  });

  it("names the team only when one is declared", async () => {
    const withTeam = provider({}, "team_acme");
    await withTeam.provider.push("A", "v", PRODUCTION);
    expect(withTeam.calls[0]?.query).toMatchObject({ teamId: "team_acme" });

    const withoutTeam = provider();
    await withoutTeam.provider.push("A", "v", PRODUCTION);
    expect(withoutTeam.calls[0]?.query).not.toHaveProperty("teamId");
  });

  it("refuses a default that would overlap a target already holding its own value", async () => {
    // `API_URL` is production's own on Vercel; the unscoped default covers all
    // three targets, and Vercel has no default a target overrides.
    const { provider: p } = provider({
      GET: envs({ key: "API_URL", type: "encrypted", target: ["production"], updatedAt: 1 }),
    });
    await expect(p.push("API_URL", "v", REPOSITORY)).rejects.toMatchObject({
      name: "VercelTargetError",
      reason: "conflict",
    });
  });

  it("does not refuse a variable whose targets it is replacing exactly", async () => {
    const { provider: p } = provider({
      GET: envs({ key: "API_URL", type: "encrypted", target: ["production"], updatedAt: 1 }),
    });
    await expect(p.push("API_URL", "v", PRODUCTION)).resolves.toBeUndefined();
  });

  it("surfaces a per-item failure Vercel reports beside a 201", async () => {
    const { provider: p } = provider({
      POST: {
        status: 201,
        body: { failed: [{ error: { code: "bad_request", message: "The env key is invalid" } }] },
      },
    });
    await expect(p.push("API_URL", "v", PRODUCTION)).rejects.toMatchObject({
      name: "VercelUnavailableError",
      reason: "request-failed",
    });
    await expect(p.push("API_URL", "v", PRODUCTION)).rejects.toThrow(/The env key is invalid/);
  });

  it("refuses an environment with no declared target, naming the config key", async () => {
    const { provider: p } = provider();
    await expect(
      p.push("A", "v", { kind: "environment", environment: "qa" }),
    ).rejects.toMatchObject({ name: "VercelTargetError", reason: "unmapped" });
    await expect(p.push("A", "v", { kind: "environment", environment: "qa" })).rejects.toThrow(
      /providers\.qa\.targets/,
    );
  });
});

describe("VercelProvider.verify", () => {
  it("reads the project's variables once and reuses that read", async () => {
    const { provider: p, calls } = provider();
    await p.verify();
    await p.list(REPOSITORY);
    await p.list(PRODUCTION);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v10/projects/prj_app/env");
  });

  it("maps a refused token to not-authenticated", async () => {
    const { provider: p } = provider({ GET: { status: 401 } });
    await expect(p.verify()).rejects.toMatchObject({ reason: "not-authenticated" });
  });

  it("maps an unknown project to project-not-found, naming location", async () => {
    const { provider: p } = provider({ GET: { status: 404 } });
    await expect(p.verify()).rejects.toBeInstanceOf(VercelUnavailableError);
    await expect(p.verify()).rejects.toMatchObject({ reason: "project-not-found" });
    await expect(p.verify()).rejects.toThrow(/location/);
  });

  it("maps a token without access to forbidden, pointing at teamId", async () => {
    const { provider: p } = provider({
      GET: { status: 403, body: { error: { code: "forbidden", message: "Not authorized" } } },
    });
    await expect(p.verify()).rejects.toMatchObject({ reason: "forbidden" });
    await expect(p.verify()).rejects.toThrow(/teamId/);
  });

  it("surfaces the wait a rate limit's Retry-After names", async () => {
    const { provider: p } = provider({ GET: { status: 429, headers: { "retry-after": "42" } } });
    await expect(p.verify()).rejects.toMatchObject({
      reason: "rate-limited",
      retryAfterSeconds: 42,
    });
  });

  it("falls back to the documented X-RateLimit-Reset when there is no Retry-After", async () => {
    const { provider: p } = provider({
      GET: { status: 429, headers: { "x-ratelimit-reset": "1700000030" } },
    });
    await expect(p.verify()).rejects.toMatchObject({
      reason: "rate-limited",
      retryAfterSeconds: 30,
    });
  });

  it("still refuses loudly when a rate limit says nothing about when to retry", async () => {
    const { provider: p } = provider({ GET: { status: 429 } });
    await expect(p.verify()).rejects.toMatchObject({
      reason: "rate-limited",
      retryAfterSeconds: undefined,
    });
  });

  it("carries Vercel's own words on a status it has no specific refusal for", async () => {
    const { provider: p } = provider({
      GET: { status: 500, body: { error: { message: "An unexpected internal error occurred" } } },
    });
    await expect(p.verify()).rejects.toThrow(/unexpected internal error/);
  });
});

describe("VercelProvider.list", () => {
  const store = envs(
    {
      key: "SHARED",
      type: "encrypted",
      target: ["production", "preview", "development"],
      updatedAt: 0,
    },
    { key: "PROD_ONLY", type: "encrypted", target: ["production"], updatedAt: 86_400_000 },
    { key: "PREVIEW_ONLY", type: "encrypted", target: "preview", updatedAt: 0 },
    { key: "VERCEL_URL", type: "system", target: ["production"], updatedAt: 0 },
  );

  it("reports a variable covering every target as the shared default", async () => {
    const { provider: p } = provider({ GET: store });
    expect((await p.list(REPOSITORY)).map((secret) => secret.name)).toEqual(["SHARED"]);
  });

  it("reports a narrower variable as the secret of the environment whose target it carries", async () => {
    const { provider: p } = provider({ GET: store });
    expect((await p.list(PRODUCTION)).map((secret) => secret.name)).toEqual(["PROD_ONLY"]);
    expect(
      (await p.list({ kind: "environment", environment: "staging" })).map((s) => s.name),
    ).toEqual(["PREVIEW_ONLY"]);
  });

  it("leaves Vercel's own system variables out of both halves", async () => {
    const { provider: p } = provider({ GET: store });
    const names = [...(await p.list(REPOSITORY)), ...(await p.list(PRODUCTION))].map((s) => s.name);
    expect(names).not.toContain("VERCEL_URL");
  });

  it("turns Vercel's epoch milliseconds into the ISO stamp doctor compares", async () => {
    const { provider: p } = provider({ GET: store });
    const [secret] = await p.list(PRODUCTION);
    expect(secret?.updatedAt).toBe("1970-01-02T00:00:00.000Z");
  });

  it("reports no timestamp rather than inventing one", async () => {
    const { provider: p } = provider({
      GET: envs({ key: "A", type: "encrypted", target: ["production"] }),
    });
    const [secret] = await p.list(PRODUCTION);
    expect(secret?.updatedAt).toBe("");
  });

  it("survives a listing body that carries no envs at all", async () => {
    const { provider: p } = provider({ GET: { body: {} } });
    expect(await p.list(REPOSITORY)).toEqual([]);
  });
});

describe("VercelProvider capabilities", () => {
  it("declares a projection whose values penv cannot read back", () => {
    const { provider: p } = provider();
    expect(p.capabilities).toEqual({ holds: "projection", readsValues: false });
    expect(p.type).toBe("@penvhq/provider-vercel");
  });

  it("has no destination-side target to create — Vercel's three always exist", () => {
    const { provider: p } = provider();
    expect("targetExists" in p).toBe(false);
    expect("ensureTarget" in p).toBe(false);
  });
});

describe("penvProviderFactory", () => {
  const config = { environments: ["production", "staging"], providers: {} };

  it("refuses a provider entry with no project", () => {
    expect(() =>
      penvProviderFactory({
        root: "/app",
        config,
        providerConfig: { type: "@penvhq/provider-vercel", targets: TARGETS },
        environment: "production",
      }),
    ).toThrow(/location/);
  });

  it("refuses before a connection is opened when the environment has no declared target", () => {
    expect(() =>
      penvProviderFactory({
        root: "/app",
        config,
        providerConfig: { type: "@penvhq/provider-vercel", location: "prj_app", targets: {} },
        environment: "production",
      }),
    ).toThrow(VercelTargetError);
  });

  it("refuses a target that is not one of Vercel's three", () => {
    expect(() =>
      penvProviderFactory({
        root: "/app",
        config,
        providerConfig: {
          type: "@penvhq/provider-vercel",
          location: "prj_app",
          targets: { production: "prod" },
        },
        environment: "production",
      }),
    ).toThrow(/production, preview, development/);
  });

  it("refuses a target keyed by an environment the config does not declare", () => {
    expect(() =>
      penvProviderFactory({
        root: "/app",
        config: { environments: ["production"], providers: {} },
        providerConfig: {
          type: "@penvhq/provider-vercel",
          location: "prj_app",
          targets: { production: "production", staging: "preview" },
        },
        environment: "production",
      }),
    ).toThrow(
      /`providers\.production\.targets` is keyed by staging.*This project declares: production/s,
    );
  });

  it("accepts targets keyed only by declared environments", () => {
    expect(() =>
      penvProviderFactory({
        root: "/app",
        config,
        providerConfig: {
          type: "@penvhq/provider-vercel",
          location: "prj_app",
          targets: TARGETS,
        },
        environment: "staging",
      }),
    ).not.toThrow();
  });

  it("builds a provider that declares the projection capability", () => {
    const built = penvProviderFactory({
      root: "/app",
      config,
      providerConfig: {
        type: "@penvhq/provider-vercel",
        location: "prj_app",
        targets: TARGETS,
        teamId: "team_acme",
      },
      environment: "production",
    });
    expect(built.capabilities).toEqual({ holds: "projection", readsValues: false });
  });
});

describe("defaultVercelTransport", () => {
  function fakeFetch(captured: { url?: string; init?: RequestInit }): typeof globalThis.fetch {
    return (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ envs: [] }), {
        status: 200,
        headers: { "x-ratelimit-remaining": "499" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  it("sends the token as a bearer header and the query on the URL", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const transport = defaultVercelTransport({ token: "tkn", fetch: fakeFetch(captured) });
    const response = await transport({
      method: "GET",
      path: "/v10/projects/prj_app/env",
      query: { teamId: "team_acme" },
    });
    expect(captured.url).toBe("https://api.vercel.com/v10/projects/prj_app/env?teamId=team_acme");
    expect((captured.init?.headers as Record<string, string>)?.authorization).toBe("Bearer tkn");
    expect(response.status).toBe(200);
    expect(response.headers["x-ratelimit-remaining"]).toBe("499");
  });

  it("refuses before any request when no VERCEL_TOKEN is set", async () => {
    const previous = process.env["VERCEL_TOKEN"];
    delete process.env["VERCEL_TOKEN"];
    try {
      const transport = defaultVercelTransport({ fetch: fakeFetch({}) });
      await expect(transport({ method: "GET", path: "/v10/projects/x/env" })).rejects.toMatchObject(
        { name: "VercelUnavailableError", reason: "no-token" },
      );
    } finally {
      if (previous !== undefined) process.env["VERCEL_TOKEN"] = previous;
    }
  });

  it("reports an unreachable API rather than letting fetch's error escape", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const transport = defaultVercelTransport({ token: "tkn", fetch: failing });
    await expect(transport({ method: "GET", path: "/v10/projects/x/env" })).rejects.toMatchObject({
      reason: "request-failed",
    });
  });
});
