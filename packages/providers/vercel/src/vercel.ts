/**
 * The Vercel provider — a projection-holding destination `penv push` writes into
 * a project's environment-variable store, so a production cutover is one command
 * instead of a settings form at 2am.
 *
 * Vercel's store has exactly one axis: a variable belongs to a set of *targets*
 * (production, preview, development). penv's own axis is the cascade, and the two
 * halves a push presents — the unscoped default and one environment's scoped
 * value — land on it as: the default covers all three targets, an environment's
 * value covers the single target that environment deploys to. That target is
 * `environments.<env>.target`, defaulting to the environment's own name; penv
 * never guesses past that, because guessing between production and preview is
 * guessing which deployment reads a secret.
 *
 * Values cross as `type: "encrypted"` — Vercel's universally-available encrypted
 * store. `type: "sensitive"` withholds values permanently but Vercel allows it
 * only on production and preview, so it cannot carry the unscoped default, which
 * must also reach development.
 * https://vercel.com/docs/environment-variables/sensitive-environment-variables
 */

import type {
  ParameterRef,
  PenvConfig,
  PenvErrorLike,
  ProjectionProvider,
  ProjectionSecret,
  SecretScope,
} from "@penvhq/core";
import { VercelTargetError, VercelUnavailableError } from "./errors.js";
import { checkVercelNames } from "./names.js";
import type { VercelRequest, VercelResponse, VercelTransport } from "./transport.js";
import { defaultVercelTransport } from "./transport.js";

/** Vercel's three deployment targets. https://vercel.com/docs/deployments/environments */
export const VERCEL_TARGETS = ["production", "preview", "development"] as const;
export type VercelTarget = (typeof VERCEL_TARGETS)[number];

function isTarget(value: unknown): value is VercelTarget {
  return typeof value === "string" && (VERCEL_TARGETS as readonly string[]).includes(value);
}

/**
 * The Vercel target an environment deploys to: the entry's own `target` when it
 * declares one, otherwise the target named like the environment. An environment
 * whose name is not one of Vercel's three and declares no `target` is refused
 * here — at construction, before a push opens a connection — naming both
 * remedies. penv never guesses a mapping: the guess decides which deployment
 * reads the secret.
 */
export function resolveTarget(declared: unknown, environment: string | undefined): VercelTarget {
  if (declared === undefined) {
    if (isTarget(environment)) {
      return environment;
    }
    const summary =
      environment === undefined
        ? "The Vercel provider entry declares no `target` and no environment to default it from"
        : `Environment ${environment} declares no \`target\`, and its name is not a Vercel target`;
    throw new VercelTargetError(
      "unmapped",
      summary,
      `Set \`target\` to one of ${VERCEL_TARGETS.join(", ")}, or rename the environment to the ` +
        "target it deploys to. penv will not guess it: the guess decides which deployment reads " +
        "the secret.",
      environment,
    );
  }
  if (!isTarget(declared)) {
    const where = environment === undefined ? "" : ` for environment ${environment}`;
    throw new VercelTargetError(
      "invalid",
      `\`target\`${where} is \`${String(declared)}\`, which is not a Vercel target`,
      `Vercel has three: ${VERCEL_TARGETS.join(", ")}. Name one of them.`,
      environment,
    );
  }
  return declared;
}

