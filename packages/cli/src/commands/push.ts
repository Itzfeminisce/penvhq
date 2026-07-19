/**
 * `penv push` — ship an environment's values to a provider.
 *
 * The destination is the environment's declared provider, or a one-shot
 * `--destination` override that persists nothing — the declared provider stays
 * the system of record either way. What crosses depends on what the destination
 * declares it holds:
 *
 * - **Records** (Vault, SSM, Kubernetes): the local tree is mirrored verbatim —
 *   unscoped and target-environment value files byte-for-byte (a sealed value
 *   stays sealed; the key never has to be present), plus each parameter's meta.
 *   Both `.local` scopes never cross: a personal override is not something a
 *   shared store has any business holding.
 * - **A projection** (GitHub Actions Secrets): `penv generate` pointed at CI.
 *   The tree is resolved exactly as a deploy would read it — `.local` skipped —
 *   every generated name is judged against the destination's own grammar
 *   *before* the first PUT, and the resolved values cross in plaintext for the
 *   destination to re-seal (sealed values only behind `--allow-decrypt`).
 *
 * A destination-side target that does not exist yet — a GitHub deployment
 * environment — is created only on an explicit yes: the CLI prompts, `--yes`
 * pre-approves for CI, and a refusal names the exact remedy. Creation is an
 * answer, never a guess.
 */

import type {
  AnyProvider,
  Meta,
  MetaBlock,
  ParameterRef,
  PenvConfig,
  ProjectionProvider,
  Provider,
  SecretScope,
  ValueFile,
} from "@penvhq/core";
import {
  checkNameCollisions,
  holdsProjection,
  PenvError,
  requireValue,
  variableName,
} from "@penvhq/core";
import type { FilesystemProvider } from "@penvhq/provider-filesystem";
import { defineCommand } from "citty";
import { shorthandCandidates } from "../env-flags.js";
import { lineReader } from "../input.js";
import type { Project, SyncResolution } from "../project.js";
import {
  keySourceFor,
  localTree,
  openProject,
  PENV_DIR,
  refsFrom,
  resolveAllSync,
  targetEnvironment,
} from "../project.js";
import { createSourceProvider, LOCAL_TREE_TYPE } from "../registry.js";
import { CHECK, formatRows, guard, WARN, write } from "../ui.js";

/** The per-environment meta field recording penv's last push, compared against the destination's `updatedAt`. */
export const LAST_PUSHED_KEY = "lastPushedAt";

export interface PushOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
  /** Permits sealed values to be decrypted locally and pushed as plaintext for the destination to re-seal. */
  readonly allowDecrypt?: boolean;
  /** One-shot destination override: a provider package name. Nothing is persisted. */
  readonly destination?: string;
  /** The destination-side place, when `destination` needs one — `--location`. */
  readonly location?: string;
  /** Pre-approves creating a missing destination-side target (`--yes`). */
  readonly yes?: boolean;
  /** Injected in tests: the destination provider. Defaults to the one the config (or `--destination`) declares. */
  readonly provider?: AnyProvider;
  /** Injected in tests: answers the create-target question. Defaults to a terminal prompt. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Injected in tests: the wall-clock reading recorded in meta. Defaults to now. */
  readonly now?: string;
}

export interface PushResult {
  readonly environment: string;
  /** The destination provider's type — its package name. */
  readonly destination: string;
  /** What the destination holds, which decided what crossed. */
  readonly mode: "records" | "projection";
  /** The `location` targeted, when one was declared. */
  readonly location: string | undefined;
  /** Values sent — resolved secrets for a projection, value files for records. */
  readonly pushed: number;
  /** Meta records mirrored. Records mode only. */
  readonly meta: number;
  readonly repositorySecrets: number;
  readonly environmentSecrets: number;
  /** How many were sealed and crossed as plaintext for the destination to re-seal. */
  readonly decrypted: number;
  /** True when the destination-side target was created by this push, on approval. */
  readonly createdTarget: boolean;
}

/** One value ready to send, with the destination scope it lands in. */
interface Outbound {
  readonly ref: ParameterRef;
  readonly variable: string;
  readonly value: string;
  readonly scope: SecretScope;
  readonly encrypted: boolean;
}

