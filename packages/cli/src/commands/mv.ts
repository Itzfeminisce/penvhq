/**
 * `penv mv <from> <to>` — rename a parameter, every scope at once.
 *
 * A parameter is not one file. It is up to eight — four cascade levels, each
 * with a plaintext and an encrypted address — plus its meta, and a rename that
 * moved some of them would split one parameter into two. So this moves all of
 * them or none of them, and the whole plan is checked before a single byte is
 * written.
 *
 * **This is the only correct way to move an encrypted value.** A ciphertext is
 * sealed against the address it lives at, so `mv redis-password.production.enc
 * redis/password.production.enc` at the shell produces a file that will never
 * open again — the value is not moved, it is destroyed, and the shell reports
 * success. Re-sealing at the new address is the whole reason this command
 * exists: penv asked for namespacing to be "a deliberate refactor afterwards"
 * and then, once values could be encrypted, made doing it by hand a way to lose
 * them.
 *
 * It moves the tree and never the schema. `.penv/env.ts` is yours (invariant 2),
 * so renaming `database-url` to `database/url` leaves it declaring the old access
 * path — and the drift report is what says so. penv names the distance; you close
 * it. This command's report says which line to change rather than changing it.
 */

import type { Meta, ParameterRef, ValueFile } from "@penvhq/core";
import {
  accessPath,
  formatMetaFile,
  formatValueFile,
  openValue,
  PenvError,
  parameterId,
  sealValue,
} from "@penvhq/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import { assertWritableKey, keySourceFor, openProject, PENV_DIR, refFromKey } from "../project.js";
import { CHECK, formatRows, guard, type Row, tip, write } from "../ui.js";

export interface MoveOptions {
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
}

export interface MovedFile {
  readonly from: string;
  readonly to: string;
  /** True when the value was opened and sealed again for its new address. */
  readonly resealed: boolean;
}

export interface MoveResult {
  readonly from: string;
  readonly to: string;
  readonly files: readonly MovedFile[];
  /** The meta file's new location, or `undefined` when the parameter had none. */
  readonly meta: string | undefined;
  /** The access path the schema still declares, and the one it should now. */
  readonly schema: { readonly was: string; readonly now: string };
}

/** The environment a scope names, or `undefined` for the scopes that name none. */
function environmentOf(file: ValueFile): string | undefined {
  const scope = file.scope;
  return scope.kind === "environment" || scope.kind === "environment-local"
    ? scope.environment
    : undefined;
}

/** One file's move, resolved to the bytes that will be written at the far end. */
interface Planned {
  readonly source: ValueFile;
  readonly target: ValueFile;
  readonly contents: string;
  readonly resealed: boolean;
}

/**
 * Reads one file and works out what it must say at its new address.
 *
 * A plaintext value is bytes and moves as bytes. An encrypted one cannot: the
 * address is authenticated, so the ciphertext is only valid where it is. It is
 * opened here and sealed again below — and if it cannot be opened, the whole move
 * is refused rather than carrying a file to a place it will never open from.
 */
async function planFile(
  project: Project,
  source: ValueFile,
  target: ValueFile,
  parameter: string,
): Promise<Planned | undefined> {
  const stored = await project.provider.read(source);
  if (stored === undefined) {
    return undefined;
  }
  if (!source.encrypted) {
    return { source, target, contents: stored, resealed: false };
  }

  // A key is declared per environment, so a sealed value at a scope that names
  // none has no key penv can choose — the same refusal `penv set` makes, for the
  // same reason, and the same one that keeps penv from creating such a file.
  const environment = environmentOf(source);
  if (environment === undefined) {
    throw new PenvError(
      "SECRET_SCOPE_AMBIGUOUS",
      `${PENV_DIR}/${formatValueFile(source)} is encrypted at a scope that names no environment, so penv cannot tell which key would re-seal it`,
      "Keys are declared per environment in the `keys` block of penv.config.ts. Decrypt it with " +
        "`penv decrypt`, move the parameter, then encrypt it again at its new address.",
    );
  }

  const keys = keySourceFor(project, environment);
  const opened = openValue(source, stored, keys);
  if (opened.kind === "failed") {
    throw new PenvError(
      "VALUE_UNDECRYPTABLE",
      `${PENV_DIR}/${formatValueFile(source)} could not be decrypted, so penv cannot re-seal it at its new address: ${opened.failure.detail}`,
      "A sealed value is bound to the file it lives in, so moving it means opening it and " +
        "sealing it again. Make the key available and run this again. Nothing has been moved.",
    );
  }

  return {
    source,
    target,
    contents: sealValue(target, opened.value, keys, parameter, environment),
    resealed: true,
  };
}

