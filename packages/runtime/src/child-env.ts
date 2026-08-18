/**
 * The environment `penv run` hands its child.
 *
 * penv owns this environment rather than decorating the one it inherited. Every
 * parameter the schema declares is written under its generated name, or
 * **deleted** when the schema excuses it and nothing resolved — a stale
 * `REDIS_PASSWORD` in a shell must not stand in for a value penv resolved to
 * nothing, which is the same exclusivity {@link inject} already applies to
 * `process.env`. That is why the writing half is `inject` itself, pointed at a
 * plain record instead: two implementations of "these variables are penv's"
 * would eventually disagree about one of them.
 *
 * Everything unrelated — `PATH`, `HOME`, the user's own variables — is left
 * exactly as it arrived. What is removed is penv's own: key material, the
 * credentials the CLI's provider tooling authenticates with, and the control
 * variables penv talks to itself through.
 *
 * The order is the design, not an accident of writing it down. Stripping runs
 * first and the run marker is stamped last, so an inherited marker from an outer
 * `penv run` cannot survive into the child pretending to be this one — and the
 * marker this run stamps is not swept away by its own strip.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { own } from "@penvhq/core";
import type { z } from "zod";
import { inject } from "./inject.js";

/**
 * The variable a `penv run` leaves in its child so a nested `penv run` can see
 * it. Its value is the outer invocation, which is what makes the nested refusal
 * able to name both.
 *
 * It is penv talking to penv. The application never reads it — the bridge takes
 * it out of `process.env` on the first `load` (see {@link consumeRunMarker}),
 * while a nested penv, which never loads a schema before checking, still finds
 * it.
 */
export const RUN_MARKER = "PENV_RUN";

/** The environment `run` pins for the child, so the bridge reads what penv resolved. */
export const ENVIRONMENT_VARIABLE = "PENV_ENV";

/**
 * penv's internal channels. They are penv's business with itself, and an
 * application that inherited one would be reading a message addressed to
 * somewhere else — `PENV_SNAPSHOT` above all, whose whole point is that the
 * artifact is opened once, in the parent, and never again.
 */
const CONTROL_VARIABLES = [RUN_MARKER, "PENV_SCHEMA_HARVEST", "PENV_SNAPSHOT"] as const;

/** Every exported encryption key. penv unwraps keys; the application never holds one. */
const KEY_PREFIX = "PENV_KEY_";

/**
 * What each provider package authenticates with.
 *
 * penv deliberately owns no credential of its own — `VAULT_ADDR`/`VAULT_TOKEN`
 * are the Vault CLI's, `gh auth login` keeps GitHub's — so a provider's
 * credentials are ambient variables rather than config fields, and the only way
 * to keep them out of the child is to name them. They are stripped only for the
 * providers the config actually declares: a project that never mentions Vault
 * has no reason to lose `VAULT_TOKEN`.
 *
 * `AWS_REGION` is deliberately absent. It is a destination, not a credential,
 * and applications legitimately read it.
 */
const PROVIDER_CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  "@penvhq/provider-vault": [
    "VAULT_TOKEN",
    "VAULT_ADDR",
    "VAULT_NAMESPACE",
    "VAULT_CACERT",
    "VAULT_CLIENT_CERT",
    "VAULT_CLIENT_KEY",
  ],
  "@penvhq/provider-ssm": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
  ],
  "@penvhq/provider-kubernetes": ["KUBECONFIG", "KUBE_TOKEN"],
  "@penvhq/provider-github": ["GH_TOKEN", "GITHUB_TOKEN"],
};

/** The environment shape both the host and the child are read and written as. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The variables penv removes before the application starts: its keys, the
 * declared providers' credentials, and its own control channels. Sorted, so a
 * report of what was stripped reads the same on every machine.
 */
export function strippedVariables(host: Environment, config: PenvConfig): string[] {
  const names = new Set<string>(CONTROL_VARIABLES);
  for (const name of Object.keys(host)) {
    if (name.startsWith(KEY_PREFIX)) {
      names.add(name);
    }
  }
  for (const provider of Object.values(config.providers)) {
    for (const name of own(PROVIDER_CREDENTIALS, provider.type) ?? []) {
      names.add(name);
    }
  }
  return [...names].sort();
}

export interface ChildEnvironmentInput {
  /** The environment penv itself was started with — `process.env` in the command. */
  readonly host: Environment;
  readonly config: PenvConfig;
  readonly environment: string;
  /** The schema, which decides exactly which variables penv owns. */
  readonly schema: z.ZodType;
  /** The tree's raw values, as the provider holds them — strings, never coerced. */
  readonly values: readonly { readonly ref: ParameterRef; readonly value: string }[];
  /** The schema-validated object, so a `.default()` reaches the child too. */
  readonly validated?: unknown;
  /**
   * The `penv run` invocation starting this child, as the user typed it. Stamped
   * into {@link RUN_MARKER} so a nested run can name the wrapper it is inside.
   */
  readonly invocation: string;
}

/** What the assembly did, for the one line `run` prints. */
export interface ChildEnvironment {
  readonly env: Record<string, string>;
  /** Declared variables written from a value or a schema default. */
  readonly written: number;
  /** Declared-but-valueless variables deleted from the inherited environment. */
  readonly deleted: number;
  /** penv's own variables removed before the child saw them. */
  readonly stripped: readonly string[];
}

export function childEnvironment(input: ChildEnvironmentInput): ChildEnvironment {
  const child: Record<string, string | undefined> = { ...input.host };

  // First: penv's own variables leave, including any marker this process
  // inherited. Doing it after the stamp below would delete the marker the child
  // is supposed to carry.
  const stripped: string[] = [];
  for (const name of strippedVariables(input.host, input.config)) {
    if (name in child) {
      stripped.push(name);
    }
    delete child[name];
  }

  // Then: the schema's parameters, written or deleted — `inject`'s exclusivity,
  // aimed at the child rather than at this process.
  const { written, deleted } = inject({
    schema: input.schema,
    config: input.config,
    values: input.values,
    ...(input.validated === undefined ? {} : { validated: input.validated }),
    target: child,
  });

  // Last: the environment penv resolved, and the marker. A nested `penv run`
  // reads the marker; the bridge reads the environment and then takes the marker
  // back out, so the application sees neither penv talking to penv.
  child[ENVIRONMENT_VARIABLE] = input.environment;
  child[RUN_MARKER] = input.invocation;

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(child)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { env, written, deleted, stripped };
}

/**
 * The outer `penv run` invocation this process was started by, taken out of
 * `process.env` as it is read.
 *
 * Read once and remembered: the bridge asks on every `load`, and the answer must
 * not change because the first call cleared the variable. Taking it out is what
 * makes the marker penv's alone — a nested `penv run` checks before any schema
 * loads and still sees it, while the application, whose first act is the bridge,
 * never does.
 */
let consumed: { readonly invocation: string | undefined } | undefined;

export function consumeRunMarker(env: Record<string, string | undefined> = process.env): {
  readonly invocation: string | undefined;
} {
  if (consumed === undefined) {
    const invocation = env[RUN_MARKER];
    delete env[RUN_MARKER];
    consumed = { invocation };
  }
  return consumed;
}

/** Test seam: forgets the consumed marker, so a test can set up another process's view. */
export function resetRunMarker(): void {
  consumed = undefined;
}
