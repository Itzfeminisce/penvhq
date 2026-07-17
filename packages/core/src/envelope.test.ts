import { describe, expect, it } from "vitest";
import { decryptValue } from "./crypto.js";
import type { Envelope } from "./envelope.js";
import { formatEnvelope, NONCE_BYTES, parseEnvelope, TAG_BYTES } from "./envelope.js";
import type { KeySource } from "./keys.js";
import type { ValueFile } from "./types.js";

function bytes(start: number, length: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, i) => start + i));
}

const envelope: Envelope = {
  keyId: "prod-key",
  nonce: bytes(0, NONCE_BYTES),
  sealed: bytes(200, TAG_BYTES + 4),
};

/*
 * The envelope is what is written to disk and pushed to a provider, so its shape
 * is a compatibility surface: a penv that formatted it differently could not read
 * the files an earlier penv sealed. A literal is the only assertion that catches
 * a drift here — a test that formatted and parsed with the same code would agree
 * with itself no matter what the format became.
 */
describe("formatEnvelope", () => {
  it("writes penv:1:<keyId>:<base64url nonce>:<base64url sealed>", () => {
    expect(formatEnvelope(envelope)).toBe(
      "penv:1:prod-key:AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts",
    );
  });

  it("armors the bytes as base64url, so no field can contain the separator", () => {
    // `+` and `/` would be fine on disk but `:` splits the fields; base64url also
    // keeps the line safe to carry through a provider that speaks URLs.
    const formatted = formatEnvelope(envelope);

    expect(formatted.split(":")).toHaveLength(5);
    expect(formatted).toContain("_");
    expect(formatted).not.toMatch(/[+/]/);
  });
});

describe("parseEnvelope", () => {
  it("round-trips a formatted envelope", () => {
    const parsed = parseEnvelope(formatEnvelope(envelope));

    expect(parsed?.keyId).toBe("prod-key");
    expect(parsed?.nonce).toEqual(envelope.nonce);
    expect(parsed?.sealed).toEqual(envelope.sealed);
  });

  it("ignores surrounding whitespace, so a trailing newline still parses", () => {
    // Editors and `echo` add one, and a value file that lost its meaning to a
    // newline would be an unopenable secret with no explanation attached.
    expect(parseEnvelope(`\n${formatEnvelope(envelope)}\n`)).toEqual(
      parseEnvelope(formatEnvelope(envelope)),
    );
  });

  /*
   * Everything below answers `undefined` rather than throwing: this function
   * knows only the bytes, so the caller — which knows the file and the
   * environment — is the one that can name what went wrong.
   */
  it("answers undefined for a field count other than five", () => {
    expect(parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL")).toBeUndefined();
    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts:extra"),
    ).toBeUndefined();
  });

  it("answers undefined for a value that is not an envelope at all", () => {
    expect(parseEnvelope("not-an-envelope")).toBeUndefined();
    expect(parseEnvelope("")).toBeUndefined();
  });

  it("answers undefined for the wrong prefix", () => {
    expect(
      parseEnvelope("penvx:1:prod-key:AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts"),
    ).toBeUndefined();
  });

  /*
   * Version `1` exists so a later format can be recognised, not so this one can
   * be argued with: an unrecognised version is refused rather than read
   * optimistically as though it were this one.
   */
  it("answers undefined for a version it does not know", () => {
    expect(
      parseEnvelope("penv:2:prod-key:AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts"),
    ).toBeUndefined();
  });

  it("answers undefined for an empty keyId", () => {
    // Every sealed file names the key that opens it; one that names nothing
    // cannot be opened, and must not be reported as a missing key either.
    expect(parseEnvelope("penv:1::AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts")).toBeUndefined();
  });

  it("answers undefined for a nonce of the wrong length", () => {
    // Refused here rather than at the cipher, so the reason names the format
    // instead of surfacing as an unexplained decryption failure.
    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQo:yMnKy8zNzs_Q0dLT1NXW19jZ2ts"),
    ).toBeUndefined();
  });

  it("answers undefined for sealed bytes shorter than the tag", () => {
    // Below the tag length there is no ciphertext at all — not even an empty
    // value, which still carries its tag.
    expect(parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDA0O")).toBeUndefined();
  });

  it("accepts sealed bytes that are exactly the tag — an empty value is still a value", () => {
    const parsed = parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDA0ODw");

    expect(parsed?.sealed).toHaveLength(TAG_BYTES);
  });
});

/*
 * A field is checked for its alphabet, not only for the size it decodes to.
 *
 * `Buffer.from(text, "base64url")` drops characters outside the alphabet rather
 * than refusing them, so damage that leaves enough valid characters behind still
 * decodes to the right length and reads as a well-formed envelope. The cost is
 * not a wrong value — GCM catches that — but a wrong *diagnosis*: penv would
 * report `undecipherable`, whose remedy leads with "wrong key", for a file whose
 * real problem is that it was damaged and whose real remedy is "restore it from
 * the provider". A user sent to rotate a key over a truncated file is a user
 * rotating a key that was never at fault.
 *
 * Every case below decodes to a *valid length* with the junk dropped, which is
 * what makes it a length check's blind spot rather than a case it already caught.
 */
