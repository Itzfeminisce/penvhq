/**
 * The core proof of the bundled-runtime story, end to end through the real CLI:
 * generate `penv.snapshot.ts` from a real tree, evaluate that exact generated
 * module, and resolve from it in a directory with no `penv.config.ts` in any
 * ancestor — the Vercel `/var/task` bundle, reproduced. If this passes, values
 * resolve with zero filesystem presence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnapshot } from "@penvhq/cli";
import {
  createEnvKeySource,
  findConfigFile,
  jitiFor,
  KEY_BYTES,
  type PenvSnapshot,
  sealValue,
  type ValueFile,
} from "@penvhq/core";
import { load } from "@penvhq/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const CONFIG = {
  environments: ["production"],
  providers: { production: { type: "@penvhq/provider-filesystem" } },
  keys: { production: { source: "env", id: "prod" } },
};

const KEY = Buffer.alloc(KEY_BYTES, 7).toString("base64");
const originalKey = process.env.PENV_KEY_PROD;
const created: string[] = [];

const DATABASE_URL: ValueFile = {
  namespace: [],
  name: "database-url",
  scope: { kind: "environment", environment: "production" },
  encrypted: true,
};

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.PENV_KEY_PROD;
  } else {
    process.env.PENV_KEY_PROD = originalKey;
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a CLI-generated snapshot resolves in a config-less runtime", () => {
  it("reproduces the bundle: no config on disk, values still resolve and decrypt", () => {
    process.env.PENV_KEY_PROD = KEY;

    // A real project: config on disk plus a sealed value in the tree.
    const project = mkdtempSync(join(tmpdir(), "penv-snap-project-"));
    created.push(project);
    writeFileSync(join(project, "penv.config.ts"), `export default ${JSON.stringify(CONFIG)};\n`);
    const sealed = sealValue(
      DATABASE_URL,
      "postgres://sealed/prod",
      createEnvKeySource({ source: "env", id: "prod" }),
      "database-url",
      "production",
    );
    mkdirSync(join(project, ".penv"), { recursive: true });
    writeFileSync(join(project, ".penv", "database-url.production.enc"), sealed);

    // Generate the committed snapshot module with the real command.
    runSnapshot({ cwd: project });

    // Evaluate the exact file penv wrote — its `import type` is erased, so the
    // module hands back the embedded snapshot object.
    const modulePath = join(project, "penv.snapshot.ts");
    const evaluated = jitiFor(modulePath)(modulePath) as { snapshot: PenvSnapshot };
    const snapshot = evaluated.snapshot;
    expect(Object.keys(snapshot.values)).toContain("database-url.production.enc");

    // A directory with no config in any ancestor — the bundle. load() falls back
    // to the snapshot and decrypts under PENV_KEY_PROD.
    const bundle = mkdtempSync(join(tmpdir(), "penv-snap-bundle-"));
    created.push(bundle);
    // Guard the premise: a stray config in an ancestor of tmpdir would take the disk path.
    expect(findConfigFile(bundle)).toBeUndefined();
    const schema = z.object({ databaseUrl: z.url() });

    const env = load(schema, { cwd: bundle, environment: "production", snapshot });

    expect(env.databaseUrl).toBe("postgres://sealed/prod");
  });
});
