/**
 * `penv key create --env <e>` — mint a key of the right shape.
 *
 * This exists because `penv encrypt` refuses to invent one. A key penv generated
 * behind your back is a key nobody can reproduce, restore, or rotate, and the
 * first time it matters is the first time it is gone. So minting is its own act,
 * run deliberately, and the key it prints is yours to store.
 *
 * penv does not store it. With the `env` source, the key *is* whatever the
 * process environment holds — a deploy unwraps it from a KMS and exports it —
 * so there is nowhere for penv to put it that would not be the repo-adjacent
 * file the design forbids. Printing the export line is the whole job: it is the
 * one step a user would otherwise get wrong by reaching for `openssl` and picking
 * the wrong length or the wrong encoding.
 */

import { randomBytes } from "node:crypto";
import { KEY_BYTES, PenvError } from "@penv/core";
import { defineCommand } from "citty";
import { openProject, targetEnvironment } from "../project.js";
import { guard, write } from "../ui.js";

export interface KeyCreateOptions {
  readonly cwd: string;
  readonly environment?: string;
}

export interface KeyCreateResult {
  readonly environment: string;
  readonly variable: string;
  /** The key, base64, ready to export. penv holds no copy. */
  readonly key: string;
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

  return {
    environment,
    variable: envVarFor(declared.id),
    key: randomBytes(KEY_BYTES).toString("base64"),
  };
}

export function renderKeyCreate(result: KeyCreateResult): string[] {
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
      },
      run({ args }) {
        return guard(async () => {
          write(
            renderKeyCreate(
              runKeyCreate({
                cwd: process.cwd(),
                ...(args.env === undefined ? {} : { environment: args.env }),
              }),
            ),
          );
        });
      },
    }),
  },
});
