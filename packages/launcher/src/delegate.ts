/**
 * Handing the command over.
 *
 * The engine is a child process, not an import: it is a different version of
 * penv than the launcher, and it has to be able to be. What crosses is the
 * argument list exactly as typed, the three streams, the exit code, and the
 * signal that ended it — nothing is parsed, rewritten, or summarized on the way.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Environment } from "@penvhq/core";

export interface Delegation {
  /** The executable to run — node, for a JS engine entry. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Environment;
}

/** Runs the child and answers with the exit code the caller should exit with. */
export type Spawner = (delegation: Delegation) => Promise<number>;

/** The signals a launcher must not swallow on its way to the child. */
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

function signalNumber(signal: NodeJS.Signals): number {
  const signals = constants.signals as Record<string, number | undefined>;
  return signals[signal] ?? 0;
}

export function nodeSpawner(): Spawner {
  return (delegation) =>
    new Promise<number>((settle, fail) => {
      const child = spawn(delegation.command, [...delegation.args], {
        cwd: delegation.cwd,
        env: { ...delegation.env },
        stdio: "inherit",
      });

      const handlers = FORWARDED.map((signal) => {
        const handler = () => {
          child.kill(signal);
        };
        process.on(signal, handler);
        return { signal, handler } as const;
      });
      const release = () => {
        for (const { signal, handler } of handlers) {
          process.off(signal, handler);
        }
      };

      child.on("error", (error) => {
        release();
        fail(error);
      });
      child.on("exit", (code, signal) => {
        release();
        if (signal !== null) {
          // Die the way the child died: a shell reading `$?` learns that the
          // command was killed, not that penv chose to return a number.
          process.kill(process.pid, signal);
          settle(128 + signalNumber(signal));
          return;
        }
        settle(code ?? 0);
      });
    });
}