/** Every file the provider actually holds for one parameter. */
function filesOf(all: readonly ValueFile[], ref: ParameterRef): ValueFile[] {
  const id = parameterId(ref);
  return all.filter((file) => parameterId(file) === id);
}

export async function runMove(options: MoveOptions): Promise<MoveResult> {
  const project = openProject(options.cwd);
  const from = refFromKey(options.from, project.config);
  assertWritableKey(options.to);
  const to = refFromKey(options.to, project.config);

  if (parameterId(from) === parameterId(to)) {
    throw new PenvError(
      "PARAMETER_UNCHANGED",
      `\`${options.from}\` and \`${options.to}\` are the same parameter`,
      "Name a different destination, e.g. `penv mv redis-password redis/password`.",
    );
  }

  const all = await project.provider.list();
  const sources = filesOf(all, from);
  const meta: Meta | undefined = await project.provider.readMeta(from);

  if (sources.length === 0 && meta === undefined) {
    throw new PenvError(
      "PARAMETER_ABSENT",
      `Parameter ${parameterId(from)} has no value files and no meta, so there is nothing to move`,
      `\`penv list\` shows every parameter penv holds.`,
    );
  }

  // Nothing is overwritten, ever. A destination that already exists is two
  // parameters being merged into one, which loses whichever penv wrote second —
  // the same loss `validate` refuses for name collisions (invariant 12).
  const occupied = filesOf(all, to);
  if (occupied.length > 0 || (await project.provider.readMeta(to)) !== undefined) {
    throw new PenvError(
      "PARAMETER_EXISTS",
      `Parameter ${parameterId(to)} already exists, and penv will not merge two parameters into one`,
      `Remove or rename ${parameterId(to)} first. \`penv get ${options.to} --explain\` shows every file it holds.`,
    );
  }

  // Planned in full before anything is written. Every read, every decryption and
  // every key lookup happens here, so a move that cannot finish fails having
  // changed nothing — rather than halfway, with a parameter that is now two.
  const planned: Planned[] = [];
  for (const source of sources) {
    const target: ValueFile = { ...source, namespace: to.namespace, name: to.name };
    const one = await planFile(project, source, target, parameterId(to));
    if (one !== undefined) {
      planned.push(one);
    }
  }

  for (const file of planned) {
    await project.provider.write(file.target, file.contents);
  }
  if (meta !== undefined) {
    await project.provider.writeMeta(to, meta);
  }

  // Removed only once every new file is on disk, so the value is never in
  // neither place. The cost is a window where it is in both, which a crash
  // leaves recoverable; the reverse leaves it gone.
  for (const file of planned) {
    await project.provider.remove(file.source);
  }
  if (meta !== undefined) {
    await project.provider.removeMeta(from);
  }

  return {
    from: parameterId(from),
    to: parameterId(to),
    files: planned.map((file) => ({
      from: formatValueFile(file.source),
      to: formatValueFile(file.target),
      resealed: file.resealed,
    })),
    // The meta's path, not the parameter's dotted id: `redis.password` is what
    // the schema calls it and `redis/password.json` is the file, and a report
    // that printed the first while moving the second names no file on disk.
    meta: meta === undefined ? undefined : formatMetaFile({ ...to, format: "json" }),
    schema: { was: accessPath(from).join("."), now: accessPath(to).join(".") },
  };
}

export function renderMove(result: MoveResult): string[] {
  const rows: Row[] = result.files.map((file) => ({
    glyph: CHECK,
    label: "Moved",
    subject: `${PENV_DIR}/${file.to}`,
    ...(file.resealed ? { detail: "re-sealed for its new address" } : {}),
  }));
  if (result.meta !== undefined) {
    rows.push({ glyph: CHECK, label: "Moved", subject: `${PENV_DIR}/${result.meta}` });
  }

  const lines = formatRows(rows);
  // The tree moved and the schema did not, because the schema is the user's file
  // and penv does not write it. Saying so here is cheaper than letting them find
  // out from a failing `validate` — and it names the edit rather than the fault.
  lines.push(
    "",
    tip(
      `.penv/env.ts still declares \`${result.schema.was}\` — rename it to \`${result.schema.now}\`, ` +
        "or `penv validate` will report the value as unused and the declaration as unset.",
    ),
  );
  return lines;
}

export const mvCommand = defineCommand({
  meta: { name: "mv", description: "Rename a parameter, every scope and its meta at once" },
  args: {
    from: {
      type: "positional",
      required: true,
      description: "The parameter now, e.g. redis-password",
    },
    to: {
      type: "positional",
      required: true,
      description: "The parameter after, e.g. redis/password",
    },
  },
  run({ args }) {
    return guard(async () => {
      write(renderMove(await runMove({ cwd: process.cwd(), from: args.from, to: args.to })));
    });
  },
});