/**
 * The destination provider: the `--destination` override when given, otherwise
 * the environment's declared provider. An environment whose provider is the
 * local tree itself has nowhere to push, and says so.
 */
async function destinationFor(
  project: Project,
  environment: string,
  options: PushOptions,
): Promise<{ provider: AnyProvider; location: string | undefined }> {
  if (options.destination !== undefined) {
    const providerConfig = {
      type: options.destination,
      ...(options.location === undefined ? {} : { location: options.location }),
    };
    const provider =
      options.provider ??
      (await createSourceProvider(options.destination, {
        root: project.penvDir,
        config: project.config,
        providerConfig,
        environment,
      }));
    return { provider, location: options.location };
  }

  const declared = project.config.providers[environment];
  const location = declared?.location;
  if (declared === undefined || declared.type === LOCAL_TREE_TYPE) {
    throw new PenvError(
      "NO_DESTINATION",
      `Environment ${environment}'s provider is the local .penv tree itself, so penv has nowhere to push`,
      `Declare a provider for it in penv.config.ts — e.g. \`${environment}: { type: "@penvhq/provider-github", location: "owner/repo" }\` — ` +
        `or push somewhere once with \`penv push --env ${environment} --destination <package> --location <place>\`.`,
    );
  }
  if (options.provider !== undefined) {
    return { provider: options.provider, location };
  }
  const provider = await createSourceProvider(declared.type, {
    root: project.penvDir,
    config: project.config,
    providerConfig: declared,
    environment,
  });
  return { provider, location };
}

/**
 * Every value to send, resolved up front so the encrypted/allow-decrypt refusal
 * also happens before anything is pushed. A `.local` scope is already gone (the
 * push resolution dropped it), so a winner is only ever environment-scoped or the
 * unscoped default — the destination scope is that binary.
 */
function plan(
  resolutions: readonly SyncResolution[],
  config: PenvConfig,
  environment: string,
  allowDecrypt: boolean,
): Outbound[] {
  const outbound: Outbound[] = [];
  for (const resolution of resolutions) {
    const winner = resolution.winner;
    if (winner === undefined) {
      continue;
    }
    let encrypted = false;
    if (winner.file.encrypted) {
      if (!allowDecrypt) {
        throw new PenvError(
          "ENCRYPTED_VALUE_REFUSED",
          `Parameter ${resolution.parameter} for environment ${environment} resolves to the encrypted value file ${PENV_DIR}/${winner.location}, and a push sends plaintext for the destination to re-seal`,
          "Re-run with `--allow-decrypt` to decrypt it locally and push it, or push an environment " +
            "whose values are plaintext. penv's encryption stops at the projection; the destination " +
            "seals it under its own key.",
        );
      }
      // Throws naming the reason if a sealed winner cannot be opened — never
      // silently dropping the secret CI needs.
      requireValue(resolution, environment);
      encrypted = true;
    }
    if (resolution.value === undefined) {
      continue;
    }
    const scope: SecretScope =
      winner.file.scope.kind === "unscoped"
        ? { kind: "repository" }
        : { kind: "environment", environment };
    outbound.push({
      ref: resolution.ref,
      variable: variableName(resolution.ref, config),
      value: resolution.value,
      scope,
      encrypted,
    });
  }
  return outbound;
}

/** Records what penv did, per environment, in the committed meta — never a value read back. */
function withLastPushed(meta: Meta | undefined, environment: string, iso: string): Meta {
  const base: Meta = meta ?? {};
  const environments: Record<string, MetaBlock> = { ...(base.environments ?? {}) };
  environments[environment] = { ...(environments[environment] ?? {}), [LAST_PUSHED_KEY]: iso };
  return { ...base, environments };
}

function recordPush(
  tree: FilesystemProvider,
  ref: ParameterRef,
  environment: string,
  iso: string,
): void {
  const meta = withLastPushed(tree.readMetaSync(ref), environment, iso);
  tree.writeMetaSync(ref, meta);
}

