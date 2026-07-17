/**
 * The GitHub Actions Secrets sink.
 *
 * penv reaches GitHub through the `gh` CLI and holds no GitHub credential of its
 * own: `gh auth login` has already happened, the token is `gh`'s to keep, and
 * penv's config gains no field for it. Values cross on **stdin**, never `--body`
 * (argv is readable by other processes) and never `--env-file` (a plaintext temp
 * file is the arrangement penv exists to delete) — one `gh` process per
 * parameter, which is slow and correct on a command that runs at deploy prep.
 */

import { execFileSync } from "node:child_process";
import type { SecretScope, Sink, SinkSecret } from "@penvhq/core";
import { GithubUnavailableError } from "./errors.js";

/** A `gh` invocation failed. Normalized so the sink maps it without touching Node's error shape. */
export class GhInvocationError extends Error {
  override readonly name = "GhInvocationError";
  /** True when `gh` is not on PATH (spawn `ENOENT`). */
  readonly notFound: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(notFound: boolean, status: number | null, stderr: string, args: readonly string[]) {
    super(`gh ${args.join(" ")} exited ${notFound ? "not found" : String(status)}`);
    this.notFound = notFound;
    this.status = status;
    this.stderr = stderr;
    this.args = args;
  }
}

/**
 * Runs `gh` with an argument array (never a shell string, so values with spaces
 * or special characters are never re-parsed) and optional stdin, returning
 * stdout. Injectable so the sink is testable without the binary; throws
 * {@link GhInvocationError} on failure.
 */
export type GhRunner = (args: readonly string[], input?: string) => string;

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/** The real runner. Keeps `gh` non-interactive so it fails loudly rather than prompting. */
export const defaultGhRunner: GhRunner = (args, input) => {
  try {
    return execFileSync("gh", [...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: string | Buffer;
    };
    const status = typeof e.status === "number" ? e.status : null;
    throw new GhInvocationError(e.code === "ENOENT", status, toText(e.stderr), args);
  }
};

const AUTH_HINT = /not logged in|authentication|gh auth login|no accounts/i;

function notInstalled(): GithubUnavailableError {
  return new GithubUnavailableError(
    "not-installed",
    "The `gh` CLI is not installed or not on your PATH",
    "penv reaches GitHub Actions through `gh` and holds no GitHub credential itself. Install it " +
      "from https://cli.github.com and run `gh auth login`, then try again.",
  );
}

function notAuthenticated(stderr: string): GithubUnavailableError {
  return new GithubUnavailableError(
    "not-authenticated",
    "penv could not authenticate to GitHub through `gh`",
    `Run \`gh auth login\` (with a token that can write repository and environment secrets), then ` +
      `try again.${stderr.trim() === "" ? "" : `\n  gh said: ${stderr.trim()}`}`,
  );
}

function commandFailed(action: string, stderr: string): GithubUnavailableError {
  return new GithubUnavailableError(
    "command-failed",
    `gh could not ${action}`,
    `Check that \`gh\` is authenticated with a token scoped to write this repository's secrets, and ` +
      `that the repository and environment exist.${stderr.trim() === "" ? "" : `\n  gh said: ${stderr.trim()}`}`,
  );
}

/** Maps a failed invocation to the loud, specific refusal penv owes the user. */
function mapFailure(error: unknown, action: string): GithubUnavailableError {
  if (error instanceof GhInvocationError) {
    if (error.notFound) return notInstalled();
    if (AUTH_HINT.test(error.stderr)) return notAuthenticated(error.stderr);
    return commandFailed(action, error.stderr);
  }
  return commandFailed(action, error instanceof Error ? error.message : String(error));
}

/** `--env <name>` for an environment secret, nothing for a repository secret; `--repo` when declared. */
function scopeArgs(scope: SecretScope, repo: string | undefined): string[] {
  const repoArgs = repo === undefined ? [] : ["--repo", repo];
  return scope.kind === "environment" ? ["--env", scope.environment, ...repoArgs] : [...repoArgs];
}

interface RawSecret {
  readonly name: unknown;
  readonly updatedAt: unknown;
}

function parseSecretList(stdout: string, action: string): SinkSecret[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw commandFailed(action, `gh returned output that is not JSON: ${toText(String(cause))}`);
  }
  if (!Array.isArray(parsed)) {
    throw commandFailed(action, "gh returned JSON that is not an array of secrets");
  }
  const secrets: SinkSecret[] = [];
  for (const entry of parsed as RawSecret[]) {
    if (typeof entry?.name !== "string" || typeof entry.updatedAt !== "string") {
      continue;
    }
    secrets.push({ name: entry.name, updatedAt: entry.updatedAt });
  }
  return secrets;
}

export interface GithubSinkOptions {
  /** The `owner/repo` `gh` targets. Left unset, `gh` resolves it from the working directory. */
  readonly repo?: string;
  /** The `gh` runner. Defaults to invoking the real binary; injected in tests. */
  readonly run?: GhRunner;
}

export class GithubSink implements Sink {
  readonly type = "github";

  readonly #repo: string | undefined;
  readonly #run: GhRunner;

  constructor(options: GithubSinkOptions = {}) {
    this.#repo = options.repo;
    this.#run = options.run ?? defaultGhRunner;
  }

  async verify(): Promise<void> {
    try {
      this.#run(["auth", "status"]);
    } catch (error) {
      if (error instanceof GhInvocationError && error.notFound) {
        throw notInstalled();
      }
      throw notAuthenticated(error instanceof GhInvocationError ? error.stderr : String(error));
    }
    // Authenticated is not the same as able to write here. Listing the
    // repository's secrets is a live probe that the token can reach *this*
    // repository's secrets API — catching a wrong or inaccessible repo and a
    // grossly under-scoped token before the first PUT rather than mid-push. It
    // cannot prove per-environment write permission without writing, so that
    // narrower failure can still surface at push time as a loud refusal.
    try {
      this.#run([
        "secret",
        "list",
        ...scopeArgs({ kind: "repository" }, this.#repo),
        "--json",
        "name",
      ]);
    } catch (error) {
      throw mapFailure(error, "reach this repository's secrets");
    }
  }

  async push(name: string, value: string, scope: SecretScope): Promise<void> {
    const args = ["secret", "set", name, ...scopeArgs(scope, this.#repo)];
    try {
      this.#run(args, value);
    } catch (error) {
      throw mapFailure(error, `set the secret \`${name}\``);
    }
  }

  async list(scope: SecretScope): Promise<SinkSecret[]> {
    const args = ["secret", "list", ...scopeArgs(scope, this.#repo), "--json", "name,updatedAt"];
    let stdout: string;
    try {
      stdout = this.#run(args);
    } catch (error) {
      throw mapFailure(error, "list secrets");
    }
    return parseSecretList(stdout, "list secrets");
  }
}

export function createGithubSink(options: GithubSinkOptions = {}): GithubSink {
  return new GithubSink(options);
}
