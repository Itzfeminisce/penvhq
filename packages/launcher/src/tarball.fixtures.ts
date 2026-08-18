/**
 * The tarballs the tests read, packed rather than committed.
 *
 * An npm package is a gzipped ustar archive, so building one here is what lets
 * the whole download path — fetch, verify, extract — run with no network and no
 * binary blob in the repository that nobody can review.
 */

import { gzipSync } from "node:zlib";

export interface TarSource {
  /** The path as it appears in the archive, `package/` and all. */
  readonly path: string;
  readonly content?: string;
  /** ustar type flag: `0` file, `5` directory, `2` symlink, `x` pax header. */
  readonly typeflag?: string;
}

const BLOCK = 512;
const encoder = new TextEncoder();

function header(source: TarSource, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, start: number, length: number) => {
    block.set(encoder.encode(text).subarray(0, length), start);
  };
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;

  put(source.path, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put(source.typeflag ?? "0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);

  let checksum = 0;
  for (const byte of block) {
    checksum += byte;
  }
  put(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** A gzipped ustar archive of exactly these entries. */
export function packTar(sources: readonly TarSource[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const source of sources) {
    const data = encoder.encode(source.content ?? "");
    blocks.push(header(source, data.length));
    if (data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(gzipSync(archive));
}

/** What the engine's bin prints, so a delegation test can see it ran. */
export const ENGINE_MARKER = "engine ran";

/** A runnable package: a `package.json` with a bin, and the bin. */
export function enginePackage(name: string, version: string): TarSource[] {
  return [
    { path: "package/", typeflag: "5" },
    {
      path: "package/package.json",
      content: `${JSON.stringify({ name, version, bin: { "penv-engine": "./bin.js" } }, null, 2)}\n`,
    },
    { path: "package/bin.js", content: `console.log(${JSON.stringify(ENGINE_MARKER)});\n` },
  ];
}
