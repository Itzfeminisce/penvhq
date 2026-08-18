/**
 * Starting someone else's command, opaquely.
 *
 * `penv run -- <command>` starts exactly what follows `--`: the argument
 * boundaries the shell already worked out are handed to the operating system
 * untouched, stdio is the parent's, and the child's exit code and terminating
 * signal come back out. penv never parses the command, never rebuilds a command
 * line from it, never wraps it in a shell — a shell would re-split what the user
 * already split, and `penv run -- node -e "console.log(1 > 2)"` would redirect to
 * a file called `2`.
 *
 * Windows is the one place where "hand it to the operating system" needs help.
 * `pnpm`, `next` and every other node-installed tool are `.cmd` shims there, and
 * Node refuses to execute one without a shell. So a `.cmd`/`.bat` target — and
 * only that — is started through `cmd.exe /d /s /c` with
 * `windowsVerbatimArguments`, building the one command line cmd will accept and
 * escaping every argument so that cmd hands the child the same bytes penv was
 * given. Everything else spawns directly, on every platform.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { PenvError } from "@penvhq/core";

/** How a child ended. Exactly one of these is meaningful, and both are forwarded. */
export interface ChildResult {
  /** The child's own exit code, or 1 when a signal ended it. */
  readonly exitCode: number;
  /** The signal that ended the child, when one did. */
  readonly signal: NodeJS.Signals | null;
}

export interface ChildInvocation {
  /** The command exactly as it followed `--`: the executable, then its arguments. */
  readonly command: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

/** A started child: how it ends, and the one thing a wrapper may do to it. */
export interface ChildHandle {
  /** Resolves when the child has ended, however it ended. */
  readonly ended: Promise<ChildResult>;
  /** Asks the child to stop — what `--watch` does before it starts the next one. */
  kill(signal?: NodeJS.Signals): void;
}

/** The seam `run` starts a child through — replaced in tests that assert what it was given. */
export type StartChild = (invocation: ChildInvocation) => ChildHandle;

/** The signals a wrapper must pass through rather than absorb. */
const FORWARDED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

export const startChild: StartChild = (invocation) => {
  const [executable, ...args] = invocation.command;
  if (executable === undefined) {
    throw noCommand();
  }

  const target = resolveTarget(executable, args, invocation.env);
  const child = spawn(target.file, target.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: "inherit",
    ...(target.verbatim ? { windowsVerbatimArguments: true } : {}),
  });

  // Forwarded rather than handled: penv is a wrapper, and a Ctrl-C belongs to
  // the program the user is looking at. The child decides what to do with it,
  // and its answer comes back as the signal below.
  const forward = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED) {
    const handler = (): void => {
      child.kill(signal);
    };
    forward.set(signal, handler);
    process.on(signal, handler);
  }
  const release = (): void => {
    for (const [signal, handler] of forward) {
      process.off(signal, handler);
    }
  };

  const ended = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", (cause) => {
      release();
      reject(cannotStart(executable, cause));
    });
    child.on("exit", (code, signal) => {
      release();
      resolve({ exitCode: code ?? 1, signal });
    });
  });

  return {
    ended,
    kill(signal) {
      child.kill(signal);
    },
  };
};

export function noCommand(): PenvError {
  return new PenvError(
    "RUN_NO_COMMAND",
    "`penv run` was given no command to start",
    "Put the command after `--`, e.g. `penv run -- pnpm dev`.",
  );
}

function cannotStart(executable: string, cause: unknown): PenvError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PenvError(
    "RUN_COMMAND_NOT_STARTED",
    `\`${executable}\` could not be started: ${detail}`,
    `Check the command after \`--\` runs on its own — \`${executable}\` has to be on PATH, exactly as it is spelled here.`,
  );
}

interface SpawnTarget {
  readonly file: string;
  readonly args: readonly string[];
  /** True when the args are one pre-built command line rather than a list. */
  readonly verbatim: boolean;
}

function resolveTarget(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SpawnTarget {
  if (process.platform !== "win32") {
    return { file: executable, args, verbatim: false };
  }
  const resolved = findExecutable(executable, env);
  if (resolved === undefined || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved ?? executable, args, verbatim: false };
  }
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${cmdCommandLine(resolved, args)}"`],
    verbatim: true,
  };
}

/** A package-manager shim, which re-invokes cmd on its own way through. */
const SHIM = /(?:^|\\)node_modules\\\.bin\\[^\\]+\.cmd$/i;

/**
 * The one command line cmd.exe is handed, escaped so the child receives the
 * bytes penv was given.
 *
 * The path is normalized first and *then* judged: `./node_modules/.bin/next.cmd`
 * and `.\node_modules\.bin\next.cmd` are the same shim, and deciding on the
 * un-normalized spelling would escape a forward-slash invocation once while cmd
 * expands it twice — so an argument holding `&` would run as a command inside
 * the shim's second round. Windows' own separator, whatever this process runs
 * on, because this line is only ever read by cmd.exe.
 */
export function cmdCommandLine(resolved: string, args: readonly string[]): string {
  const command = win32.normalize(resolved);
  const shim = SHIM.test(command);
  return [escapeCommand(command), ...args.map((argument) => escapeArgument(argument, shim))].join(
    " ",
  );
}

/** Windows' executable extensions, in the order the shell would try them. */
function extensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const declared = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...declared.split(";").filter((extension) => extension.length > 0)];
}

/**
 * What the shell would have run, found the way the shell finds it: the name as
 * given if it carries a path, else each PATH directory, each with each
 * executable extension.
 */
function findExecutable(
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const candidates = extensions(env);
  const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

  if (executable.includes("/") || executable.includes("\\") || isAbsolute(executable)) {
    return candidates.map((extension) => executable + extension).find(isFile);
  }
  const path = env.PATH ?? env.Path ?? "";
  for (const directory of path.split(delimiter).filter((entry) => entry.length > 0)) {
    const hit = candidates.map((extension) => join(directory, executable + extension)).find(isFile);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/** The characters cmd.exe expands before the program ever sees them. */
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

/** The command's own path: cmd's metacharacters escaped, and no quotes to confuse it. */
function escapeCommand(command: string): string {
  return command.replace(CMD_METACHARACTERS, "^$1");
}

/**
 * One argument, quoted so the child's runtime splits it exactly where penv was
 * given it, then escaped so cmd.exe passes those quotes through instead of
 * acting on them.
 */
function escapeArgument(argument: string, doubleEscape: boolean): string {
  const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const escaped = quoted.replace(CMD_METACHARACTERS, "^$1");
  return doubleEscape ? escaped.replace(CMD_METACHARACTERS, "^$1") : escaped;
}
