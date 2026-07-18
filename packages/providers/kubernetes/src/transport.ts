/**
 * The default {@link KubernetesTransport}: a thin boundary that shells out to
 * `kubectl`, mirroring the Vault (`vault`) and SSM (`aws`) adapters.
 *
 * penv holds no kubeconfig of its own. The current `kubectl` context and its
 * credentials are its to keep — penv's config gains no field for them. The whole
 * penv tree lives in one Secret; a write is a read-modify-write of that Secret's
 * `data`, applied on **stdin** as a manifest, never on argv. This path is
 * deliberately light: the contract proof runs against an injected in-memory fake,
 * and a real cluster is exercised only by the excluded `*.smoke.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { KubernetesUnavailableError } from "./errors.js";
import type { KubernetesTransport } from "./kubernetes.js";

/** Runs `kubectl` with an argument array and optional stdin, returning stdout. Injectable for tests. */
export type KubectlRunner = (args: readonly string[], input?: string) => string;

/** A `kubectl` invocation failed. Normalized so the transport maps it without Node's error shape leaking. */
export class KubectlInvocationError extends Error {
  override readonly name = "KubectlInvocationError";
  readonly notFound: boolean;
  readonly status: number | null;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(notFound: boolean, status: number | null, stderr: string, args: readonly string[]) {
    super(`kubectl ${args.join(" ")} exited ${notFound ? "not found" : String(status)}`);
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

export const defaultKubectlRunner: KubectlRunner = (args, input) => {
  try {
    return execFileSync("kubectl", [...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer };
    const status = typeof e.status === "number" ? e.status : null;
    throw new KubectlInvocationError(e.code === "ENOENT", status, toText(e.stderr), args);
  }
};

// Only a *Secret* that does not exist is absence. A `NotFound` about the
// namespace — or any other resource — is a misconfiguration penv must surface
// loudly, never quietly read as an empty store (the "never fall back" rule).
const SECRET_ABSENT_HINT = /secrets? "[^"]*" not found/i;
const AUTH_HINT =
  /Unauthorized|forbidden|You must be logged in|Unable to connect|no configuration|couldn't get current server/i;

/** A get of a Secret that does not exist — treated as absence, not an error. */
function isAbsent(error: unknown): boolean {
  return error instanceof KubectlInvocationError && SECRET_ABSENT_HINT.test(error.stderr);
}

function notInstalled(): KubernetesUnavailableError {
  return new KubernetesUnavailableError(
    "not-installed",
    "The `kubectl` CLI is not installed or not on your PATH",
    "penv reaches the cluster through `kubectl` and holds no kubeconfig itself. Install it from " +
      "https://kubernetes.io/docs/tasks/tools/, select a context (`kubectl config use-context`), then try again.",
  );
}

function notAuthenticated(stderr: string): KubernetesUnavailableError {
  return new KubernetesUnavailableError(
    "not-authenticated",
    "penv could not reach the cluster through `kubectl`",
    `Select a working context with access to this namespace (\`kubectl config use-context\`), then ` +
      `try again.${suffix(stderr)}`,
  );
}

function commandFailed(action: string, stderr: string): KubernetesUnavailableError {
  return new KubernetesUnavailableError(
    "command-failed",
    `kubectl could not ${action}`,
    `Check the current \`kubectl\` context points at your cluster and can write Secrets in this ` +
      `namespace.${suffix(stderr)}`,
  );
}

function suffix(stderr: string): string {
  return stderr.trim() === "" ? "" : `\n  kubectl said: ${stderr.trim()}`;
}

function mapFailure(error: unknown, action: string): KubernetesUnavailableError {
  if (error instanceof KubectlInvocationError) {
    if (error.notFound) return notInstalled();
    if (AUTH_HINT.test(error.stderr)) return notAuthenticated(error.stderr);
    return commandFailed(action, error.stderr);
  }
  return commandFailed(action, error instanceof Error ? error.message : String(error));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface DefaultKubernetesTransportOptions {
  /**
   * The cluster namespace. When omitted, `kubectl` uses the current context's
   * namespace — the idiomatic default, and one that a config can actually reach,
   * rather than a hardcoded `default` a non-default deployment could never escape.
   */
  readonly namespace?: string;
  readonly secretName: string;
  /** The runner. Defaults to invoking the real binary; injected in the smoke test. */
  readonly run?: KubectlRunner;
}

/**
 * A {@link KubernetesTransport} over `kubectl`. The Secret's `data` is base64 on
 * the wire; this decodes on read and encodes on write, so the provider only ever
 * sees plaintext.
 */
export function defaultKubernetesTransport(
  options: DefaultKubernetesTransportOptions,
): KubernetesTransport {
  const run = options.run ?? defaultKubectlRunner;
  const { namespace, secretName } = options;
  // `-n <ns>` only when a namespace is configured; otherwise kubectl uses the
  // current context's namespace.
  const nsArgs = namespace === undefined ? [] : ["-n", namespace];

  /** The Secret's decoded data map, or `undefined` when the Secret does not exist. */
  function readData(): Record<string, string> | undefined {
    let stdout: string;
    try {
      stdout = run(["get", "secret", secretName, ...nsArgs, "-o", "json"]);
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw mapFailure(error, `read the Secret \`${secretName}\``);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (cause) {
      throw commandFailed(
        `read the Secret \`${secretName}\``,
        `kubectl returned non-JSON: ${String(cause)}`,
      );
    }
    const data = asRecord(asRecord(parsed)?.["data"]) ?? {};
    const out: Record<string, string> = {};
    for (const [key, encoded] of Object.entries(data)) {
      if (typeof encoded === "string") out[key] = Buffer.from(encoded, "base64").toString("utf8");
    }
    return out;
  }

  /** Applies the full data map, creating or replacing the Secret. */
  function applyData(data: Record<string, string>): void {
    const encoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      encoded[key] = Buffer.from(value, "utf8").toString("base64");
    }
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: secretName, namespace },
      type: "Opaque",
      data: encoded,
    });
    try {
      run(["apply", ...nsArgs, "-f", "-"], manifest);
    } catch (error) {
      throw mapFailure(error, `write the Secret \`${secretName}\``);
    }
  }

  return {
    readKey(key) {
      return Promise.resolve(readData()?.[key]);
    },
    writeKey(key, value) {
      const data = readData() ?? {};
      data[key] = value;
      applyData(data);
      return Promise.resolve();
    },
    deleteKey(key) {
      const data = readData();
      if (data === undefined || !(key in data)) return Promise.resolve();
      delete data[key];
      applyData(data);
      return Promise.resolve();
    },
    listKeys() {
      return Promise.resolve(Object.keys(readData() ?? {}));
    },
  };
}
