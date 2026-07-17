/**
 * The on-disk shape of an encrypted value.
 *
 *   penv:1:<keyId>:<base64url nonce>:<base64url ciphertext||tag>
 *
 * One line, no whitespace, and text rather than bytes — because `Provider.read`
 * resolves to a `string`, so an armored envelope round-trips through every
 * provider with no change to the contract. A binary format would have needed one,
 * and bending the contract to fit penv's own feature is exactly the move that
 * makes the portability claim false.
 *
 * There is one version and one algorithm, and no way to name another. An
 * algorithm field that could say `aes-128` or `none` is a downgrade negotiation
 * waiting to be exploited; penv would rather break a format than negotiate one.
 * Version `1` exists so a later format can be *recognised*, not so this one can
 * be argued with.
 *
 * The key id rides in the envelope rather than in meta or config. Meta holds one
 * block per environment, but during a key rotation two files at two scopes are
 * legitimately sealed under two different keys — one slot cannot hold two
 * answers, and the ciphertext has room for its own. It also makes "rotating one
 * secret never means re-encrypting unrelated ones" mechanically true rather than
 * merely intended: every file names the key that opens it.
 */

const PREFIX = "penv";
const VERSION = "1";
const SEPARATOR = ":";

/** GCM's standard nonce. 12 bytes is what the algorithm is specified for. */
export const NONCE_BYTES = 12;

/** GCM's authentication tag, carried on the end of the ciphertext. */
export const TAG_BYTES = 16;

export interface Envelope {
  readonly keyId: string;
  readonly nonce: Uint8Array;
  /** Ciphertext with the authentication tag appended. */
  readonly sealed: Uint8Array;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** base64url: the URL alphabet, and never padded — which is what `encode` emits. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes a field, or `undefined` if it is not base64url.
 *
 * `Buffer.from(text, "base64url")` drops characters outside the alphabet instead
 * of refusing them, so a damaged field decodes to *something* shorter. Checked
 * rather than trusted, because the length check alone lets damage through
 * whenever the surviving characters still decode to the right size — and the
 * cost is not a wrong value but a wrong diagnosis: penv would report
 * `undecipherable`, whose remedy leads with "wrong key", for a file whose real
 * problem is that it was truncated.
 */
function decode(field: string): Uint8Array | undefined {
  if (!BASE64URL.test(field)) {
    return undefined;
  }
  return new Uint8Array(Buffer.from(field, "base64url"));
}

export function formatEnvelope(envelope: Envelope): string {
  return [PREFIX, VERSION, envelope.keyId, encode(envelope.nonce), encode(envelope.sealed)].join(
    SEPARATOR,
  );
}

/**
 * Reads an envelope, or answers `undefined` for anything that is not one.
 *
 * Undefined rather than an error: the caller knows the file it read and the
 * environment it read for, and can say so. This function knows neither, and an
 * error thrown from here could only name the bytes.
 *
 * Every field is checked before any key is consulted, so "this is not a penv
 * envelope" is decided without touching a key — a plaintext value that landed in
 * an `.enc` file must not report itself as a key problem.
 */
export function parseEnvelope(text: string): Envelope | undefined {
  const fields = text.trim().split(SEPARATOR);
  if (fields.length !== 5) {
    return undefined;
  }
  const [prefix, version, keyId, nonce, sealed] = fields;
  if (prefix !== PREFIX || version !== VERSION) {
    return undefined;
  }
  if (keyId === undefined || keyId.length === 0 || nonce === undefined || sealed === undefined) {
    return undefined;
  }

  const nonceBytes = decode(nonce);
  const sealedBytes = decode(sealed);
  if (nonceBytes === undefined || sealedBytes === undefined) {
    return undefined;
  }
  // A nonce of the wrong length is not a penv envelope, whatever else it is.
  // Checked here rather than at the cipher, so the reason names the format
  // instead of surfacing as an unexplained decryption failure.
  if (nonceBytes.length !== NONCE_BYTES) {
    return undefined;
  }
  // Below the tag length there is no ciphertext at all — not even an empty value,
  // which still carries its tag.
  if (sealedBytes.length < TAG_BYTES) {
    return undefined;
  }

  return { keyId, nonce: nonceBytes, sealed: sealedBytes };
}
