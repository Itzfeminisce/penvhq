/**
 * The CLI snapshot builder and the `env.ts` wiring.
 *
 * `buildSnapshot` embeds sealed records only — the parity with a git clone the
 * whole feature rests on — and its output is deterministic so `doctor
 * snapshot-stale` can text-compare. `wireEnvModule` adds the import and the
 * `snapshot` option to the shapes penv itself scaffolds, and refuses to guess at
 * anything else.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KEY_BYTES } from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { runEncrypt } from "./commands/encrypt.js";
import { runRemove } from "./commands/remove.js";
import { runSet } from "./commands/set.js";
import { openProject } from "./project.js";
import {
  buildSnapshot,
  renderSnapshotModule,
  SNAPSHOT_FILE,
  snapshotExists,
  wireEnvModule,
  writeSnapshotFile,
} from "./snapshot.js";

const created: string[] = [];

const CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
};

/** A project root with a plain-JSON config (no jiti imports) and a `.penv/` tree. */
function makeProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "penv-snapshot-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
    "utf8",
  );
  for (const [name, value] of Object.entries(files)) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  }
  return root;
}

/** A tree with one of every case the sealed-only filter must decide on. */
const MIXED_TREE: Readonly<Record<string, string>> = {
  "api-key.enc": "penv:1:dev:aa:bb", // sealed unscoped — embedded
  "database-url.production.enc": "penv:1:prod:cc:dd", // sealed team scope — embedded
  "log-level": "debug", // plaintext — skipped
  "token.production.local.enc": "penv:1:prod:ee:ff", // sealed but .local — skipped
  "personal.local": "x", // plaintext .local — skipped
};

/** A config whose production environment has an env-backed key, for sealing. */
const KEY_CONFIG = {
  environments: ["development", "production"],
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
  keys: {
    development: { source: "env", id: "test" },
    production: { source: "env", id: "test" },
  },
};

const KEY = Buffer.alloc(KEY_BYTES, 7).toString("base64");
const originalKey = process.env.PENV_KEY_TEST;

function makeKeyProject(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "penv-snapshot-"));
  created.push(root);
  writeFileSync(
    join(root, "penv.config.ts"),
    `export default ${JSON.stringify(KEY_CONFIG)};\n`,
    "utf8",
  );
  for (const [name, value] of Object.entries(files)) {
    const file = join(root, ".penv", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  }
  return root;
}

function snapshotText(root: string): string {
  return readFileSync(join(root, SNAPSHOT_FILE), "utf8");
}

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.PENV_KEY_TEST;
  } else {
    process.env.PENV_KEY_TEST = originalKey;
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSnapshot", () => {
  it("embeds sealed records only — skips plaintext and both .local scopes", () => {
    const project = openProject(makeProject(MIXED_TREE));

    const snapshot = buildSnapshot(project);

    expect(snapshot.v).toBe(1);
    expect(snapshot.config).toEqual(CONFIG);
    expect(Object.keys(snapshot.values)).toEqual(["api-key.enc", "database-url.production.enc"]);
    expect(snapshot.values["api-key.enc"]).toBe("penv:1:dev:aa:bb");
  });

  it("orders value keys code-unit sorted, so the module text is deterministic", () => {
    const project = openProject(
      makeProject({
        "zeta.enc": "penv:1:dev:1:1",
        "alpha.enc": "penv:1:dev:2:2",
        "mid.production.enc": "penv:1:prod:3:3",
      }),
    );

    const first = renderSnapshotModule(buildSnapshot(project));
    const second = renderSnapshotModule(buildSnapshot(openProject(project.root)));

    expect(first).toBe(second);
    expect(Object.keys(buildSnapshot(project).values)).toEqual([
      "alpha.enc",
      "mid.production.enc",
      "zeta.enc",
    ]);
  });
});

describe("writeSnapshotFile", () => {
  it("creates the module, then reports it unchanged on a no-op rewrite", () => {
    const project = openProject(makeProject(MIXED_TREE));

    expect(snapshotExists(project.root)).toBe(false);
    expect(writeSnapshotFile(project).action).toBe("created");
    expect(snapshotExists(project.root)).toBe(true);
    expect(writeSnapshotFile(project).action).toBe("unchanged");

    const text = readFileSync(join(project.root, SNAPSHOT_FILE), "utf8");
    expect(text).toContain("satisfies PenvSnapshot");
    expect(text).toContain('import type { PenvSnapshot } from "@penvhq/penv";');
  });

  it("treats a CRLF checkout as unchanged — git autocrlf is not drift", () => {
    const project = openProject(makeProject(MIXED_TREE));
    writeSnapshotFile(project);

    const path = join(project.root, SNAPSHOT_FILE);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n/g, "\r\n"), "utf8");

    expect(writeSnapshotFile(project).action).toBe("unchanged");
  });
});

