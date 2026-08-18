/**
 * The manifest is the marker, and it is found by walking up: penv is typed in
 * whatever directory the developer is standing in, and a monorepo package four
 * levels down is still the same project.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANIFEST_PATH } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { findProject } from "./project.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "penv-project-"));
  created.push(dir);
  return dir;
}

function withManifest(root: string): string {
  const file = join(root, ...MANIFEST_PATH.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{}\n");
  return file;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findProject", () => {
  it("finds the manifest from a directory deep inside the project", () => {
    const root = scratch();
    const manifestFile = withManifest(root);
    const deep = join(root, "apps", "api", "src");
    mkdirSync(deep, { recursive: true });

    expect(findProject(deep)).toEqual({ root, manifestFile });
    expect(findProject(root)).toEqual({ root, manifestFile });
  });

  it("finds nothing outside a project", () => {
    expect(findProject(scratch())).toBeUndefined();
  });
});
