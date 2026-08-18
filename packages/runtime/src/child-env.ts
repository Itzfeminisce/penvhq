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
 *
 * The record penv assembles reads names the way the platform does. Windows'
 * environment block is case-insensitive, so a host that exports `Database_Url`
 * and a delete of `DATABASE_URL` are one variable there — and a plain object
 * spread out of `process.env` would lose that, missing the delete and handing
 * the child the stale value. See {@link childRecord}.
 */

import type { ParameterRef, PenvConfig } from "@penvhq/core";
import { deliveryNames, own, PenvError } from "@penvhq/core";
import type { z } from "zod";
import {
  CONTROL_VARIABLES,
  DELIVERY_VARIABLE,
  ENVIRONMENT_VARIABLE,
  RUN_MARKER,
} from "./control.js";
import { declaredRefs, inject } from "./inject.js";

export {
  DELIVERY_VARIABLE,
  ENVIRONMENT_VARIABLE,
  RUN_MARKER,
  SNAPSHOT_VARIABLE,
} from "./control.js";

/** Every exported encryption key. penv unwraps keys; the application never holds one. */
const KEY_PREFIX = "PENV_KEY_";

/**
 * What each provider package penv ships authenticates with.
 *
 * penv deliberately owns no credential of its own — `VAULT_ADDR`/`VAULT_TOKEN`
 * are the Vault CLI's, `gh auth login` keeps GitHub's — so a provider's
 * credentials are ambient variables rather than config fields, and the only way
 * to keep them out of the child is to name them. They are stripped only for the
 * providers the config actually declares: a project that never mentions Vault
 * has no reason to lose `VAULT_TOKEN`.
 *
 * These four are the ones penv ships and therefore knows. Any other extension
 * names its own in `penv.credentials`, which the CLI resolves from the installed
 * package and passes in as {@link ChildEnvironmentInput.credentials} — a
 * stranger's credentials are exactly the ones penv cannot guess.
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

/** What an extension declares it authenticates with: provider package name → variables. */
export type DeclaredCredentials = Readonly<Record<string, readonly string[]>>;

/** Whether this platform's environment block matches names case-insensitively. Windows' does. */
function caseInsensitiveNames(): boolean {
  return process.platform === "win32";
}

/**
 * The record the child environment is assembled in.
 *
 * On POSIX it is the plain copy it looks like: names there are bytes, and
 * `DATABASE_URL` and `Database_Url` are two variables. On Windows they are one,
 * so the copy is wrapped in a view that resolves every read, write, delete and
 * `in` to whichever spelling the host used — which is what makes the strip find
 * an inherited `penv_key_prod`, and the exclusivity delete find a stale
 * `Database_Url`. The spelling the host chose is kept: Node hands the child the
 * key as it stands, and Windows resolves it either way.
 */
function childRecord(host: Environment): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = { ...host };
  if (!caseInsensitiveNames()) {
    return record;
  }
  const spelling = (name: string): string | undefined => {
    const upper = name.toUpperCase();
    return Object.keys(record).find((key) => key.toUpperCase() === upper);
  };
  return new Proxy(record, {
    get: (target, property) =>
      typeof property === "string"
        ? target[spelling(property) ?? property]
        : Reflect.get(target, property),
    set(target, property, value: string) {
      if (typeof property !== "string") {
        return Reflect.set(target, property, value);
      }
      target[spelling(property) ?? property] = value;
      return true;
    },
    has: (target, property) =>
      typeof property === "string"
        ? spelling(property) !== undefined
        : Reflect.has(target, property),
    getOwnPropertyDescriptor: (target, property) =>
      Reflect.getOwnPropertyDescriptor(
        target,
        typeof property === "string" ? (spelling(property) ?? property) : property,
      ),
    deleteProperty(target, property) {
      if (typeof property !== "string") {
        return Reflect.deleteProperty(target, property);
      }
      const upper = property.toUpperCase();
      for (const key of Object.keys(target)) {
        if (key.toUpperCase() === upper) {
          delete target[key];
        }
      }
      return true;
    },
  });
}

