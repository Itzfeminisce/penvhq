/**
 * The default {@link SsmTransport}: a thin boundary that shells out to the `aws`
 * CLI, mirroring the Vault adapter's `vault` precedent and the GitHub provider's `gh`.
 *
 * penv holds no AWS credential of its own. The `aws` CLI's profile, region, and
 * IAM role are its to keep — penv's config gains no field for them. Reads always
 * pass `--with-decryption`, because a `SecureString` read without it returns the
 * ciphertext *as the value* — the single silent-wrong-value hazard this adapter
 * exists to not have. Writes cross on **stdin** as an `aws` input JSON, never on
 * argv (readable by other processes), one `aws` process per operation. This path
 * is deliberately light: the contract proof runs against an injected in-memory
 * fake, and a real account is exercised only by the excluded `*.smoke.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SsmUnavailableError } from "./errors.js";
import type { SsmTransport, SsmValue } from "./ssm.js";

/**
 * Runs `aws` with an argument array (never a shell string, so values are never
 * re-parsed) and optional stdin, returning stdout. Injectable so the transport is
 * testable without the binary; throws {@link AwsInvocationError} on failure.
 */
export type AwsRunner = (args: readonly string[], input?: string) => string;

/** An `aws` invocation failed. Normalized so the transport maps it without Node's error shape leaking. */
export class AwsInvocationError extends Error {
  override readonly name = "AwsInvocationError";
  /** True when `aws` is not on PATH (spawn `ENOENT`). */
  readonly notFound: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(notFound: boolean, status: number | null, stderr: string, args: readonly string[]) {
    super(`aws ${args.join(" ")} exited ${notFound ? "not found" : String(status)}`);
    this.notFound = notFound;
    this.status = status;
    this.stderr = stderr;
    this.args = args;
  }
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/** The real runner. Keeps `aws` non-interactive and uncoloured so it fails loudly. */
export const defaultAwsRunner: AwsRunner = (args, input) => {
  try {
    return execFileSync("aws", [...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AWS_PAGER: "", NO_COLOR: "1" },
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    const status = typeof e.status === "number" ? e.status : null;
    throw new AwsInvocationError(e.code === "ENOENT", status, toText(e.stderr), args);
  }
};

const NOT_FOUND_HINT = /ParameterNotFound|ParameterVersionNotFound/;
const AUTH_HINT =
  /AccessDenied|UnauthorizedOperation|ExpiredToken|could not be found|Unable to locate credentials|The security token/i;

/** A read/list/delete of a name that holds nothing — treated as absence, not an error. */
function isAbsent(error: unknown): boolean {
  return error instanceof AwsInvocationError && NOT_FOUND_HINT.test(error.stderr);
}

function notInstalled(): SsmUnavailableError {
  return new SsmUnavailableError(
    "not-installed",
    "The `aws` CLI is not installed or not on your PATH",
    "penv reaches SSM through the `aws` CLI and holds no AWS credential itself. Install it from " +
      "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, configure " +
      "credentials (`aws configure`), then try again.",
  );
}

function notAuthenticated(stderr: string): SsmUnavailableError {
  return new SsmUnavailableError(
    "not-authenticated",
    "penv could not authenticate to AWS through the `aws` CLI",
    `Configure credentials and a region (\`aws configure\`, or \`AWS_PROFILE\`/\`AWS_REGION\`) for an ` +
      `identity allowed to read and write these parameters, then try again.${suffix(stderr)}`,
  );
}

function commandFailed(action: string, stderr: string): SsmUnavailableError {
  return new SsmUnavailableError(
    "command-failed",
    `aws could not ${action}`,
    `Check the \`aws\` CLI is configured with a region and an identity scoped to these parameters.${suffix(stderr)}`,
  );
}

function suffix(stderr: string): string {
  return stderr.trim() === "" ? "" : `\n  aws said: ${stderr.trim()}`;
}

/** Maps a failed invocation to the loud, specific refusal penv owes the user. */
function mapFailure(error: unknown, action: string): SsmUnavailableError {
  if (error instanceof AwsInvocationError) {
    if (error.notFound) return notInstalled();
    if (AUTH_HINT.test(error.stderr)) return notAuthenticated(error.stderr);
    return commandFailed(action, error.stderr);
  }
  return commandFailed(action, error instanceof Error ? error.message : String(error));
}

function parseJson(stdout: string, action: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (cause) {
    throw commandFailed(action, `aws returned output that is not JSON: ${String(cause)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asValue(parameter: unknown): SsmValue | undefined {
  const record = asRecord(parameter);
  const value = record?.["Value"];
  const version = record?.["Version"];
  if (typeof value !== "string") return undefined;
  return { value, version: typeof version === "number" ? version : 0 };
}

export interface DefaultSsmTransportOptions {
  /** The runner. Defaults to invoking the real binary; injected in the smoke test. */
  readonly run?: AwsRunner;
}

/**
 * Runs an `aws` command with a `--cli-input-json` payload, without ever putting the
 * value on argv (visible to other processes) and without a POSIX-only path.
 *
 * The `aws` CLI has no native stdin token for `--cli-input-json` — the trick Vault's
 * `-` uses — and `file:///dev/stdin` is a Unix-only device path that fails on
 * Windows. So the payload is written to a private, short-lived temp file (owner-only
 * permissions), read via `file://`, and deleted immediately whether the command
 * succeeds or fails. The value touches the local disk only for the length of one
 * write, and never the process table.
 */
function runWithInputJson(run: AwsRunner, args: readonly string[], body: string): void {
  const dir = mkdtempSync(join(tmpdir(), "penv-ssm-"));
  const file = join(dir, "input.json");
  try {
    writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    run([...args, "--cli-input-json", `file://${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An {@link SsmTransport} over the `aws ssm` CLI. */
export function defaultSsmTransport(options: DefaultSsmTransportOptions): SsmTransport {
  const run = options.run ?? defaultAwsRunner;

  return {
    async getParameter(name) {
      let stdout: string;
      try {
        stdout = run([
          "ssm",
          "get-parameter",
          "--with-decryption",
          "--name",
          name,
          "--output",
          "json",
        ]);
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw mapFailure(error, `read the parameter \`${name}\``);
      }
      const parsed = asRecord(parseJson(stdout, `read the parameter \`${name}\``));
      return asValue(parsed?.["Parameter"]);
    },

    async putParameter(name, value, secure) {
      const body = JSON.stringify({
        Name: name,
        Value: value,
        Type: secure ? "SecureString" : "String",
        Overwrite: true,
      });
      try {
        runWithInputJson(run, ["ssm", "put-parameter"], body);
      } catch (error) {
        throw mapFailure(error, `write the parameter \`${name}\``);
      }
    },

    async deleteParameter(name) {
      try {
        run(["ssm", "delete-parameter", "--name", name]);
      } catch (error) {
        if (isAbsent(error)) return;
        throw mapFailure(error, `delete the parameter \`${name}\``);
      }
    },

    async listNames(path) {
      const names: string[] = [];
      let token: string | undefined;
      do {
        const tokenArgs = token === undefined ? [] : ["--starting-token", token];
        let stdout: string;
        try {
          stdout = run([
            "ssm",
            "get-parameters-by-path",
            "--path",
            path,
            "--recursive",
            "--output",
            "json",
            ...tokenArgs,
          ]);
        } catch (error) {
          if (isAbsent(error)) return names;
          throw mapFailure(error, `list the parameters under \`${path}\``);
        }
        const parsed = asRecord(parseJson(stdout, `list the parameters under \`${path}\``));
        const parameters = parsed?.["Parameters"];
        if (Array.isArray(parameters)) {
          for (const parameter of parameters) {
            const name = asRecord(parameter)?.["Name"];
            if (typeof name === "string") names.push(name);
          }
        }
        const next = parsed?.["NextToken"];
        token = typeof next === "string" ? next : undefined;
      } while (token !== undefined);
      return names;
    },

    async getHistory(name) {
      const versions: SsmValue[] = [];
      let token: string | undefined;
      do {
        const tokenArgs = token === undefined ? [] : ["--starting-token", token];
        let stdout: string;
        try {
          stdout = run([
            "ssm",
            "get-parameter-history",
            "--with-decryption",
            "--name",
            name,
            "--output",
            "json",
            ...tokenArgs,
          ]);
        } catch (error) {
          if (isAbsent(error)) return [];
          throw mapFailure(error, `read the history of \`${name}\``);
        }
        const parsed = asRecord(parseJson(stdout, `read the history of \`${name}\``));
        const parameters = parsed?.["Parameters"];
        if (Array.isArray(parameters)) {
          for (const parameter of parameters) {
            const value = asValue(parameter);
            if (value !== undefined) versions.push(value);
          }
        }
        const next = parsed?.["NextToken"];
        token = typeof next === "string" ? next : undefined;
      } while (token !== undefined);
      // Oldest-to-newest, so `readPrevious` can take the penultimate entry.
      return versions.sort((a, b) => a.version - b.version);
    },
  };
}
