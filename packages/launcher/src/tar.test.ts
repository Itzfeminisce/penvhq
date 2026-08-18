/**
 * The reader's job is to be boring about the archive npm publishes and hostile
 * about every other one: a tarball is untrusted input that arrives before the
 * user has seen a single file in it, so an entry that would write outside the
 * directory penv extracts into must never reach the filesystem.
 */

import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors.js";
import { readTarball } from "./tar.js";
import { packTar } from "./tarball.fixtures.js";

const SUBJECT = { name: "@penvhq/cli", version: "0.9.0" };

function read(sources: Parameters<typeof packTar>[0]) {
  return readTarball(packTar(sources), SUBJECT);
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** pax's `<length> <key>=<value>\n`, where the length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}`.length + body.length !== length) {
    length = `${length}`.length + body.length;
  }
  return `${length}${body}`;
}

describe("readTarball", () => {
  it("strips the package root and keeps the bytes", () => {
    const entries = read([
      { path: "package/", typeflag: "5" },
      { path: "package/package.json", content: '{ "name": "x" }\n' },
      { path: "package/dist/index.js", content: "export const x = 1;\n" },
    ]);

    expect(entries.map((entry) => entry.path)).toEqual(["package.json", "dist/index.js"]);
    expect(textOf(entries[0]?.bytes ?? new Uint8Array())).toBe('{ "name": "x" }\n');
    expect(textOf(entries[1]?.bytes ?? new Uint8Array())).toBe("export const x = 1;\n");
  });

  it("reads a file whose content spans several blocks", () => {
    const content = "a".repeat(1500);
    const entries = read([{ path: "package/big.txt", content }]);

    expect(textOf(entries[0]?.bytes ?? new Uint8Array())).toBe(content);
  });

  it("takes the path from a pax header when one carries it", () => {
    const long = `package/${"nested/".repeat(20)}index.js`;
    const entries = read([
      { path: "package/PaxHeader", typeflag: "x", content: paxRecord("path", long) },
      { path: "package/truncated", content: "long\n" },
    ]);

    expect(entries.map((entry) => entry.path)).toEqual([long.slice("package/".length)]);
  });

  it("refuses an entry that climbs out of the package", () => {
    expect(() => read([{ path: "package/../evil.js", content: "x" }])).toThrow(ArchiveError);
    expect(() => read([{ path: "package/nested/../../evil.js", content: "x" }])).toThrow(
      ArchiveError,
    );
  });

  it("refuses an absolute path, a drive letter, and a backslash", () => {
    expect(() => read([{ path: "package//etc/passwd", content: "x" }])).toThrow(ArchiveError);
    expect(() => read([{ path: "package/C:/windows/evil", content: "x" }])).toThrow(ArchiveError);
    expect(() => read([{ path: "package/..\\evil", content: "x" }])).toThrow(ArchiveError);
  });

  it("refuses an entry outside the package root", () => {
    expect(() => read([{ path: "elsewhere/index.js", content: "x" }])).toThrow(ArchiveError);
  });

  it("refuses a symlink rather than following it", () => {
    const failure = () => read([{ path: "package/link", typeflag: "2" }]);

    expect(failure).toThrow(ArchiveError);
    expect(failure).toThrow(/package\/link/);
  });

  it("names the package and one remedy when it refuses", () => {
    try {
      read([{ path: "package/../evil.js", content: "x" }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveError);
      const archive = error as ArchiveError;
      expect(archive.code).toBe("PENV_ARCHIVE");
      expect(archive.message).toContain("@penvhq/cli 0.9.0");
      expect(archive.remedy).toBe(
        "Check the registry — penv extracts regular files under `package/` and nothing else.",
      );
    }
  });
});
