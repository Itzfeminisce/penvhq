/**
 * `penv encrypt <key>` and `penv decrypt <key>` — change whether one value file
 * is sealed, without changing what it says.
 *
 * These act on one parameter at one scope, because a scope is the address the
 * provider actually has: `db-password.production` and `db-password` are two
 * files, and a command that "encrypted the parameter" would have to guess which.
 *
 * They exist for two moments the policy cannot handle by itself. The first is
 * adoption: `secret: true` added to a parameter that already has values leaves
 * every existing file plaintext, and `penv set` only seals what it writes. The
 * second is re-sealing after a move — a ciphertext is bound to the address it
 * lives at, so a value file that is renamed or re-scoped must be sealed again for
 * its new address.
 *
 * Neither invents a key. `penv encrypt` with no key refuses, because a key penv
 * chose is a key nobody can reproduce — the same reason `penv set` is the only
 * thing that writes a value, and never a value it made up.
 */

import type { ValueFile } from "@penv/core";
import {
  formatValueFile,
  isSecret,
  openValue,
  PenvError,
  parameterId,
  sealValue,
} from "@penv/core";
import { defineCommand } from "citty";
import type { Project } from "../project.js";
import { keySourceFor, openProject, PENV_DIR, refFromKey, targetEnvironment } from "../project.js";
import { CHECK, formatRows, guard, write } from "../ui.js";
import type { ScopeOptions } from "./set.js";
import { targetScope } from "./set.js";

export interface ResealOptions extends ScopeOptions {
  readonly cwd: string;
  readonly key: string;
}

export interface ResealResult {
  readonly parameter: string;
  /** The file that now holds the value. */
  readonly location: string;
  /** The file that no longer exists, because its twin replaced it. */
  readonly removed: string;
}

/** The two files one value can live in at a scope. Exactly one of them exists. */
function twins(project: Project, key: string, options: ScopeOptions): [ValueFile, ValueFile] {
  const ref = refFromKey(key, project.config);
  const scope = targetScope(project, options, key);
  return [
    { namespace: ref.namespace, name: ref.name, scope, encrypted: false },
    { namespace: ref.namespace, name: ref.name, scope, encrypted: true },
  ];
}

/**
 * The environment this scope's policy and key are read from.
 *
 * Unlike `set`, this refuses rather than falling back to the base block: both
 * commands here need a *key*, and a key is declared per environment. A scope that
 * names none has no key penv can choose, and choosing the ambient environment's
 * would seal a file every other environment reads under a key only one of them
 * has.
 */
function environmentFor(project: Project, options: ScopeOptions, verb: string): string {
  if (options.environment === undefined) {
    throw new PenvError(
      "SECRET_SCOPE_AMBIGUOUS",
      `\`penv ${verb}\` names no environment, and keys are declared per environment`,
      "Pass `--env <environment>`. penv cannot tell which environment's key applies to a file " +
        "that names none, and will not pick one for you.",
    );
  }
  return targetEnvironment(project, options.environment);
}

async function readOne(project: Project, file: ValueFile): Promise<string | undefined> {
  return project.provider.read(file);
}

export async function runEncrypt(options: ResealOptions): Promise<ResealResult> {
  const project = openProject(options.cwd);
  const environment = environmentFor(project, options, "encrypt");
  const [plain, sealed] = twins(project, options.key, options);
  const parameter = parameterId(plain);

  const value = await readOne(project, plain);
  if (value === undefined) {
    const already = await readOne(project, sealed);
    throw new PenvError(
      "PARAMETER_ABSENT",
      already === undefined
        ? `Parameter ${parameter} has no value file at ${PENV_DIR}/${formatValueFile(plain)}`
        : `Parameter ${parameter} is already encrypted at ${PENV_DIR}/${formatValueFile(sealed)}`,
      already === undefined
        ? `Write it first with \`penv set ${options.key} --env ${environment}\`, which seals it ` +
            "automatically when the parameter's meta declares it a secret."
        : "Nothing to do.",
    );
  }

  const text = sealValue(sealed, value, keySourceFor(project, environment), parameter, environment);

  // Written before the plaintext is removed. The reverse order has a window in
  // which the value exists nowhere, and the value is the thing being protected.
  await project.provider.write(sealed, text);
  await project.provider.remove(plain);

  return {
    parameter,
    location: formatValueFile(sealed),
    removed: formatValueFile(plain),
  };
}