describe("wireEnvModule", () => {
  /** Writes a scaffolded-shape wrapper at `.penv/env.ts`, minus the snapshot wiring. */
  function withWrapper(load: string): ReturnType<typeof openProject> {
    const root = makeProject(MIXED_TREE);
    writeFileSync(
      join(root, ".penv", "env.ts"),
      `import { load } from "@penvhq/penv";\n` +
        `import { schema } from "../penv.schema.js";\n\n` +
        `export { schema };\n\n` +
        `${load}\n`,
      "utf8",
    );
    return openProject(root);
  }

  function wrapperText(project: ReturnType<typeof openProject>): string {
    return readFileSync(join(project.root, ".penv", "env.ts"), "utf8");
  }

  it("wires the import and the snapshot option into a bare load(schema)", () => {
    const project = withWrapper("export const env = load(schema);");

    const result = wireEnvModule(project);

    expect(result.action).toBe("wired");
    const text = wrapperText(project);
    expect(text).toContain('import { snapshot } from "../penv.snapshot.js";');
    expect(text).toContain("export const env = load(schema, { snapshot });");
  });

  it("adds snapshot alongside an existing option rather than replacing it", () => {
    const project = withWrapper("export const env = load(schema, { inject: true });");

    wireEnvModule(project);

    expect(wrapperText(project)).toContain("load(schema, { inject: true, snapshot })");
  });

  it('is not fooled by the word "snapshot" inside an option string', () => {
    const project = withWrapper('export const env = load(schema, { inject: ["snapshot-url"] });');

    wireEnvModule(project);

    expect(wrapperText(project)).toContain('load(schema, { inject: ["snapshot-url"], snapshot })');
  });

  it("is idempotent — an already-wired wrapper is kept untouched", () => {
    const project = withWrapper("export const env = load(schema);");

    expect(wireEnvModule(project).action).toBe("wired");
    const once = wrapperText(project);
    expect(wireEnvModule(openProject(project.root)).action).toBe("kept");
    expect(wrapperText(project)).toBe(once);
  });

  it("refuses to guess at an unrecognized shape and reports the lines to add", () => {
    const project = withWrapper("export const env = mySchemaLoader(schema);");
    const before = wrapperText(project);

    const result = wireEnvModule(project);

    expect(result.action).toBe("manual");
    expect(result.importLine).toContain("penv.snapshot.js");
    expect(result.loadHint).toContain("snapshot");
    // The user's file is untouched when penv cannot recognise the shape.
    expect(wrapperText(project)).toBe(before);
  });
});

/**
 * The mutating commands refresh a committed snapshot — but only a committed one:
 * the snapshot is opt-in, so a project that never generated one is never given one
 * by a `set`. When it exists, a change to committed sealed values is reflected.
 */
describe("mutations refresh a committed snapshot", () => {
  it("set (secret) adds the newly sealed value to the snapshot", async () => {
    process.env.PENV_KEY_TEST = KEY;
    const root = makeKeyProject({ "secret.json": JSON.stringify({ secret: true }) });
    writeSnapshotFile(openProject(root)); // opt in, with an empty tree
    expect(snapshotText(root)).not.toContain("secret.production.enc");

    await runSet({ cwd: root, key: "secret", value: "s3cr3t", environment: "production" });

    expect(snapshotText(root)).toContain("secret.production.enc");
  });

  it("encrypt adds the sealed value; the snapshot never holds the plaintext twin", async () => {
    process.env.PENV_KEY_TEST = KEY;
    const root = makeKeyProject({ "token.production": "plain-value" });
    writeSnapshotFile(openProject(root));

    await runEncrypt({ cwd: root, key: "token", environment: "production" });

    const text = snapshotText(root);
    expect(text).toContain("token.production.enc");
    expect(text).not.toContain("plain-value");
  });

  it("remove drops the sealed value from the snapshot", async () => {
    process.env.PENV_KEY_TEST = KEY;
    const root = makeKeyProject({ "secret.json": JSON.stringify({ secret: true }) });
    await runSet({ cwd: root, key: "secret", value: "s3cr3t", environment: "production" });
    writeSnapshotFile(openProject(root));
    expect(snapshotText(root)).toContain("secret.production.enc");

    await runRemove({ cwd: root, key: "secret", environment: "production" });

    expect(snapshotText(root)).not.toContain("secret.production.enc");
  });

  it("does not conjure a snapshot for a project that commits none", async () => {
    process.env.PENV_KEY_TEST = KEY;
    const root = makeKeyProject({ "secret.json": JSON.stringify({ secret: true }) });

    await runSet({ cwd: root, key: "secret", value: "s3cr3t", environment: "production" });

    expect(snapshotExists(root)).toBe(false);
  });
});