/** The default create-target prompt: a terminal question, and a refusal anywhere a terminal is not. */
async function terminalConfirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    return false;
  }
  const reader = lineReader();
  try {
    const answer = await reader.ask(`${question} [y/N] `);
    return answer !== undefined && /^y(es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}

/**
 * Makes sure the destination-side target for this environment exists before the
 * first PUT, creating it only on an explicit yes. A destination with no notion
 * of a target (no `targetExists`) passes through untouched.
 */
async function ensureTargetApproved(
  provider: ProjectionProvider,
  environment: string,
  options: PushOptions,
): Promise<boolean> {
  if (provider.targetExists === undefined) {
    return false;
  }
  if (await provider.targetExists(environment)) {
    return false;
  }
  if (provider.ensureTarget === undefined) {
    throw new PenvError(
      "MISSING_TARGET",
      `The destination has no environment \`${environment}\` to receive this push, and this provider cannot create one`,
      `Create the environment on the destination side, then run \`penv push --env ${environment}\` again.`,
    );
  }
  const approved =
    options.yes === true ||
    (await (options.confirm ?? terminalConfirm)(
      `The destination has no environment \`${environment}\`. Create it?`,
    ));
  if (!approved) {
    throw new PenvError(
      "MISSING_TARGET",
      `The destination has no environment \`${environment}\` to receive this push`,
      `Re-run with \`--yes\` to create it, answer \`y\` at the prompt, or create it on the destination side yourself.`,
    );
  }
  await provider.ensureTarget(environment);
  return true;
}

/** The projection push: resolve as CI would read, judge every name, then all or nothing. */
async function pushProjection(
  project: Project,
  provider: ProjectionProvider,
  environment: string,
  location: string | undefined,
  options: PushOptions,
): Promise<PushResult> {
  const tree = localTree(project);
  const keys = keySourceFor(project, environment);
  // The push resolution: both `.local` scopes dropped. CI receives what CI would read.
  const resolutions = resolveAllSync(tree, environment, keys, true);
  const refs = refsFrom(resolutions.map((resolution) => resolution.ref));

  // Every name judged before a single PUT. Exact-string collisions are core's;
  // the destination's reserved prefixes, charset, and case-insensitivity are the
  // provider's own `checkNames`. Both refuse the whole push, never half of it.
  const collision = checkNameCollisions(refs, project.config)[0];
  if (collision !== undefined) {
    throw collision;
  }
  const nameError = provider.checkNames?.(refs, project.config)[0];
  if (nameError !== undefined) {
    throw nameError;
  }

  const outbound = plan(resolutions, project.config, environment, options.allowDecrypt === true);

  // Reachable and writable, or penv stops here having placed nothing.
  await provider.verify();

  // The target exists — or was just created on an explicit yes — before any PUT.
  const createdTarget =
    outbound.some((item) => item.scope.kind === "environment") &&
    (await ensureTargetApproved(provider, environment, options));

  let repositorySecrets = 0;
  let environmentSecrets = 0;
  for (const item of outbound) {
    await provider.push(item.variable, item.value, item.scope);
    if (item.scope.kind === "repository") {
      repositorySecrets += 1;
    } else {
      environmentSecrets += 1;
    }
    // Stamped AFTER the push, per item — not once before the loop. The destination
    // stamps each secret's `updated_at` when its own PUT lands, and one process
    // runs per parameter, so a single pre-loop time would sit seconds behind the
    // destination's and make `doctor`'s hand-edit check fire on a clean push.
    recordPush(tree, item.ref, environment, options.now ?? new Date().toISOString());
  }

  return {
    environment,
    destination: provider.type,
    mode: "projection",
    location,
    pushed: outbound.length,
    meta: 0,
    repositorySecrets,
    environmentSecrets,
    decrypted: outbound.filter((item) => item.encrypted).length,
    createdTarget,
  };
}

/** Whether a value file crosses on a records push: the unscoped default and the target environment's scope. */
function crossesToRecords(file: ValueFile, environment: string): boolean {
  const scope = file.scope;
  if (scope.kind === "unscoped") {
    return true;
  }
  return scope.kind === "environment" && scope.environment === environment;
}

/**
 * The records push: mirror the tree verbatim. A value is an opaque envelope the
 * destination holds and hands back unchanged — sealed stays sealed, so the key
 * that opens it never has to be present to push it. Both `.local` scopes stay
 * home, and other environments' scoped values stay out of this environment's
 * store — the destination ends up holding exactly what a pull for this
 * environment would bring back.
 */
async function pushRecords(
  project: Project,
  provider: Provider,
  environment: string,
  location: string | undefined,
): Promise<PushResult> {
  const tree = localTree(project);
  const files = tree.listSync().filter((file) => crossesToRecords(file, environment));

  let pushed = 0;
  for (const file of files) {
    const value = tree.readSync(file);
    if (value === undefined) {
      continue;
    }
    await provider.write(file, value);
    pushed += 1;
  }

  const refs = refsFrom(files);
  let meta = 0;
  for (const ref of refs) {
    const block = tree.readMetaSync(ref);
    if (block === undefined) {
      continue;
    }
    await provider.writeMeta(ref, block);
    meta += 1;
  }

  return {
    environment,
    destination: provider.type,
    mode: "records",
    location,
    pushed,
    meta,
    repositorySecrets: 0,
    environmentSecrets: 0,
    decrypted: 0,
    createdTarget: false,
  };
}

export async function runPush(options: PushOptions): Promise<PushResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment, options.envFlags);
  const { provider, location } = await destinationFor(project, environment, options);

  if (holdsProjection(provider)) {
    return pushProjection(project, provider, environment, location, options);
  }
  return pushRecords(project, provider, environment, location);
}