/** One environment variable as Vercel's list endpoint reports it. */
interface VercelEnv {
  readonly key: string;
  readonly type: string;
  readonly target: readonly string[];
  /** ISO 8601, or `""` when Vercel reported no usable timestamp. */
  readonly updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Vercel's `target` comes back as an array *or* a bare string — the response
 * schema is a `oneOf` of both — so it is normalised before anything compares it.
 */
function normalizeTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Vercel stamps epoch milliseconds; `ProjectionSecret.updatedAt` is ISO 8601,
 * which is what `doctor` parses to catch a hand-edit. An absent or unusable
 * stamp becomes `""`, which parses to `NaN` and makes `doctor` skip the
 * comparison rather than invent a time.
 */
function isoTime(value: unknown): string {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : undefined;
  if (ms === undefined) return "";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseEnvs(body: unknown): VercelEnv[] {
  const record = asRecord(body);
  const listed = record === undefined ? undefined : record["envs"];
  const raw: unknown[] = Array.isArray(body) ? body : Array.isArray(listed) ? listed : [];
  const envs: VercelEnv[] = [];
  for (const entry of raw) {
    const env = asRecord(entry);
    if (env === undefined || typeof env["key"] !== "string") {
      continue;
    }
    envs.push({
      key: env["key"],
      type: typeof env["type"] === "string" ? env["type"] : "",
      target: normalizeTargets(env["target"]),
      updatedAt: isoTime(env["updatedAt"] ?? env["createdAt"]),
    });
  }
  return envs;
}

/** Vercel's error bodies are `{ error: { code, message, … } }`. */
function errorMessage(body: unknown): string {
  const error = asRecord(asRecord(body)?.["error"]);
  const message = error?.["message"];
  return typeof message === "string" ? message : "";
}

function detail(body: unknown): string {
  const message = errorMessage(body);
  return message === "" ? "" : `\n  Vercel said: ${message}`;
}

/**
 * How long to wait after a 429. Vercel documents `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining`, and `X-RateLimit-Reset` and does *not* document
 * `Retry-After`, so the header is honoured when present and the documented reset
 * (a Unix timestamp, mirrored in the body's `error.limit`) is the fallback.
 * https://vercel.com/docs/rest-api
 */
function retryAfterSeconds(response: VercelResponse, now: number): number | undefined {
  const header = response.headers["retry-after"];
  if (header !== undefined && /^\d+$/.test(header.trim())) {
    return Number.parseInt(header.trim(), 10);
  }
  const reset = response.headers["x-ratelimit-reset"];
  if (reset !== undefined && /^\d+$/.test(reset.trim())) {
    return Math.max(0, Math.ceil(Number.parseInt(reset.trim(), 10) - now / 1000));
  }
  const error = asRecord(asRecord(response.body)?.["error"]);
  const bodyReset = asRecord(error?.["limit"])?.["reset"];
  if (typeof bodyReset !== "number") return undefined;
  return Math.max(0, Math.ceil(bodyReset - now / 1000));
}

export interface VercelProviderOptions {
  /** The project penv writes into — its id (`prj_…`) or its name. */
  readonly project: string;
  /** The one target this environment's values land on — see {@link resolveTarget}. */
  readonly target: VercelTarget;
  /** The team owning the project. Only a full-account token needs it. */
  readonly teamId?: string;
  /** The API transport. Defaults to `fetch` against api.vercel.com; injected in tests. */
  readonly transport?: VercelTransport;
  /** Injected in tests: the clock a `Retry-After` is measured against. */
  readonly now?: () => number;
}

export class VercelProvider implements ProjectionProvider {
  readonly type = "@penvhq/provider-vercel";
  /**
   * A projection, and one penv cannot read back. Vercel's API *can* return a
   * decrypted value for an `encrypted` variable, but the projection contract has
   * no verb that could return one — `push` and `list` are the whole surface — so
   * what penv can observe here is names and timestamps, and the declaration says
   * exactly that. `doctor` reports value drift as unknown rather than clean.
   */
  readonly capabilities = { holds: "projection", readsValues: false } as const;

  readonly #project: string;
  readonly #target: VercelTarget;
  readonly #teamId: string | undefined;
  readonly #transport: VercelTransport;
  readonly #now: () => number;
  /** The project's variables, read once — `verify` warms it, `push` and `list` read it. */
  #envs: VercelEnv[] | undefined;

  constructor(options: VercelProviderOptions) {
    this.#project = options.project;
    this.#target = options.target;
    this.#teamId = options.teamId;
    this.#transport = options.transport ?? defaultVercelTransport();
    this.#now = options.now ?? Date.now;
  }

  async verify(): Promise<void> {
    // Listing the project's variables is one call that proves three things at
    // once: the token is valid, the project exists and this token can reach it,
    // and — since a push must know what is already on each target — it is the
    // read the rest of the command needs anyway.
    this.#envs = await this.#load();
  }

  async push(name: string, value: string, scope: SecretScope): Promise<void> {
    const targets = this.#targetsFor(scope);
    const conflict = (await this.#list()).find(
      (env) =>
        env.key === name && !sameTargets(env.target, targets) && overlaps(env.target, targets),
    );
    if (conflict !== undefined) {
      throw new VercelTargetError(
        "conflict",
        `Vercel already holds \`${name}\` on ${conflict.target.join(", ")}, which overlaps the ${targets.join(", ")} this push writes`,
        `A Vercel variable is unique per key and target, and Vercel has no default a target ` +
          `overrides — so one key cannot be both a shared default and one target's own value. ` +
          `Give \`${name}\` an environment-scoped value for every environment you push to this ` +
          `project, or delete the overlapping variable in Vercel.`,
      );
    }

    // `upsert=true` is what makes a re-push idempotent: without it Vercel refuses
    // an existing key with a 403 rather than replacing it.
    // https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
    const response = await this.#send(
      {
        method: "POST",
        path: `/v10/projects/${encodeURIComponent(this.#project)}/env`,
        query: { upsert: "true" },
        body: { key: name, value, type: "encrypted", target: targets },
      },
      `write the variable \`${name}\``,
    );

    // A 201 does not mean the write landed: the create endpoint reports per-item
    // failures in `failed[]` beside whatever it did create.
    const failed = asRecord(response.body)?.["failed"];
    const first = Array.isArray(failed) ? asRecord(asRecord(failed[0])?.["error"]) : undefined;
    if (first !== undefined) {
      const message = first["message"];
      throw new VercelUnavailableError(
        "request-failed",
        `Vercel refused the variable \`${name}\``,
        `Check the name and value against Vercel's limits, then try again.${
          typeof message === "string" && message !== "" ? `\n  Vercel said: ${message}` : ""
        }`,
      );
    }
  }

  /**
   * The two scopes partition the store by target *breadth*: a variable covering
   * all three targets is the shared default, one covering fewer belongs to the
   * environment whose target it carries. The partition is total and disjoint, so
   * `doctor` compares each half against the half a push would place there.
   */
  async list(scope: SecretScope): Promise<ProjectionSecret[]> {
    const target = scope.kind === "repository" ? undefined : this.#target;
    return (
      (await this.#list())
        // A `system` variable is Vercel's own (`VERCEL_URL` and its peers), not
        // something penv pushes; reporting it would be drift on every run.
        .filter((env) => env.type !== "system")
        .filter((env) =>
          target === undefined
            ? coversAll(env.target)
            : !coversAll(env.target) && env.target.includes(target),
        )
        .map((env) => ({ name: env.key, updatedAt: env.updatedAt }))
    );
  }

  /** Vercel's key grammar, judged before the first write — the provider owns its own rules. */
  checkNames(refs: readonly ParameterRef[], config: PenvConfig): PenvErrorLike[] {
    return checkVercelNames(refs, config);
  }

  /**
   * The targets one push scope lands on. The unscoped default is the value every
   * environment falls back to, so it covers all three; an environment's own value
   * covers the one target this provider was built for.
   */
  #targetsFor(scope: SecretScope): VercelTarget[] {
    return scope.kind === "repository" ? [...VERCEL_TARGETS] : [this.#target];
  }

  async #list(): Promise<VercelEnv[]> {
    if (this.#envs === undefined) {
      this.#envs = await this.#load();
    }
    return this.#envs;
  }

  async #load(): Promise<VercelEnv[]> {
    const response = await this.#send(
      { method: "GET", path: `/v10/projects/${encodeURIComponent(this.#project)}/env` },
      "read this project's environment variables",
    );
    return parseEnvs(response.body);
  }

  /** One call, with every non-2xx turned into the loud, specific refusal penv owes the user. */
  async #send(request: VercelRequest, action: string): Promise<VercelResponse> {
    const response = await this.#transport({
      ...request,
      query: {
        ...(request.query ?? {}),
        // A team- or project-scoped token carries its own team, so `teamId` is
        // only declared when a full-account token needs to name one.
        ...(this.#teamId === undefined ? {} : { teamId: this.#teamId }),
      },
    });
    if (response.status >= 200 && response.status < 300) {
      return response;
    }
    throw this.#failure(response, action);
  }

  #failure(response: VercelResponse, action: string): VercelUnavailableError {
    if (response.status === 401) {
      return new VercelUnavailableError(
        "not-authenticated",
        "Vercel refused penv's access token",
        "The token is missing, invalid, or expired. Mint a new one at " +
          "https://vercel.com/account/tokens and export it as `VERCEL_TOKEN`.",
      );
    }
    if (response.status === 403) {
      // Every write goes out with `upsert=true`, so a 403 here is permission and
      // never the "this variable already exists" 403 the create endpoint documents.
      return new VercelUnavailableError(
        "forbidden",
        `Vercel refused this token access to the project \`${this.#project}\``,
        `Give the token access to the project, or — with a full-account token — name the owning ` +
          `team as \`teamId\` in the environment's entry.${detail(response.body)}`,
      );
    }
    if (response.status === 404) {
      return new VercelUnavailableError(
        "project-not-found",
        `Vercel has no project \`${this.#project}\``,
        "Set `project` in the environment's entry to the project's id (`prj_…`) or its name, and " +
          "set `teamId` too when the project belongs to a team and your token is account-wide.",
      );
    }
    if (response.status === 429) {
      const seconds = retryAfterSeconds(response, this.#now());
      const message = `Vercel rate-limited penv while trying to ${action}`;
      if (seconds === undefined) {
        return new VercelUnavailableError(
          "rate-limited",
          message,
          "Wait a minute and run the command again — Vercel allows 120 environment-variable " +
            "writes a minute per account.",
        );
      }
      return new VercelUnavailableError(
        "rate-limited",
        message,
        `Wait ${seconds} second${seconds === 1 ? "" : "s"} and run the command again.`,
        seconds,
      );
    }
    return new VercelUnavailableError(
      "request-failed",
      `Vercel could not ${action}`,
      `Vercel answered ${response.status}. Check the project, the token's scope, and Vercel's ` +
        `status at https://www.vercel-status.com, then try again.${detail(response.body)}`,
    );
  }
}

function coversAll(targets: readonly string[]): boolean {
  return VERCEL_TARGETS.every((target) => targets.includes(target));
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((entry) => b.includes(entry));
}

function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}

export function createVercelProvider(options: VercelProviderOptions): VercelProvider {
  return new VercelProvider(options);
}
