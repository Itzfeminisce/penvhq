/**
 * Reading answers from a terminal — or from a pipe, where the answers can arrive
 * before the questions.
 *
 * `readline.question` attaches its listener only when asked, so a line piped in
 * ahead of the first prompt — `printf 'value\n' | penv fill` — was emitted to
 * nobody and lost, and the EOF behind it closed the interface out from under the
 * question that came next (`ERR_USE_AFTER_CLOSE`, or a promise that never
 * settled). This reader listens from the moment it is created: early lines are
 * buffered in arrival order, and once input ends every outstanding and future
 * question resolves to `undefined` — the caller's "no answer", which `fill`
 * already treats as a skip. Against a real terminal it is `readline`'s own
 * prompt-and-edit behavior, unchanged.
 */

import { createInterface } from "node:readline";

export interface LineReader {
  /**
   * The next line of input, or `undefined` when input has ended. The question is
   * written only when the reader must wait for it to be answered — an answer
   * that already arrived belongs to a reader who is not looking at a prompt.
   */
  ask(question: string): Promise<string | undefined>;
  close(): void;
}

export function lineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): LineReader {
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];
  let closed = false;

  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) {
      buffered.push(line);
    } else {
      next(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) {
      next(undefined);
    }
  });

  return {
    ask(question: string): Promise<string | undefined> {
      const early = buffered.shift();
      if (early !== undefined) {
        return Promise.resolve(early);
      }
      if (closed) {
        return Promise.resolve(undefined);
      }
      rl.setPrompt(question);
      rl.prompt();
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    close(): void {
      rl.close();
    },
  };
}