describe("parseEnvelope refuses fields that are not base64url", () => {
  it("refuses a nonce with characters outside the alphabet that would decode to 12 bytes", () => {
    // `AAECAwQFBgcICQoL` is exactly the 12 bytes a nonce is; with `!!!` dropped
    // it still is, so only the alphabet check can tell this file is damaged.
    expect(Buffer.from("AAECAwQFBgcICQoL!!!", "base64url")).toHaveLength(NONCE_BYTES);

    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL!!!:yMnKy8zNzs_Q0dLT1NXW19jZ2ts"),
    ).toBeUndefined();
  });

  it("refuses sealed bytes with characters outside the alphabet that would still be long enough", () => {
    expect(
      Buffer.from("AAECAwQFBgcICQoLDA0ODxAREhM!!!", "base64url").length,
    ).toBeGreaterThanOrEqual(TAG_BYTES);

    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:AAECAwQFBgcICQoLDA0ODxAREhM!!!"),
    ).toBeUndefined();
  });

  /*
   * `+` and `/` are standard base64, not base64url, and `Buffer` decodes them
   * happily under either label — so a nonce carrying them decodes to the right
   * bytes at the right length and would sail through a length check. penv never
   * writes them (`formatEnvelope` emits base64url), so a field that has them was
   * not written by this format, and reading it anyway would make the armor a
   * suggestion. Two spellings of one byte string is also the ambiguity that makes
   * "the file is the ciphertext" stop being true.
   */
  it("refuses a nonce spelled in standard base64, which `Buffer` would decode anyway", () => {
    // Same twelve bytes, the other alphabet: proof this is refused for its
    // spelling rather than for decoding to something of the wrong size.
    const standard = "+/+/AAECAwQFBgcI";
    const url = "-_-_AAECAwQFBgcI";
    expect(Buffer.from(standard, "base64url")).toEqual(Buffer.from(url, "base64url"));
    expect(Buffer.from(standard, "base64url")).toHaveLength(NONCE_BYTES);

    expect(
      parseEnvelope(`penv:1:prod-key:${standard}:yMnKy8zNzs_Q0dLT1NXW19jZ2ts`),
    ).toBeUndefined();

    // The stays-quiet half: the base64url spelling of those same bytes parses.
    expect(parseEnvelope(`penv:1:prod-key:${url}:yMnKy8zNzs_Q0dLT1NXW19jZ2ts`)?.nonce).toEqual(
      new Uint8Array(Buffer.from(url, "base64url")),
    );
  });

  it("refuses sealed bytes spelled in standard base64", () => {
    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:+/v7+/v7+/v7+/v7+/v7+/v7+/s"),
    ).toBeUndefined();
  });

  it("refuses a padded field, because `formatEnvelope` never emits padding", () => {
    // `=` is outside the unpadded base64url alphabet. A padded field did not
    // come from this format, whatever it decodes to.
    expect(
      parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:yMnKy8zNzs_Q0dLT1NXW19jZ2ts="),
    ).toBeUndefined();
  });

  it("refuses an empty nonce or sealed field rather than decoding it to nothing", () => {
    expect(parseEnvelope("penv:1:prod-key::yMnKy8zNzs_Q0dLT1NXW19jZ2ts")).toBeUndefined();
    expect(parseEnvelope("penv:1:prod-key:AAECAwQFBgcICQoL:")).toBeUndefined();
  });

  /*
   * The stays-quiet half for the whole block: the alphabet check must refuse
   * damage, not every envelope. Whatever `formatEnvelope` writes must parse —
   * a check that rejected a legitimate field would make every sealed file
   * unreadable, which is the same outage from the other direction.
   */
  it("still accepts every character the format legitimately emits", () => {
    // 0xfb-heavy bytes are what produce `-` and `_` in base64url; they must
    // survive the alphabet check that refuses their `+`/`/` spelling.
    const written = formatEnvelope({
      keyId: "prod-key",
      nonce: new Uint8Array([0xfb, 0xff, 0xbf, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
      sealed: new Uint8Array(TAG_BYTES + 4).fill(0xfb),
    });
    expect(written).toMatch(/[-_]/);

    expect(parseEnvelope(written)).toBeDefined();
  });
});

/*
 * The consequence the alphabet check exists for, asserted at the layer that
 * reports it. `decryptValue` maps an unparseable envelope to `malformed-envelope`
 * — whose remedy says "restore it from the provider" — and everything else to
 * `undecipherable`, whose remedy leads with "wrong key". The reason and the
 * remedy are a pair, so a damaged field that parsed would not merely be reported
 * imprecisely: it would send the user to rotate a key that is not the problem.
 *
 * It lives beside the parser rather than in crypto.test.ts because the parser is
 * what decides it, and the point of the test is that the two agree.
 */
describe("a field that is not base64url is reported as damage, not as a key problem", () => {
  const file: ValueFile = {
    namespace: ["redis"],
    name: "password",
    scope: { kind: "environment", environment: "production" },
    encrypted: true,
  };
  const keys: KeySource = {
    type: "fixed",
    lookup: () => ({ kind: "found", keyId: "prod-key", key: new Uint8Array(32).fill(7) }),
    current: () => ({ kind: "found", keyId: "prod-key", key: new Uint8Array(32).fill(7) }),
  };

  it("reports malformed-envelope for a nonce that only a length check would accept", () => {
    const result = decryptValue(
      file,
      "penv:1:prod-key:AAECAwQFBgcICQoL!!!:yMnKy8zNzs_Q0dLT1NXW19jZ2ts",
      keys,
    );

    expect(result).toMatchObject({ kind: "failed", failure: { reason: "malformed-envelope" } });
    // The assertion that pins the misrouted diagnosis: on the broken parser this
    // envelope decoded, reached the cipher, and failed its tag check here.
    expect(result.kind === "failed" && result.failure.reason).not.toBe("undecipherable");
  });
});
