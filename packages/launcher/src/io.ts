/**
 * The terminal, as three questions and two streams.
 *
 * It lives apart from the protocol because `penv add` asks the only question
 * penv cannot answer for anyone: why a stranger's code is trusted. `confirm` is
 * a decision penv could describe; `ask` is a sentence only a person can write.
 */

export interface LauncherIo {
  out(line: string): void;
  err(line: string): void;
  /** Whether a human is at the other end of the streams. */
  readonly interactive: boolean;
  confirm(question: string): Promise<boolean>;
  /** A free-text answer, trimmed. Empty means the person declined to write one. */
  ask(question: string): Promise<string>;
}