/**
 * The variables that are penv's own wherever a run reads from: its control
 * channels and every exported key.
 *
 * A run from an artifact removes exactly these and no more. It declares no
 * provider — there is no config to declare one in, and nothing in the artifact
 * authenticates with anything — so the credentials below are not penv's to take
 * there, and deleting a container's `AWS_ACCESS_KEY_ID` because some other
 * project uses SSM would break an application that legitimately reads it.
 *
 * A key is matched by prefix under the platform's own name rules, so a host that
 * exported `penv_key_prod` on Windows — where that *is* `PENV_KEY_PROD`, and
 * where the key source duly reads it — loses it here like any other.
 */
function penvOwnVariables(host: Environment): Set<string> {
  const names = new Set<string>(CONTROL_VARIABLES);
  const insensitive = caseInsensitiveNames();
  for (const name of Object.keys(host)) {
    if ((insensitive ? name.toUpperCase() : name).startsWith(KEY_PREFIX)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The variables penv removes before the application starts: its keys, the
 * declared providers' credentials, and its own control channels. Sorted, so a
 * report of what was stripped reads the same on every machine.
 *
 * `credentials` is what the extensions this config names declare about
 * themselves; the four providers penv ships are known here. Both are consulted,
 * so a first-party provider that grows a declaration of its own adds to the set
 * rather than replacing it.
 */
export function strippedVariables(
  host: Environment,
  config: PenvConfig,
  credentials?: DeclaredCredentials,
): string[] {
  const names = penvOwnVariables(host);
  for (const provider of Object.values(config.providers)) {
    for (const name of own(PROVIDER_CREDENTIALS, provider.type) ?? []) {
      names.add(name);
    }
    for (const name of own(credentials, provider.type) ?? []) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Removes `names` from `child`, reporting the ones that were actually there. */
function strip(child: Record<string, string | undefined>, names: readonly string[]): string[] {
  const stripped: string[] = [];
  for (const name of names) {
    if (name in child) {
      stripped.push(name);
    }
    delete child[name];
  }
  return stripped;
}

/** Drops the `undefined` holes a delete leaves, so the child gets a plain record. */
function compact(child: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(child)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
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
   * What the config's providers declare they authenticate with — `penv.credentials`
   * in each installed package, resolved by the CLI. Absent means only the
   * providers penv ships are known, which is all a caller without a project has.
   */
  readonly credentials?: DeclaredCredentials;
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
  const child = childRecord(input.host);

  // First: penv's own variables leave, including any marker this process
  // inherited. Doing it after the stamp below would delete the marker the child
  // is supposed to carry.
  const stripped = strip(child, strippedVariables(input.host, input.config, input.credentials));

  // Then: the schema's parameters, written or deleted — `inject`'s exclusivity,
  // aimed at the child rather than at this process.
  const { written, deleted } = inject({
    schema: input.schema,
    config: input.config,
    values: input.values,
    ...(input.validated === undefined ? {} : { validated: input.validated }),
    target: child,
  });

  stampControl(child, {
    environment: input.environment,
    invocation: input.invocation,
    names: deliveryNames(declaredRefs(input.schema), input.config),
  });
  return { env: compact(child), written, deleted, stripped };
}

/** One delivery mapping as an artifact-backed run hands it over: opened, or resolved to nothing. */
export interface DeliveredValue {
  /** The parameter id, so the bridge can map the variable back to its schema key. */
  readonly parameter: string;
  readonly variable: string;
  /** Absent when the artifact carries no non-local winner — the variable is deleted. */
  readonly value?: string;
}

export interface DeliveredEnvironmentInput {
  readonly host: Environment;
  readonly environment: string;
  /** Every schema-declared delivery mapping the artifact carries, already opened. */
  readonly values: readonly DeliveredValue[];
  readonly invocation: string;
}

/**
 * The child environment for a run from a sealed artifact.
 *
 * The same environment `childEnvironment` builds, reached without a schema, a
 * config, or a tree — because in a container there are none. The artifact
 * already *is* the delivery contract: it names every schema-declared mapping and
 * says whether it has a value, so exclusivity is carried rather than recomputed,
 * and the same variable is written or deleted here as would be from the project.
 */
export function deliveredEnvironment(input: DeliveredEnvironmentInput): ChildEnvironment {
  const child = childRecord(input.host);
  const stripped = strip(child, [...penvOwnVariables(input.host)].sort());

  let written = 0;
  let deleted = 0;
  for (const { variable, value } of input.values) {
    if (value !== undefined) {
      child[variable] = value;
      written += 1;
      continue;
    }
    if (variable in child) {
      delete child[variable];
      deleted += 1;
    }
  }

  stampControl(child, {
    environment: input.environment,
    invocation: input.invocation,
    names: Object.fromEntries(input.values.map(({ parameter, variable }) => [parameter, variable])),
  });
  return { env: compact(child), written, deleted, stripped };
}

/**
 * Last: the environment penv resolved, the delivery contract, and the marker.
 *
 * Stamped after the strip, never before — an inherited marker must not survive
 * into the child pretending to be this run, and the one this run writes must not
 * be swept away by its own strip. A nested `penv run` reads the marker; the
 * bridge reads the environment and the contract, then takes both control
 * variables back out, so the application sees none of penv talking to penv.
 */
function stampControl(
  child: Record<string, string | undefined>,
  what: {
    readonly environment: string;
    readonly invocation: string;
    readonly names: Readonly<Record<string, string>>;
  },
): void {
  child[ENVIRONMENT_VARIABLE] = what.environment;
  child[DELIVERY_VARIABLE] = JSON.stringify(what.names);
  child[RUN_MARKER] = what.invocation;
}

/** What `penv run` told this process about itself, once the bridge has taken it. */
export interface Delivery {
  /** The `penv run` that started this process, or absent when nothing did. */
  readonly invocation: string | undefined;
  /** Parameter id → the variable it was delivered under. Empty for a direct start. */
  readonly names: Readonly<Record<string, string>>;
}

/**
 * What `penv run` left for this process, taken out of `process.env` as it is
 * read.
 *
 * Read once and remembered: the bridge asks on every `load`, and the answer must
 * not change because the first call cleared the variables. Taking them out is
 * what makes them penv's alone — a nested `penv run` checks before any schema
 * loads and still sees the marker, while the application, whose first act is the
 * bridge, never does.
 *
 * A contract that is not one is remembered the same way, as a refusal rather
 * than an answer. The variables are gone by then, so a second `load` would
 * otherwise find nothing, guess the default names, and deliver whatever happened
 * to match — which is the one thing this channel exists to prevent.
 */
let consumed: Delivery | undefined;
let refused: PenvError | undefined;

export function consumeDelivery(env: Record<string, string | undefined> = process.env): Delivery {
  if (refused !== undefined) {
    throw refused;
  }
  if (consumed === undefined) {
    const invocation = env[RUN_MARKER];
    const contract = env[DELIVERY_VARIABLE];
    delete env[RUN_MARKER];
    delete env[DELIVERY_VARIABLE];
    let names: Readonly<Record<string, string>>;
    try {
      names = parseNames(contract);
    } catch (error) {
      refused = error as PenvError;
      throw refused;
    }
    consumed = { invocation, names };
  }
  return consumed;
}

/**
 * The delivery contract, read back.
 *
 * penv wrote it one line earlier in the same run, so anything that is not a flat
 * map of strings is a channel that was tampered with rather than a format to
 * tolerate — and guessing the names instead would deliver a schema parameter
 * from whatever variable happened to match.
 */
function parseNames(contract: string | undefined): Readonly<Record<string, string>> {
  if (contract === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidDelivery();
  }
  const names: Record<string, string> = {};
  for (const [id, variable] of Object.entries(parsed)) {
    if (typeof variable !== "string") {
      throw invalidDelivery();
    }
    names[id] = variable;
  }
  return names;
}

function invalidDelivery(): PenvError {
  return new PenvError(
    "DELIVERY_CONTRACT_INVALID",
    `${DELIVERY_VARIABLE} does not hold the delivery contract \`penv run\` writes`,
    `Unset ${DELIVERY_VARIABLE} and start the application with \`penv run\` — it is penv's own channel, not a variable to set.`,
  );
}

/** Test seam: forgets what was consumed, so a test can set up another process's view. */
export function resetDelivery(): void {
  consumed = undefined;
  refused = undefined;
}
