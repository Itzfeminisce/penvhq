#!/usr/bin/env node
/**
 * The `penv` executable — the one program a developer installs.
 *
 * It wires the real world into {@link runLauncher} and does nothing else: the
 * network, the terminal, and the child process arrive as three small interfaces,
 * which is what lets the whole protocol be tested without any of them.
 */

import { nodeSpawner } from "./delegate.js";
import { bundledEngine } from "./engine.js";
import { httpFetcher } from "./fetcher.js";
import type { LauncherIo } from "./io.js";
import { runLauncher } from "./launcher.js";

function readLine(): Promise<string> {
  return new Promise((settle) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.once("data", (chunk: Buffer | string) => {
      stdin.pause();
      settle(String(chunk));
    });
  });
}

/** The prompt goes to stderr: stdout belongs to whatever the engine prints. */
const io: LauncherIo = {
  out(line) {
    process.stdout.write(`${line}\n`);
  },
  err(line) {
    process.stderr.write(`${line}\n`);
  },
  interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
  async confirm(question) {
    process.stderr.write(`${question} [y/N] `);
    const answer = (await readLine()).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  },
  async ask(question) {
    process.stderr.write(`${question}\n> `);
    return (await readLine()).trim();
  },
};

void runLauncher({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  io,
  fetcher: httpFetcher(),
  spawn: nodeSpawner(),
  bundledEngine,
}).then((code) => {
  process.exitCode = code;
});