export async function runDecrypt(options: ResealOptions): Promise<ResealResult> {
  const project = openProject(options.cwd);
  const environment = environmentFor(project, options, "decrypt");
  const [plain, sealed] = twins(project, options.key, options);
  const parameter = parameterId(plain);

  // penv does not ship a command whose purpose is to fail its own check. A
  // secret written in plaintext is a `doctor` failure by policy (invariant 14),
  // and decrypting one on request would manufacture exactly that.
  if (isSecret(await project.provider.readMeta(plain), environment)) {
    throw new PenvError(
      "SECRET_DECRYPT_REFUSED",
      `Parameter ${parameter} is declared a secret for environment ${environment}, so penv will not write it in plaintext`,
      "A secret with a plaintext value file is a `penv doctor` failure. Drop `secret` from the " +
        "parameter's meta if it is not one, or run `penv generate --allow-decrypt` if you need " +
        "the plaintext value in a `.env` artifact.",
    );
  }

  const stored = await readOne(project, sealed);
  if (stored === undefined) {
    throw new PenvError(
      "PARAMETER_ABSENT",
      `Parameter ${parameter} has no encrypted value file at ${PENV_DIR}/${formatValueFile(sealed)}`,
      `Nothing to decrypt. \`penv get ${options.key} --env ${environment} --explain\` shows every file penv looked at.`,
    );
  }

  const opened = openValue(sealed, stored, keySourceFor(project, environment));
  if (opened.kind === "failed") {
    throw new UndecryptableAt(
      parameter,
      environment,
      formatValueFile(sealed),
      opened.failure.detail,
    );
  }

  await project.provider.write(plain, opened.value);
  await project.provider.remove(sealed);

  return {
    parameter,
    location: formatValueFile(plain),
    removed: formatValueFile(sealed),
  };
}

/** The one thing `decrypt` can fail at that `requireValue` does not cover: a named file. */
class UndecryptableAt extends PenvError {
  constructor(parameter: string, environment: string, location: string, detail: string) {
    super(
      "VALUE_UNDECRYPTABLE",
      `Parameter ${parameter} for environment ${environment} is sealed at ${PENV_DIR}/${location}, and penv could not open it: ${detail}`,
      "Make the key available and run the command again. penv will not replace a value it " +
        "cannot read.",
    );
  }
}

export function renderReseal(result: ResealResult, verb: "Encrypted" | "Decrypted"): string[] {
  return formatRows([
    {
      glyph: CHECK,
      label: verb,
      subject: `${PENV_DIR}/${result.location}`,
      detail: `${PENV_DIR}/${result.removed} removed`,
    },
  ]);
}

const SCOPE_ARGS = {
  key: { type: "positional", required: true, description: "The parameter, e.g. redis/password" },
  env: { type: "string", description: "The environment whose value file to act on" },
  local: {
    type: "boolean",
    description: "Act on the personal override rather than the shared file",
  },
} as const;

function scopeOptions(args: {
  env?: string | undefined;
  local?: boolean | undefined;
}): ScopeOptions {
  return {
    ...(args.env === undefined ? {} : { environment: args.env }),
    ...(args.local === undefined ? {} : { local: args.local }),
  };
}

export const encryptCommand = defineCommand({
  meta: { name: "encrypt", description: "Encrypt one parameter's value file at one scope" },
  args: SCOPE_ARGS,
  run({ args }) {
    return guard(async () => {
      const result = await runEncrypt({ cwd: process.cwd(), key: args.key, ...scopeOptions(args) });
      write(renderReseal(result, "Encrypted"));
    });
  },
});

export const decryptCommand = defineCommand({
  meta: { name: "decrypt", description: "Decrypt one parameter's value file at one scope" },
  args: SCOPE_ARGS,
  run({ args }) {
    return guard(async () => {
      const result = await runDecrypt({ cwd: process.cwd(), key: args.key, ...scopeOptions(args) });
      write(renderReseal(result, "Decrypted"));
    });
  },
});
