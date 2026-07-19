import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PenvConfig, ValueFile } from "@penvhq/core";
import { FilenameGrammarError, UnknownEnvironmentError } from "@penvhq/core";
import { runProviderContractSuite } from "@penvhq/provider-contract";
import { afterAll, describe, expect, it } from "vitest";
import { createFilesystemProvider } from "./filesystem.js";

const config: PenvConfig = {
  environments: ["development", "staging", "production"],
  providers: { development: { type: "@penvhq/provider-filesystem" } },
};

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "penv-filesystem-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProvider() {
  const root = makeRoot();
  return createFilesystemProvider({ root, config });
}

runProviderContractSuite("filesystem", () => {
  const root = makeRoot();
  const provider = createFilesystemProvider({ root, config });
  return Promise.resolve({
    provider,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
});

const redisPassword: ValueFile = {
  namespace: ["redis"],
  name: "password",
  scope: { kind: "environment", environment: "production" },
  encrypted: false,
};

describe("FilesystemProvider", () => {
  it("is the filesystem provider", () => {
    expect(makeProvider().type).toBe("@penvhq/provider-filesystem");
  });

  describe("nested namespaces", () => {
    it("creates a deep namespace on write and reads back through it", async () => {
      const provider = makeProvider();
      const file: ValueFile = {
        namespace: ["services", "billing", "stripe"],
        name: "secret-key",
        scope: { kind: "unscoped" },
        encrypted: false,
      };

      await provider.write(file, "sk_test_123");

      expect(existsSync(join(provider.root, "services", "billing", "stripe", "secret-key"))).toBe(
        true,
      );
      expect(await provider.read(file)).toBe("sk_test_123");
    });

    it("lists parameters from every depth with their namespace intact", async () => {
      const provider = makeProvider();
      const root: ValueFile = {
        namespace: [],
        name: "database-url",
        scope: { kind: "unscoped" },
        encrypted: false,
      };
      const deep: ValueFile = {
        namespace: ["services", "billing"],
        name: "stripe-key",
        scope: { kind: "local" },
        encrypted: true,
      };

      await provider.write(root, "postgres://localhost/dev");
      await provider.write(deep, "ciphertext");

      const listed = await provider.list();
      expect(listed).toHaveLength(2);
      expect(listed).toContainEqual(root);
      expect(listed).toContainEqual(deep);
    });

    it("keeps same-named parameters in different namespaces apart", async () => {
      const provider = makeProvider();
      const app: ValueFile = { ...redisPassword, namespace: ["app"] };

      await provider.write(redisPassword, "redis-value");
      await provider.write(app, "app-value");

      expect(await provider.read(redisPassword)).toBe("redis-value");
      expect(await provider.read(app)).toBe("app-value");
    });
  });

  describe("environment-local scope", () => {
    it("writes the environment before local, so .enc stays terminal", async () => {
      const provider = makeProvider();
      const file: ValueFile = {
        ...redisPassword,
        scope: { kind: "environment-local", environment: "production" },
        encrypted: true,
      };

      await provider.write(file, "ciphertext");

      expect(existsSync(join(provider.root, "redis", "password.production.local.enc"))).toBe(true);
      expect(await provider.read(file)).toBe("ciphertext");
    });

    it("keeps .production.local and .staging.local as distinct files", async () => {
      const provider = makeProvider();
      const forProduction: ValueFile = {
        ...redisPassword,
        scope: { kind: "environment-local", environment: "production" },
      };
      const forStaging: ValueFile = {
        ...redisPassword,
        scope: { kind: "environment-local", environment: "staging" },
      };

      await provider.write(forProduction, "personal-production");
      await provider.write(forStaging, "personal-staging");

      expect(await provider.read(forProduction)).toBe("personal-production");
      expect(await provider.read(forStaging)).toBe("personal-staging");
      expect(await provider.list()).toHaveLength(2);
    });

    it("parses a hand-written .development.local back to the scope that wrote it", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });
      writeFileSync(join(provider.root, "redis", "password.development.local"), "mine\n", "utf8");

      expect(await provider.list()).toEqual([
        {
          namespace: ["redis"],
          name: "password",
          scope: { kind: "environment-local", environment: "development" },
          encrypted: false,
        },
      ]);
    });
  });

  describe("empty-directory cleanup on remove", () => {
    it("removes the namespace directory once its last parameter is gone", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");

      await provider.remove(redisPassword);

      expect(existsSync(join(provider.root, "redis"))).toBe(false);
      expect(existsSync(provider.root)).toBe(true);
    });

    it("keeps the namespace while another file still lives in it", async () => {
      const provider = makeProvider();
      const other: ValueFile = { ...redisPassword, scope: { kind: "unscoped" } };
      await provider.write(redisPassword, "hunter2");
      await provider.write(other, "default");

      await provider.remove(redisPassword);

      expect(existsSync(join(provider.root, "redis"))).toBe(true);
      expect(await provider.read(other)).toBe("default");
    });

    it("keeps a namespace that still holds meta", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");
      await provider.writeMeta({ namespace: ["redis"], name: "password" }, { secret: true });

      await provider.remove(redisPassword);

      expect(existsSync(join(provider.root, "redis"))).toBe(true);
      expect(await provider.readMeta({ namespace: ["redis"], name: "password" })).toEqual({
        secret: true,
      });
    });

    it("prunes every namespace level that empties, and never the root", async () => {
      const provider = makeProvider();
      const deep: ValueFile = {
        namespace: ["services", "billing", "stripe"],
        name: "secret-key",
        scope: { kind: "unscoped" },
        encrypted: false,
      };
      await provider.write(deep, "sk_test_123");

      await provider.remove(deep);

      expect(existsSync(join(provider.root, "services"))).toBe(false);
      expect(existsSync(provider.root)).toBe(true);
    });

    it("does not prune when the value was already absent", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });

      await provider.remove(redisPassword);

      expect(existsSync(join(provider.root, "redis"))).toBe(true);
    });
  });

  describe("trailing newline handling", () => {
    it("writes the value with exactly one trailing newline", async () => {
      const provider = makeProvider();

      await provider.write(redisPassword, "hunter2");

      expect(readFileSync(join(provider.root, "redis", "password.production"), "utf8")).toBe(
        "hunter2\n",
      );
    });

    it("strips exactly one trailing newline on read", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });
      writeFileSync(join(provider.root, "redis", "password.production"), "hunter2\n\n", "utf8");

      expect(await provider.read(redisPassword)).toBe("hunter2\n");
    });

    it("reads a hand-written file that has no trailing newline", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });
      writeFileSync(join(provider.root, "redis", "password.production"), "hunter2", "utf8");

      expect(await provider.read(redisPassword)).toBe("hunter2");
    });

    it("does not trim other whitespace — the value is opaque", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });
      writeFileSync(join(provider.root, "redis", "password.production"), "  hunter2  \n", "utf8");

      expect(await provider.read(redisPassword)).toBe("  hunter2  ");
    });

    it("reads an empty file as an empty value", async () => {
      const provider = makeProvider();
      mkdirSync(join(provider.root, "redis"), { recursive: true });
      writeFileSync(join(provider.root, "redis", "password.production"), "", "utf8");

      expect(await provider.read(redisPassword)).toBe("");
    });
  });

  describe("list", () => {
    it("ignores env.ts, which is the user's schema and not a parameter", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, "env.ts"), "export const schema = {};\n", "utf8");
      await provider.write(redisPassword, "hunter2");

      expect(await provider.list()).toEqual([redisPassword]);
    });

    it("ignores .gitignore", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, ".gitignore"), "*\n", "utf8");

      expect(await provider.list()).toEqual([]);
    });

    it("ignores a stray .DS_Store and still lists the real parameters", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");
      writeFileSync(join(provider.root, ".DS_Store"), "  ", "utf8");

      expect(await provider.list()).toEqual([redisPassword]);
    });

    it("ignores a stray .DS_Store inside a namespace directory", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");
      writeFileSync(join(provider.root, "redis", ".DS_Store"), "  ", "utf8");

      expect(await provider.list()).toEqual([redisPassword]);
    });

    it("ignores an editor swap file, which never claimed to be a parameter", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");
      writeFileSync(join(provider.root, "redis", ".password.production.swp"), "swap", "utf8");

      expect(await provider.list()).toEqual([redisPassword]);
    });

    it("still throws for a malformed parameter filename alongside a stray dotfile", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, ".DS_Store"), "  ", "utf8");
      writeFileSync(join(provider.root, "database-url.qa"), "value\n", "utf8");

      await expect(provider.list()).rejects.toBeInstanceOf(UnknownEnvironmentError);
    });

    it("returns nothing when the root does not exist yet", async () => {
      const provider = createFilesystemProvider({ root: join(makeRoot(), "absent"), config });

      expect(await provider.list()).toEqual([]);
    });

    it("propagates the grammar error for a malformed parameter filename", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, "database-url.enc.production"), "value\n", "utf8");

      await expect(provider.list()).rejects.toBeInstanceOf(FilenameGrammarError);
    });

    it("propagates an undeclared environment segment rather than inferring it", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, "database-url.qa"), "value\n", "utf8");

      await expect(provider.list()).rejects.toBeInstanceOf(UnknownEnvironmentError);
    });

    it("reads an environment segment only because the config declares it", async () => {
      const provider = createFilesystemProvider({
        root: makeRoot(),
        config: { environments: ["qa"], providers: {} },
      });
      writeFileSync(join(provider.root, "database-url.qa"), "value\n", "utf8");

      expect(await provider.list()).toEqual([
        {
          namespace: [],
          name: "database-url",
          scope: { kind: "environment", environment: "qa" },
          encrypted: false,
        },
      ]);
    });
  });

  describe("synchronous read path", () => {
    it("readSync sees what write wrote", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");

      expect(provider.readSync(redisPassword)).toBe("hunter2");
      expect(provider.readSync({ ...redisPassword, scope: { kind: "local" } })).toBeUndefined();
    });

    it("listSync matches list", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");

      expect(provider.listSync()).toEqual(await provider.list());
    });

    it("listSync ignores a stray .DS_Store — this path backs load(), so startup must not crash", async () => {
      const provider = makeProvider();
      await provider.write(redisPassword, "hunter2");
      writeFileSync(join(provider.root, ".DS_Store"), "  ", "utf8");

      expect(provider.listSync()).toEqual([redisPassword]);
    });

    it("listSync still throws for a malformed parameter filename", async () => {
      const provider = makeProvider();
      writeFileSync(join(provider.root, "database-url.enc.production"), "value\n", "utf8");

      expect(() => provider.listSync()).toThrow(FilenameGrammarError);
    });

    it("readMetaSync matches readMeta", async () => {
      const provider = makeProvider();
      const ref = { namespace: ["redis"], name: "password" };
      await provider.writeMeta(ref, { description: "Redis auth", secret: true });

      expect(provider.readMetaSync(ref)).toEqual(await provider.readMeta(ref));
      expect(provider.readMetaSync({ namespace: [], name: "absent" })).toBeUndefined();
    });
  });
});
