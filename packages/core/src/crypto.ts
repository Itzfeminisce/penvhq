/**
 * Sealing and opening values. The one place penv does cryptography.
 *
 * AES-256-GCM from `node:crypto`, and no dependency. GCM is authenticated, so a
 * value that has been altered fails to open rather than opening as something
 * else — which matters because the thing being protected is a credential, and a
 * silently mangled credential is an outage with no error attached to it.
 *
 * The additional authenticated data is the value file's full address, so the
 * ciphertext is bound to *where it lives*. Copying `db-password.production.enc`
 * over `db-password.enc` therefore fails to open instead of quietly promoting a
 * production secret to the default every environment falls back to. That is the
 * scope-widening leak the cascade exists to prevent, closed at the one layer that
 * could otherwise reintroduce it: encryption sits below the cascade, so without
 * this the cascade's guarantees would stop at the ciphertext.
 *
 * Reading answers, writing throws. The asymmetry is deliberate and is not a
 * style choice: a failure to open must be *describable* — `doctor` and `get
 * --explain` report which file wins and why it did not open, and neither may be
 * stopped by the thing it is reporting on. A failure to seal has exactly one
 * honest response, refusal, because the alternative is writing a plaintext secret
 * to disk and letting a checker complain about it later.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import type { Envelope } from "./envelope.js";
import { formatEnvelope, NONCE_BYTES, parseEnvelope, TAG_BYTES } from "./envelope.js";
import { PenvError } from "./errors.js";
import { formatValueFile } from "./grammar.js";
import type { KeyLookup, KeySource } from "./keys.js";
import type { DecryptFailure, DecryptReason, ValueFile } from "./types.js";

const ALGORITHM = "aes-256-gcm";

export type DecryptResult =
  | { readonly kind: "plaintext"; readonly value: string }
  | { readonly kind: "failed"; readonly failure: DecryptFailure };

/** The remedy for each reason. Named per reason because they are not the same fix. */
function remedyFor(failure: DecryptFailure, location: string): string {
  switch (failure.reason) {
    case "key-source-unavailable":
      return (
        `penv could not consult a key source: ${failure.detail}. Declare where this ` +
        "environment's keys live in the `keys` block of penv.config.ts."
      );
    case "key-absent":
      return (
        `The key that seals ${location} is not there: ${failure.detail}. Export the key, or ` +
        "re-seal the value under a key you hold with `penv encrypt`."
      );
    case "malformed-envelope":
      return (
        `${location} carries the \`.enc\` marker but its contents are not an encrypted value ` +
        "penv wrote. If the value is plaintext, rename the file without `.enc`; if it was " +
        "truncated, restore it from the provider."
      );
    case "undecipherable":
      return (
        "The key does not open this value. Either it is the wrong key, the file has been " +
        `damaged, or the ciphertext was copied from another address — \`.enc\` values are ` +
        `bound to the file they live in, so ${location} cannot be moved between scopes by ` +
        "copying. Re-seal it at this address with `penv encrypt`."
      );
    default:
      return "Re-seal the value with `penv encrypt`.";
  }
}

/** A value that resolved but could not be opened. Never confused with no value. */
export class UndecryptableValueError extends PenvError {
  override readonly name = "UndecryptableValueError";
  readonly parameter: string;
  readonly environment: string;
  readonly failure: DecryptFailure;

  constructor(parameter: string, environment: string, location: string, failure: DecryptFailure) {
    super(
      "VALUE_UNDECRYPTABLE",
      `Parameter ${parameter} for environment ${environment} resolves to ${location}, which penv could not decrypt`,
      remedyFor(failure, location),
    );
    this.parameter = parameter;
    this.environment = environment;
    this.failure = failure;
  }
}

/** No key to seal with. The write path's refusal — see the module note. */
export class KeyUnavailableError extends PenvError {
  override readonly name = "KeyUnavailableError";
  readonly parameter: string;
  readonly environment: string;

