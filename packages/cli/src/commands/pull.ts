/**
 * `penv pull` — materialise the local `.penv` tree from an environment's
 * source-of-truth provider. It is the inverse of the deploy-time injection most
 * stacks already have: instead of reading the tree to feed a backend, it reads
 * the backend to feed the tree.
 *
 * It only means anything when the environment declares a real backend
 * (`vault`, `mock`): those hold the truth somewhere penv does not edit in place,
 * and pulling copies it down so every other command — which reads the local tree
 * — sees it. An environment with no separate `providers` entry has the local
 * tree *as* its source of truth, so a pull would be the tree copying onto
 * itself; that degenerate case is reported as nothing to do, never a self-copy.
 *
 * Values cross verbatim. They are opaque envelope strings the source holds and
 * penv does not open here — a sealed value stays sealed, byte-for-byte, so the
 * key that opens it never has to be present to pull it.
 */

import type { AnyProvider, Meta, ProjectionProvider } from "@penvhq/core";
import { holdsProjection, refFromVariable } from "@penvhq/core";
import { defineCommand } from "citty";
import { shorthandCandidates } from "../env-flags.js";
import type { Project } from "../project.js";
import {
  localTree,
  openProject,
  refsFrom,
  sourceProviderFor,
  targetEnvironment,
} from "../project.js";
import { LOCAL_TREE_TYPE } from "../registry.js";
import { CHECK, formatRows, guard, WARN, write } from "../ui.js";

export interface PullOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Bare flags the command did not declare — environment shorthands, judged against the whitelist. */
  readonly envFlags?: readonly string[];
  /** Injected in tests: the source provider. Defaults to the one the config declares. */
  readonly source?: AnyProvider;
}

export interface PullResult {
  readonly environment: string;
  /** The source provider's type — `filesystem` when the environment declares no separate backend. */
  readonly source: string;
  /**
   * True when the source *is* the local tree, so there was nothing to pull. The
   * caller distinguishes "pulled nothing because the backend was empty" from
   * "there is no backend to pull from" — opposite situations.
   */
  readonly localSource: boolean;
  /** Value files written into the local tree. */
  readonly values: number;
  /** Meta files written into the local tree. */
  readonly meta: number;
  /** Distinct parameters the pull touched, at any scope. */
  readonly refs: number;
  /**
   * True when the source declares `readsValues: false`: names and meta came
   * down, values stayed absent — the destination never returns one, and the
   * pull says so rather than dressing emptiness as freshness.
   */
  readonly valuesUnreadable?: boolean;
}

/**
 * Pull from a value-withholding provider: materialise what the store can
 * honestly give. Listing names is the one read it allows, so each name comes
 * down as a flat parameter (the same `refFromVariable` mapping `import` uses —
 * structure is never guessed back out of a flat namespace), a meta stub marks
 * the parameters the destination holds, and values stay absent for
 * `penv validate` to flag and the user to fill.
 */
async function pullProjection(
  project: Project,
  source: ProjectionProvider,
  environment: string,
): Promise<PullResult> {
  const tree = localTree(project);
  const names = new Set<string>();
  for (const secret of await source.list({ kind: "repository" })) {
    names.add(secret.name);
  }
  for (const secret of await source.list({ kind: "environment", environment })) {
    names.add(secret.name);
  }

  let meta = 0;
  for (const name of [...names].sort()) {
    const ref = refFromVariable(name);
    // A stub only where no meta exists: a pull must never overwrite policy the
    // user already wrote with an empty marker.
    if (tree.readMetaSync(ref) === undefined) {
      tree.writeMetaSync(ref, {});
      meta += 1;
    }
  }

  return {
    environment,
    source: source.type,
    localSource: false,
    values: 0,
    meta,
    refs: names.size,
    valuesUnreadable: true,
  };
}

export async function runPull(options: PullOptions): Promise<PullResult> {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment, options.envFlags);
  const source = options.source ?? (await sourceProviderFor(project, environment));

  // The local tree already IS the source of truth for an environment with no
  // declared backend: `sourceProviderFor` handed back the filesystem tree, and
  // pulling it onto itself would be a no-op dressed as work. Report the truth.
  if (source.type === LOCAL_TREE_TYPE) {
    return { environment, source: source.type, localSource: true, values: 0, meta: 0, refs: 0 };
  }

  // A projection-holding source cannot return values, so its pull is the
  // names-and-meta materialisation — everything the store honestly has.
  if (holdsProjection(source)) {
    return pullProjection(project, source, environment);
  }

  const tree = localTree(project);
  const files = await source.list();

  let values = 0;
  for (const file of files) {
    const value = await source.read(file);
    // Absent is not written: `list` and `read` can disagree across a concurrent
    // prune, and a missing value is nothing to materialise.
    if (value === undefined) {
      continue;
    }
    // Verbatim — the value is an opaque envelope, sealed or not, and penv does
    // not open it to move it.
    tree.writeSync(file, value);
    values += 1;
  }

  // Meta is per-parameter, so it is pulled once per distinct ref rather than once
  // per value file — two scopes of one parameter share the one policy.
  const refs = refsFrom(files);
  let meta = 0;
  for (const ref of refs) {
    const block: Meta | undefined = await source.readMeta(ref);
    if (block === undefined) {
      continue;
    }
    tree.writeMetaSync(ref, block);
    meta += 1;
  }

  return { environment, source: source.type, localSource: false, values, meta, refs: refs.length };
}

export function renderPull(result: PullResult): string[] {
  if (result.localSource) {
    return formatRows([
      {
        glyph: CHECK,
        label: "Nothing to pull",
        subject: `environment ${result.environment} has no separate source of truth`,
        detail: "its values live in the local .penv tree already",
      },
    ]);
  }

  if (result.valuesUnreadable === true) {
    return formatRows([
      {
        glyph: CHECK,
        label: "Pulled",
        subject: `${result.refs} ${result.refs === 1 ? "parameter name" : "parameter names"}`,
        detail: `from ${result.source} for environment ${result.environment}`,
      },
      {
        glyph: WARN,
        label: "Values not readable",
        subject: "this destination never returns a secret's value",
        detail:
          "fill them locally with `penv set` or `penv fill` — `penv validate` names every gap",
      },
    ]);
  }

  return formatRows([
    {
      glyph: CHECK,
      label: "Pulled",
      subject: `${result.values} ${result.values === 1 ? "value" : "values"}`,
      detail: `from the ${result.source} provider for environment ${result.environment}`,
    },
    {
      glyph: CHECK,
      label: "Parameters",
      subject: `${result.refs} ${result.refs === 1 ? "parameter" : "parameters"}, ${result.meta} with meta`,
      detail: "written into the local .penv tree",
    },
  ]);
}

export const pullCommand = defineCommand({
  meta: {
    name: "pull",
    description: "Materialise the local .penv tree from an environment's source-of-truth provider",
  },
  args: {
    env: {
      type: "string",
      description: "The environment to pull (or pass it as a bare flag: --production)",
    },
  },
  run({ args }) {
    return guard(async () => {
      const result = await runPull({
        cwd: process.cwd(),
        ...(args.env === undefined ? {} : { environment: args.env }),
        envFlags: shorthandCandidates(args, ["env"]),
      });
      write(renderPull(result));
    });
  },
});
