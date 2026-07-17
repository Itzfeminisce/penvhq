/**
 * `penv key create --env <e>` — mint a key of the right shape.
 *
 * This exists because `penv encrypt` refuses to invent one. A key penv generated
 * behind your back is a key nobody can reproduce, restore, or rotate, and the
 * first time it matters is the first time it is gone. So minting is its own act,
 * run deliberately, and the key it prints is yours to store.
 *
 * Where penv stores it depends on the source. With `env`, the key *is* whatever
 * the process environment holds — a deploy unwraps it from a KMS and exports it —
 * so there is nowhere for penv to put it that would not be the repo-adjacent file
 * the design forbids; printing the export line is the whole job. With `keychain`,
 * the OS keychain is exactly the place a key may live, so penv stores it there and
 * prints nothing to copy — the key exists in one place, on this machine, which is
 * the point of the keychain.
 */

import { randomBytes } from "node:crypto";
import type { Keychain } from "@penv/core";
import { KEY_BYTES, KEYCHAIN_SERVICE, PenvError } from "@penv/core";
import { defineCommand } from "citty";
import { defaultKeychain } from "../keychain.js";
import { openProject, targetEnvironment } from "../project.js";
import { guard, write } from "../ui.js";

export interface KeyCreateOptions {
  readonly cwd: string;
  readonly environment?: string;
  /** Replace an existing keychain key instead of refusing. Orphans values sealed under the old one. */
  readonly force?: boolean;
  /** Injected in tests: the keychain to store into. Defaults to the real OS binding. */
  readonly keychain?: Keychain;
}

export interface KeyCreateResult {
  readonly source: "env" | "keychain";
  readonly environment: string;
  readonly id: string;
  /** Env source only: the variable to export the key under. */
  readonly variable?: string;
  /** Env source only: the key, base64, ready to export. penv holds no copy. */
  readonly key?: string;
}

/** Mirrors the transform in core's env key source, which is the thing that reads it. */
function envVarFor(id: string): string {
  return `PENV_KEY_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

export function runKeyCreate(options: KeyCreateOptions): KeyCreateResult {
  const project = openProject(options.cwd);
  const environment = targetEnvironment(project, options.environment);

  const declared = project.config.keys?.[environment];
  if (declared === undefined) {
    throw new PenvError(
      "KEY_SOURCE_UNDECLARED",
      `Environment ${environment} declares no key source, so penv does not know what a key for it would be`,
      "Add a `keys` entry to penv.config.ts — e.g. " +
        `\`keys: { ${environment}: { source: "env", id: "${environment}" } }\` — then run this again.`,
    );
  }

  const key = randomBytes(KEY_BYTES).toString("base64");

  if (declared.source === "keychain") {
    const keychain = options.keychain ?? defaultKeychain;
    if (options.force !== true) {
      // Replacing the key orphans every value already sealed under the old one —
      // they could never be decrypted again. Refuse unless the user forces it.
      let existing: string | null;
      try {
        existing = keychain.getPassword(KEYCHAIN_SERVICE, declared.id);
      } catch (cause) {
        throw new PenvError(
          "KEYCHAIN_UNAVAILABLE",
          `penv could not read your OS keychain to check for an existing key \`${declared.id}\``,
          `Unlock your keychain and run this again. Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (existing !== null) {
        throw new PenvError(
          "KEY_EXISTS",
          `Environment ${environment} already has a key \`${declared.id}\` in your OS keychain`,
          "Replacing it would orphan every value already sealed under it — they could never be " +
            "decrypted again. Re-run with `--force` only if you are certain nothing is sealed under " +
            "the current key.",
        );
      }
    }
    keychain.setPassword(KEYCHAIN_SERVICE, declared.id, key);
    return { source: "keychain", environment, id: declared.id };
  }

  return {
    source: "env",
    environment,
    id: declared.id,
    variable: envVarFor(declared.id),
    key,
  };
}

export function renderKeyCreate(result: KeyCreateResult): string[] {
  if (result.source === "keychain") {
    return [
      `A new key for environment ${result.environment}, stored in your OS keychain as \`${result.id}\`.`,
      "",
      "penv kept no copy. Anything sealed under it is unreadable without your keychain, and running",
      "`penv key create` again would replace it — so it lives in exactly one place, on this machine.",
    ];
  }
  return [
    `A new key for environment ${result.environment}. penv did not store it.`,
    "",
    `  ${result.variable}=${result.key}`,
    "",
    "Export it where penv runs, and put it wherever this environment's secrets already live —",
    "a KMS, your CI's secret store, a password manager. Anything sealed under it is unreadable",
    "without it, and penv keeps no copy to fall back on.",
  ];
}

export const keyCommand = defineCommand({
  meta: { name: "key", description: "Work with encryption keys" },
  subCommands: {
    create: defineCommand({
      meta: { name: "create", description: "Generate a key for an environment" },
      args: {
        env: { type: "string", description: "The environment the key is for" },
        force: {
          type: "boolean",
          description: "Replace an existing keychain key (orphans values sealed under the old one)",
        },
      },
      run({ args }) {
        return guard(async () => {
          write(
            renderKeyCreate(
              runKeyCreate({
                cwd: process.cwd(),
                ...(args.env === undefined ? {} : { environment: args.env }),
                ...(args.force === undefined ? {} : { force: args.force }),
              }),
            ),
          );
        });
      },
    }),
  },
});
