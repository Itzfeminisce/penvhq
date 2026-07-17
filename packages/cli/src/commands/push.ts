/**
 * `penv push` — resolve an environment's values and ship them to its sink.
 *
 * This is `penv generate` pointed at CI. It resolves the tree exactly as a
 * deploy would read it — **both `.local` scopes skipped**, because a developer's
 * personal override is not CI's business — judges every generated name against
 * the destination's grammar *before* the first PUT, and only then pushes. The
 * push is all or nothing: a name refused mid-run would leave CI in a state
 * neither the tree nor the destination describes.
 *
 * The mapping is the RFC's: an environment-scoped value becomes a GitHub
 * environment secret of the same name, the unscoped default becomes a repository
 * secret, and GitHub resolves the two in penv's own order — environment over
 * repository — so the cascade is reproduced by the destination's native
 * mechanism rather than flattened at the boundary.
 */

import type { Meta, MetaBlock, ParameterRef, PenvConfig, SecretScope, Sink } from "@penv/core";
import { checkNameCollisions, PenvError, requireValue, variableName } from "@penv/core";
import { checkGithubNames, createGithubSink } from "@penv/sink-github";
import { defineCommand } from "citty";
import type { Project, SyncResolution } from "../project.js";
import {
  keySourceFor,
  openProject,
  PENV_DIR,
  refsFrom,
  resolveAllSync,
  targetEnvironment,
} from "../project.js";
import { CHECK, formatRows, guard, WARN, write } from "../ui.js";

/** The per-environment meta field recording penv's last push, compared against the destination's `updatedAt`. */
export const LAST_PUSHED_KEY = "lastPushedAt";

export interface PushOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Permits sealed values to be decrypted locally and pushed as plaintext for the destination to re-seal. */
  readonly allowDecrypt?: boolean;
  /** Injected in tests: the sink to push to. Defaults to the one the config declares. */
  readonly sink?: Sink;
  /** Injected in tests: the wall-clock reading recorded in meta. Defaults to now. */
  readonly now?: string;
}

export interface PushResult {
  readonly environment: string;
  /** The `owner/repo` targeted, when the config named one. */
  readonly repo: string | undefined;
  readonly pushed: number;
  readonly repositorySecrets: number;
  readonly environmentSecrets: number;
  /** How many were sealed and crossed as plaintext for the destination to re-seal. */
  readonly decrypted: number;
}

/** One value ready to send, with the destination scope it lands in. */
interface Outbound {
  readonly ref: ParameterRef;
  readonly variable: string;
  readonly value: string;
  readonly scope: SecretScope;
  readonly encrypted: boolean;
}

/** The sink the config declares for this environment, or the injected one. */
function sinkFor(
  project: Project,
  environment: string,
  override: Sink | undefined,
): { sink: Sink; repo: string | undefined } {
  const declared = project.config.sinks?.[environment];
  if (declared === undefined) {
    throw new PenvError(
      "NO_SINK",
      `Environment ${environment} declares no sink in penv.config.ts, so penv has nowhere to push`,
      `Add a \`sinks\` entry, e.g. \`sinks: { ${environment}: { type: "github" } }\`, then run \`penv push --env ${environment}\` again.`,
    );
  }
  const repo = declared.repo;
  if (override !== undefined) {
    return { sink: override, repo };
  }
  if (declared.type === "github") {
    return { sink: createGithubSink(repo === undefined ? {} : { repo }), repo };
  }
  throw new PenvError(
    "UNKNOWN_SINK",
    `Environment ${environment} declares sink type \`${declared.type}\`, which penv does not know`,
    'The only sink in this release is `github`. Set `type: "github"`.',
  );
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
          `Parameter ${resolution.parameter} for environment ${environment} resolves to the encrypted value file ${PENV_DIR}/${winner.location}, and a push sends plaintext for GitHub to re-seal`,
          "Re-run with `--allow-decrypt` to decrypt it locally and push it, or push an environment " +
            "whose values are plaintext. penv's encryption stops at the sink; the destination seals it " +
            "under its own key.",
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

function recordPush(project: Project, ref: ParameterRef, environment: string, iso: string): void {
  const meta = withLastPushed(project.provider.readMetaSync(ref), environment, iso);
  project.provider.writeMetaSync(ref, meta);
}

export async function runPush(options: PushOptions): Promise<PushResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);
  const { sink, repo } = sinkFor(project, environment, options.sink);

  const keys = keySourceFor(project, environment);
  // The push resolution: both `.local` scopes dropped. CI receives what CI would read.
  const resolutions = resolveAllSync(project.provider, environment, keys, true);
  const refs = refsFrom(resolutions.map((resolution) => resolution.ref));

  // Every name judged before a single PUT. Exact-string collisions are core's;
  // GitHub's reserved prefix, leading digit, charset, and case-insensitive
  // collisions are the sink's. Both refuse the whole push, never half of it.
  const collision = checkNameCollisions(refs, project.config)[0];
  if (collision !== undefined) {
    throw collision;
  }
  const nameError = checkGithubNames(refs, project.config)[0];
  if (nameError !== undefined) {
    throw nameError;
  }

  const outbound = plan(resolutions, project.config, environment, options.allowDecrypt === true);

  // Reachable and writable, or penv stops here having placed nothing.
  await sink.verify();

  let repositorySecrets = 0;
  let environmentSecrets = 0;
  for (const item of outbound) {
    await sink.push(item.variable, item.value, item.scope);
    if (item.scope.kind === "repository") {
      repositorySecrets += 1;
    } else {
      environmentSecrets += 1;
    }
    // Stamped AFTER the push, per item — not once before the loop. The destination
    // stamps each secret's `updated_at` when its own PUT lands, and one `gh`
    // process runs per parameter, so a single pre-loop time would sit seconds
    // behind the destination's and make `doctor`'s hand-edit check fire on a clean
    // push. A tolerance in `doctor` still absorbs the residual clock skew.
    recordPush(project, item.ref, environment, options.now ?? new Date().toISOString());
  }

  return {
    environment,
    repo,
    pushed: outbound.length,
    repositorySecrets,
    environmentSecrets,
    decrypted: outbound.filter((item) => item.encrypted).length,
  };
}

export function renderPush(result: PushResult): string[] {
  if (result.pushed === 0) {
    return formatRows([
      {
        glyph: CHECK,
        label: "Nothing to push",
        subject: `no values resolve for environment ${result.environment}`,
      },
    ]);
  }

  const target = `GitHub Actions for environment ${result.environment}${
    result.repo === undefined ? "" : ` (${result.repo})`
  }`;
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
  if (result.decrypted > 0) {
    rows.push({
      glyph: WARN,
      label: "Decrypted",
      subject: `${result.decrypted} ${result.decrypted === 1 ? "secret" : "secrets"}`,
      detail: "sent as plaintext for GitHub to re-seal under its own key",
    });
  }
  return formatRows(rows);
}

export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push an environment's resolved values to its sink (GitHub Actions Secrets)",
  },
  args: {
    env: { type: "string", description: "The environment to push" },
    "allow-decrypt": {
      type: "boolean",
      description: "Decrypt sealed values locally and push them as plaintext for GitHub to re-seal",
    },
  },
  run({ args }) {
    return guard(async () => {
      const result = await runPush({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        ...(args["allow-decrypt"] === undefined ? {} : { allowDecrypt: args["allow-decrypt"] }),
      });
      write(renderPush(result));
    });
  },
});