  constructor(parameter: string, environment: string, lookup: KeyLookup) {
    const detail = lookup.kind === "found" ? "" : lookup.detail;
    super(
      "KEY_UNAVAILABLE",
      `Parameter ${parameter} is a secret for environment ${environment}, and penv has no key to seal it with: ${detail}`,
      "penv will not write a secret in plaintext, and will not invent a key. Declare the key " +
        "source in the `keys` block of penv.config.ts and make the key available, then run the " +
        "command again.",
    );
    this.parameter = parameter;
    this.environment = environment;
  }
}

/** The address a value is bound to. The whole filename, so scope is part of it. */
function aadFor(file: ValueFile): Buffer {
  return Buffer.from(formatValueFile(file), "utf8");
}

function failed(reason: DecryptReason, detail: string): DecryptResult {
  return { kind: "failed", failure: { reason, detail } };
}

/**
 * Opens a sealed value. Never throws: every failure is a value the caller can
 * report. See the module note on why reading answers and writing throws.
 */
export function decryptValue(file: ValueFile, stored: string, keys: KeySource): DecryptResult {
  const envelope = parseEnvelope(stored);
  if (envelope === undefined) {
    // Decided without consulting a key: a plaintext value in an `.enc` file is
    // not a key problem, and reporting it as one sends the user to look for a
    // key that would not have helped.
    return failed("malformed-envelope", "the contents are not a penv envelope");
  }

  const lookup = keys.lookup(envelope.keyId);
  if (lookup.kind === "unavailable") {
    return failed("key-source-unavailable", lookup.detail);
  }
  if (lookup.kind === "absent") {
    return failed("key-absent", lookup.detail);
  }

  const body = envelope.sealed.subarray(0, envelope.sealed.length - TAG_BYTES);
  const tag = envelope.sealed.subarray(envelope.sealed.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, lookup.key, envelope.nonce);
    decipher.setAAD(aadFor(file));
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(body), decipher.final()]);
    return { kind: "plaintext", value: opened.toString("utf8") };
  } catch {
    // The tag check failed. GCM cannot say which of the three causes it was, so
    // neither does penv — the remedy names all three rather than guessing one.
    return failed(
      "undecipherable",
      `${formatValueFile(file)} did not open under key \`${envelope.keyId}\``,
    );
  }
}

/**
 * Reads a stored value, decrypting it only if its filename says it is encrypted.
 *
 * Every walker calls this unconditionally, which is the point: an `if
 * (file.encrypted)` at each call site is four places that must agree about what
 * encryption means, and the fourth one is where the bug lives. A plaintext file
 * is returned verbatim and its key source is never consulted.
 */
export function openValue(file: ValueFile, stored: string, keys: KeySource): DecryptResult {
  if (!file.encrypted) {
    return { kind: "plaintext", value: stored };
  }
  return decryptValue(file, stored, keys);
}

/**
 * Seals a value for the address it will live at.
 *
 * Throws when there is no key: refusing is the only honest outcome, because the
 * alternative is writing the secret in plaintext. `parameter` and `environment`
 * are taken rather than derived so the error names them the way every other penv
 * error does.
 */
export function sealValue(
  file: ValueFile,
  value: string,
  keys: KeySource,
  parameter: string,
  environment: string,
): string {
  const lookup = keys.current();
  if (lookup.kind !== "found") {
    throw new KeyUnavailableError(parameter, environment, lookup);
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, lookup.key, nonce);
  cipher.setAAD(aadFor(file));
  const body = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);

  const envelope: Envelope = {
    keyId: lookup.keyId,
    nonce: new Uint8Array(nonce),
    sealed: new Uint8Array(sealed),
  };
  return formatEnvelope(envelope);
}

/**
 * Whether two keys are the same key, in constant time.
 *
 * Exported for `penv key create`, which refuses to overwrite an occupied id:
 * that check compares key material, and a comparison of secrets that short-
 * circuits on the first differing byte is a comparison that leaks them.
 */
export function sameKey(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
