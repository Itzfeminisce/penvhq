/**
 * The reader exists for one failure: `printf 'value\n' | penv fill` delivered
 * its line before the first question was asked, `readline.question`'s listener
 * was not attached yet, and the answer was emitted to nobody — then the EOF
 * behind it closed the interface out from under the question that came next.
 * These tests pin the three behaviors that fix it: early lines are buffered and
 * answered in order, EOF is a clean "no answer" rather than a crash or a hang,
 * and the question is only written when the reader actually waits.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineReader } from "./input.js";

function makeStreams(): { input: PassThrough; output: PassThrough; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return { input, output, written: () => Buffer.concat(chunks).toString("utf8") };
}

/** A macrotask, so readline's own listeners run before the assertion does. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("lineReader", () => {
  it("answers from lines that arrived before the question was asked", async () => {
    const { input, output, written } = makeStreams();
    const reader = lineReader(input, output);
    input.write("first\nsecond\n");
    await tick();

    await expect(reader.ask("one > ")).resolves.toBe("first");
    await expect(reader.ask("two > ")).resolves.toBe("second");
    // Buffered answers belong to nobody looking at a prompt: nothing was written.
    expect(written()).toBe("");
    reader.close();
  });

  it("writes the question and waits when no line has arrived", async () => {
    const { input, output, written } = makeStreams();
    const reader = lineReader(input, output);

    const answer = reader.ask("value > ");
    await tick();
    expect(written()).toContain("value > ");

    input.write("typed\n");
    await expect(answer).resolves.toBe("typed");
    reader.close();
  });

  it("resolves a pending question with undefined when input ends", async () => {
    const { input, output } = makeStreams();
    const reader = lineReader(input, output);

    const answer = reader.ask("value > ");
    await tick();
    input.end();

    await expect(answer).resolves.toBeUndefined();
    reader.close();
  });

  it("answers every question after the end of input with undefined", async () => {
    const { input, output } = makeStreams();
    const reader = lineReader(input, output);
    input.end();
    await tick();

    await expect(reader.ask("one > ")).resolves.toBeUndefined();
    await expect(reader.ask("two > ")).resolves.toBeUndefined();
    reader.close();
  });

  it("drains buffered answers before reporting the end of input", async () => {
    const { input, output } = makeStreams();
    const reader = lineReader(input, output);
    input.write("only\n");
    input.end();
    await tick();

    await expect(reader.ask("one > ")).resolves.toBe("only");
    await expect(reader.ask("two > ")).resolves.toBeUndefined();
    reader.close();
  });

  it("returns an empty line as an empty answer, not as the end of input", async () => {
    const { input, output } = makeStreams();
    const reader = lineReader(input, output);
    input.write("\nafter\n");
    await tick();

    await expect(reader.ask("one > ")).resolves.toBe("");
    await expect(reader.ask("two > ")).resolves.toBe("after");
    reader.close();
  });
});