export function renderPush(result: PushResult): string[] {
  if (result.pushed === 0 && result.meta === 0) {
    return formatRows([
      {
        glyph: CHECK,
        label: "Nothing to push",
        subject: `no values resolve for environment ${result.environment}`,
      },
    ]);
  }

  const target = `${result.destination} for environment ${result.environment}${
    result.location === undefined ? "" : ` (${result.location})`
  }`;

  if (result.mode === "records") {
    return formatRows([
      {
        glyph: CHECK,
        label: "Pushed",
        subject: `${result.pushed} value ${result.pushed === 1 ? "file" : "files"}, ${result.meta} meta`,
        detail: `mirrored verbatim to ${target}`,
      },
      {
        glyph: CHECK,
        label: "Sealed values",
        subject: "crossed byte-for-byte, still sealed",
        detail: "the destination holds envelopes; no key was needed to push them",
      },
    ]);
  }

  const rows = [
    {
      glyph: CHECK,
      label: "Pushed",
      subject: `${result.pushed} ${result.pushed === 1 ? "secret" : "secrets"}`,
      detail: `to ${target}`,
    },
    {
      glyph: CHECK,
      label: "Scopes",
      subject: `${result.environmentSecrets} environment, ${result.repositorySecrets} repository`,
      detail:
        "environment secrets override repository secrets, as penv's env scope overrides the default",
    },
  ];
  if (result.createdTarget) {
    rows.push({
      glyph: CHECK,
      label: "Created",
      subject: `the destination environment ${result.environment}`,
      detail: "it did not exist yet; created on your approval",
    });
  }
  if (result.decrypted > 0) {
    rows.push({
      glyph: WARN,
      label: "Decrypted",
      subject: `${result.decrypted} ${result.decrypted === 1 ? "secret" : "secrets"}`,
      detail: "sent as plaintext for the destination to re-seal under its own key",
    });
  }
  return formatRows(rows);
}

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push an environment's values to its provider",
  },
  args: {
    env: { type: "string", description: "The environment to push" },
    "allow-decrypt": {
      type: "boolean",
      description:
        "Decrypt sealed values locally and push them as plaintext for the destination to re-seal",
    },
    destination: {
      type: "string",
      alias: ["dest", "d"],
      description: "Push once to this provider package instead of the declared one",
    },
    location: {
      type: "string",
      alias: "l",
      description: "The destination-side place, when --destination needs one",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Create a missing destination-side environment without prompting",
    },
  },
  run({ args }) {
    return guard(async () => {
      const result = await runPush({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args["allow-decrypt"] === undefined ? {} : { allowDecrypt: args["allow-decrypt"] }),
        ...(args.destination === undefined ? {} : { destination: args.destination }),
        ...(args.location === undefined ? {} : { location: args.location }),
        ...(args.yes === undefined ? {} : { yes: args.yes }),
        envFlags: shorthandCandidates(args, [
          "env",
          "allow-decrypt",
          "allowDecrypt",
          "destination",
          "dest",
          "d",
          "location",
          "l",
          "yes",
          "y",
        ]),
      });
      write(renderPush(result));
    });
  },
});
