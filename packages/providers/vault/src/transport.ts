/**
 * The default {@link VaultTransport}: a thin boundary that shells out to the
 * `vault` CLI, mirroring the GitHub provider's `gh` precedent.
 *
 * penv holds no Vault credential of its own. `vault login` has already happened and
 * `VAULT_ADDR`/`VAULT_TOKEN` are the CLI's to keep — penv's config gains no field
 * for them. Values cross on **stdin** as JSON, never on argv (readable by other
 * processes), one `vault` process per operation. This path is deliberately light:
 * the contract proof runs against an injected in-memory fake, and a real dev-mode
 * Vault is exercised only by the excluded `*.smoke.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { VaultUnavailableError } from "./errors.js";
import type { VaultTransport } from "./vault.js";

/**
 * Runs `vault` with an argument array (never a shell string, so values with spaces
 * or special characters are never re-parsed) and optional stdin, returning stdout.
 * Injectable so the transport is testable without the binary; throws
 * {@link VaultInvocationError} on failure.
 */
export type VaultRunner = (args: readonly string[], input?: string) => string;

/** A `vault` invocation failed. Normalized so the transport maps it without touching Node's error shape. */
export class VaultInvocationError extends Error {
  override readonly name = "VaultInvocationError";
  /** True when `vault` is not on PATH (spawn `ENOENT`). */
  readonly notFound: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(notFound: boolean, status: number | null, stderr: string, args: readonly string[]) {
    super(`vault ${args.join(" ")} exited ${notFound ? "not found" : String(status)}`);
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

/** The real runner. Keeps `vault` non-interactive so it fails loudly rather than prompting. */
export const defaultVaultRunner: VaultRunner = (args, input) => {
  try {
    return execFileSync("vault", [...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    const status = typeof e.status === "number" ? e.status : null;
    throw new VaultInvocationError(e.code === "ENOENT", status, toText(e.stderr), args);
  }
};

const AUTH_HINT = /permission denied|missing client token|no valid credentials|403|forbidden/i;
const ABSENT_HINT = /no value found|no data/i;

/** A read/list/delete of a path that holds nothing — success, treated as absence, not an error. */
function isAbsent(error: unknown): boolean {
  return (
    error instanceof VaultInvocationError && (error.status === 2 || ABSENT_HINT.test(error.stderr))
  );
}

function notInstalled(): VaultUnavailableError {
  return new VaultUnavailableError(
    "not-installed",
    "The `vault` CLI is not installed or not on your PATH",
    "penv reaches Vault through the `vault` CLI and holds no Vault credential itself. Install it " +
      "from https://developer.hashicorp.com/vault/install, run `vault login`, then try again.",
  );
}

function notAuthenticated(stderr: string): VaultUnavailableError {
  return new VaultUnavailableError(
    "not-authenticated",
    "penv could not authenticate to Vault through the `vault` CLI",
    `Set \`VAULT_ADDR\` and run \`vault login\` (with a token that can read and write this mount), ` +
      `then try again.${stderr.trim() === "" ? "" : `\n  vault said: ${stderr.trim()}`}`,
  );
}

function commandFailed(action: string, stderr: string): VaultUnavailableError {
  return new VaultUnavailableError(
    "command-failed",
    `vault could not ${action}`,
    `Check that \`VAULT_ADDR\` points at your server and \`vault login\` used a token scoped to this ` +
      `mount.${stderr.trim() === "" ? "" : `\n  vault said: ${stderr.trim()}`}`,
  );
}

/** Maps a failed invocation to the loud, specific refusal penv owes the user. */
function mapFailure(error: unknown, action: string): VaultUnavailableError {
  if (error instanceof VaultInvocationError) {
    if (error.notFound) return notInstalled();
    if (AUTH_HINT.test(error.stderr)) return notAuthenticated(error.stderr);
    return commandFailed(action, error.stderr);
  }
  return commandFailed(action, error instanceof Error ? error.message : String(error));
}

function parseJson(stdout: string, action: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw commandFailed(action, `vault returned output that is not JSON: ${String(cause)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every value penv stores in Vault is a string, so a non-string field is dropped rather than coerced. */
function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export interface DefaultVaultTransportOptions {
  /** The KV mount every path is read from and written to. */
  readonly mount: string;
  /** The runner. Defaults to invoking the real binary; injected in the smoke test. */
  readonly run?: VaultRunner;
}

/**
 * A {@link VaultTransport} over the `vault` KV v2 CLI. The path arguments are
 * mount-relative; the `-mount=<mount>` flag carries the mount, so a path segment
 * is never mistaken for it.
 */
export function defaultVaultTransport(options: DefaultVaultTransportOptions): VaultTransport {
  const run = options.run ?? defaultVaultRunner;
  const mountFlag = `-mount=${options.mount}`;

  return {
    async readData(path, version) {
      const versionArgs = version === undefined ? [] : [`-version=${version}`];
      let stdout: string;
      try {
        stdout = run(["kv", "get", "-format=json", mountFlag, ...versionArgs, path]);
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw mapFailure(error, `read the secret at \`${path}\``);
      }
      const parsed = asRecord(parseJson(stdout, `read the secret at \`${path}\``));
      const data = asRecord(parsed?.["data"]);
      if (data === undefined || data["data"] === undefined) return undefined;
      return asStringMap(data["data"]);
    },

    async writeData(path, data) {
      try {
        run(["kv", "put", "-format=json", mountFlag, path, "-"], JSON.stringify(data));
      } catch (error) {
        throw mapFailure(error, `write the secret at \`${path}\``);
      }
    },

    async currentVersion(path) {
      let stdout: string;
      try {
        stdout = run(["kv", "metadata", "get", "-format=json", mountFlag, path]);
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw mapFailure(error, `read the version history at \`${path}\``);
      }
      const parsed = asRecord(parseJson(stdout, `read the version history at \`${path}\``));
      const data = asRecord(parsed?.["data"]);
      const current = data?.["current_version"];
      return typeof current === "number" ? current : undefined;
    },

    async deleteMetadata(path) {
      try {
        run(["kv", "metadata", "delete", mountFlag, path]);
      } catch (error) {
        if (isAbsent(error)) return;
        throw mapFailure(error, `delete the secret at \`${path}\``);
      }
    },

    async listKeys(path) {
      let stdout: string;
      try {
        stdout = run(["kv", "list", "-format=json", mountFlag, path]);
      } catch (error) {
        if (isAbsent(error)) return [];
        throw mapFailure(error, `list the keys under \`${path}\``);
      }
      const parsed = parseJson(stdout, `list the keys under \`${path}\``);
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === "string")
        : [];
    },

    async mountVersion() {
      let stdout: string;
      try {
        stdout = run(["read", "-format=json", `sys/internal/ui/mounts/${options.mount}`]);
      } catch (error) {
        throw mapFailure(error, `read the KV version of mount \`${options.mount}\``);
      }
      const parsed = asRecord(parseJson(stdout, "read the mount version"));
      const data = asRecord(parsed?.["data"]);
      const opts = asRecord(data?.["options"]);
      const version = opts?.["version"];
      if (typeof version === "number") return version;
      if (typeof version === "string" && /^\d+$/.test(version)) return Number.parseInt(version, 10);
      throw commandFailed(
        `read the KV version of mount \`${options.mount}\``,
        "vault did not report an `options.version` for this mount",
      );
    },
  };
}
