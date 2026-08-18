/**
 * The one hash penv checks: npm's SSRI, over the tarball bytes.
 *
 * The manifest pins the same string npm recorded, so the value compared here is
 * the value a reviewer approved in the diff — not a digest penv invented.
 */

import { createHash } from "node:crypto";

/** The SSRI of some bytes, in the form the manifest pins. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
