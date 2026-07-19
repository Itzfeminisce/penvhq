/**
 * `sourceProviderFor` builds the environment's DECLARED source of truth — the
 * backend `pull` and cross-provider `doctor` read from — as opposed to
 * `Project.provider`, which is always the local filesystem tree every command
 * edits. The two are deliberately distinct: an environment can flip its source to
 * `vault` while the working copy on disk stays filesystem.
 *
 * These tests assert the mapping from a `providers.*` entry to a concrete
 * provider, and the fallback: an environment with no entry has no separate source
 * of truth, so it resolves to the local tree rather than erroring.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PenvConfig } from "@penvhq/core";
import { FilesystemProvider } from "@penvhq/provider-filesystem";
import { afterEach, describe, expect, it } from "vitest";
import { openProject, sourceProviderFor } from "./project.js";

const FIXTURE_PARENT = fileURLToPath(new URL("./node_modules/.penv-test/", import.meta.url));

const created: string[] = [];

function makeProject(config: PenvConfig): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "source-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(config)};\n`,
    "utf8",
  );
  mkdirSync(join(root, ".penv"), { recursive: true });
  writeFileSync(
    join(root, ".penv", "env.ts"),
    'import { z } from "zod";\nexport const schema = z.object({});\n',
    "utf8",
  );
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sourceProviderFor", () => {
  it("builds the vault provider an environment declares as its source of truth", async () => {
    const root = makeProject({
      environments: ["development", "production"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
        production: { type: "@penvhq/provider-vault", location: "secret/app" },
      },
    });
    const project = openProject(root);

    const source = await sourceProviderFor(project, "production");

    expect(source.type).toBe("@penvhq/provider-vault");
  });

  it("builds the mock provider an environment declares", async () => {
    const root = makeProject({
      environments: ["development", "production"],
      providers: {
        development: { type: "@penvhq/provider-mock" },
        production: { type: "@penvhq/provider-filesystem" },
      },
    });
    const project = openProject(root);

    const source = await sourceProviderFor(project, "development");

    expect(source.type).toBe("@penvhq/provider-mock");
  });

  it("falls back to the local filesystem tree when the environment declares no provider", async () => {
    const root = makeProject({
      environments: ["development", "production"],
      providers: {
        development: { type: "@penvhq/provider-filesystem" },
      },
    });
    const project = openProject(root);

    const source = await sourceProviderFor(project, "production");

    expect(source.type).toBe("@penvhq/provider-filesystem");
    expect(source).toBeInstanceOf(FilesystemProvider);
  });
});
