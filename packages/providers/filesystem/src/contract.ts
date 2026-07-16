/**
 * The provider contract suite: the behaviour every provider must satisfy.
 *
 * This is the suite the Vault adapter must pass unchanged. Nothing here may
 * assume a filesystem — no paths, no `node:fs`, no on-disk layout. It speaks
 * only the vocabulary of `@penv/core`: a provider is addressed by
 * `(namespace, name, scope, encrypted)` and nothing else.
 *
 * A provider handed to this suite must accept the environments `development`
 * and `production`, and must start empty.
 */

import type { Meta, ParameterRef, Provider, Scope, ValueFile } from "@penv/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENVIRONMENT = "production";
const OTHER_ENVIRONMENT = "development";

const redisPassword: ParameterRef = { namespace: ["redis"], name: "password" };
const databaseUrl: ParameterRef = { namespace: [], name: "database-url" };

function valueFile(ref: ParameterRef, scope: Scope, encrypted = false): ValueFile {
  return { namespace: ref.namespace, name: ref.name, scope, encrypted };
}

/** A stable identity built only from contract fields, so `list` order is not asserted. */
function identity(file: ValueFile): string {
  const scope =
    file.scope.kind === "environment" ? `environment:${file.scope.environment}` : file.scope.kind;
  return `${[...file.namespace, file.name].join("/")}|${scope}|${file.encrypted}`;
}

function identities(files: readonly ValueFile[]): string[] {
  return files.map(identity).sort();
}

export function runProviderContractSuite(
  name: string,
  makeProvider: () => Promise<{ provider: Provider; cleanup: () => Promise<void> }>,
): void {
  describe(`provider contract: ${name}`, () => {
    let provider: Provider;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const made = await makeProvider();
      provider = made.provider;
      cleanup = made.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("reports its type", () => {
      expect(typeof provider.type).toBe("string");
      expect(provider.type.length).toBeGreaterThan(0);
    });

    describe("read and write", () => {
      it("round-trips a written value", async () => {
        const file = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });

        await provider.write(file, "hunter2");

        expect(await provider.read(file)).toBe("hunter2");
      });

      it("resolves to undefined for a value that was never written", async () => {
        const file = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });

        expect(await provider.read(file)).toBeUndefined();
      });

      it("overwrites in place rather than appending", async () => {
        const file = valueFile(databaseUrl, { kind: "unscoped" });

        await provider.write(file, "postgres://localhost/dev");
        await provider.write(file, "postgres://localhost/other");

        expect(await provider.read(file)).toBe("postgres://localhost/other");
      });

      it("creates namespaces as needed", async () => {
        const file = valueFile(
          { namespace: ["app", "auth"], name: "jwt-secret" },
          {
            kind: "unscoped",
          },
        );

        await provider.write(file, "s3cret");

        expect(await provider.read(file)).toBe("s3cret");
      });

      it("keeps each scope of one parameter at its own address", async () => {
        const unscoped = valueFile(redisPassword, { kind: "unscoped" });
        const scoped = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });
        const local = valueFile(redisPassword, { kind: "local" });

        await provider.write(unscoped, "default");
        await provider.write(scoped, "production");
        await provider.write(local, "personal");

        expect(await provider.read(unscoped)).toBe("default");
        expect(await provider.read(scoped)).toBe("production");
        expect(await provider.read(local)).toBe("personal");
      });

      it("keeps an encrypted value at its own address, orthogonal to scope", async () => {
        const plaintext = valueFile(redisPassword, { kind: "unscoped" });
        const encrypted = valueFile(redisPassword, { kind: "unscoped" }, true);

        await provider.write(plaintext, "plain");
        await provider.write(encrypted, "ciphertext");

        expect(await provider.read(plaintext)).toBe("plain");
        expect(await provider.read(encrypted)).toBe("ciphertext");
      });
    });

    describe("values are opaque", () => {
      const cases: readonly (readonly [string, string])[] = [
        ["an empty value", ""],
        ["leading and trailing spaces", "  padded  "],
        ["a tab", "\tindented"],
        ["an embedded newline", "line one\nline two"],
        ["a trailing newline", "trailing\n"],
        ["several trailing newlines", "trailing\n\n\n"],
        ["a lone carriage return", "crlf\r\nvalue"],
        ["unicode", "clé-privée-🔐-Ω"],
        ["quotes and escapes", `{"a":"b\\n"} 'single' "double"`],
        ["a base64-shaped value", "aGVsbG8gd29ybGQ=\n"],
      ];

      for (const [label, value] of cases) {
        it(`preserves ${label} byte-exactly`, async () => {
          const file = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });

          await provider.write(file, value);

          expect(await provider.read(file)).toBe(value);
        });
      }
    });

    describe("list", () => {
      it("returns nothing for a provider holding no values", async () => {
        expect(await provider.list()).toEqual([]);
      });

      it("returns every written value file across every scope", async () => {
        const written: ValueFile[] = [
          valueFile(databaseUrl, { kind: "unscoped" }),
          valueFile(databaseUrl, { kind: "environment", environment: ENVIRONMENT }, true),
          valueFile(redisPassword, { kind: "environment", environment: OTHER_ENVIRONMENT }),
          valueFile(redisPassword, { kind: "local" }),
          valueFile({ namespace: ["app"], name: "jwt-secret" }, { kind: "local" }, true),
        ];

        for (const file of written) {
          await provider.write(file, "value");
        }

        expect(identities(await provider.list())).toEqual(identities(written));
      });

      it("does not list a removed value", async () => {
        const kept = valueFile(databaseUrl, { kind: "unscoped" });
        const removed = valueFile(redisPassword, { kind: "unscoped" });

        await provider.write(kept, "a");
        await provider.write(removed, "b");
        await provider.remove(removed);

        expect(identities(await provider.list())).toEqual(identities([kept]));
      });

      it("does not list meta as a value", async () => {
        await provider.writeMeta(redisPassword, { description: "Redis auth" });

        expect(await provider.list()).toEqual([]);
      });
    });

    describe("remove", () => {
      it("deletes the value", async () => {
        const file = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });
        await provider.write(file, "hunter2");

        await provider.remove(file);

        expect(await provider.read(file)).toBeUndefined();
      });

      it("is idempotent — removing an absent value is not an error", async () => {
        const file = valueFile(redisPassword, { kind: "local" });

        await expect(provider.remove(file)).resolves.toBeUndefined();
        await expect(provider.remove(file)).resolves.toBeUndefined();
      });

      it("removes only the scope it was given", async () => {
        const unscoped = valueFile(redisPassword, { kind: "unscoped" });
        const scoped = valueFile(redisPassword, { kind: "environment", environment: ENVIRONMENT });
        await provider.write(unscoped, "default");
        await provider.write(scoped, "production");

        await provider.remove(scoped);

        expect(await provider.read(unscoped)).toBe("default");
        expect(await provider.read(scoped)).toBeUndefined();
      });

      it("leaves meta alone", async () => {
        const file = valueFile(redisPassword, { kind: "unscoped" });
        await provider.write(file, "hunter2");
        await provider.writeMeta(redisPassword, { description: "Redis auth" });

        await provider.remove(file);

        expect(await provider.readMeta(redisPassword)).toEqual({ description: "Redis auth" });
      });
    });

    describe("meta", () => {
      it("resolves to undefined for a parameter with no meta", async () => {
        expect(await provider.readMeta(redisPassword)).toBeUndefined();
      });

      it("round-trips a meta file", async () => {
        const meta: Meta = {
          description: "Signs and verifies user session JWTs",
          owner: "auth-team",
          secret: true,
          environments: {
            production: { required: true, owner: "infra-team" },
            development: { required: false },
          },
        };

        await provider.writeMeta(redisPassword, meta);

        expect(await provider.readMeta(redisPassword)).toEqual(meta);
      });

      it("preserves unknown keys, so an older penv does not destroy newer fields", async () => {
        const meta: Meta = {
          description: "Redis auth",
          rotationPolicy: "90d",
          environments: { production: { rotationState: "active", rotatingSince: null } },
        };

        await provider.writeMeta(redisPassword, meta);

        expect(await provider.readMeta(redisPassword)).toEqual(meta);
      });

      it("overwrites meta in place", async () => {
        await provider.writeMeta(redisPassword, { description: "first", owner: "a-team" });
        await provider.writeMeta(redisPassword, { description: "second" });

        expect(await provider.readMeta(redisPassword)).toEqual({ description: "second" });
      });

      it("keeps meta per parameter", async () => {
        await provider.writeMeta(redisPassword, { description: "Redis auth" });
        await provider.writeMeta(databaseUrl, { description: "Primary database" });

        expect(await provider.readMeta(redisPassword)).toEqual({ description: "Redis auth" });
        expect(await provider.readMeta(databaseUrl)).toEqual({ description: "Primary database" });
      });

      it("holds meta independently of any value", async () => {
        await provider.writeMeta(redisPassword, { description: "Redis auth", required: true });

        expect(await provider.read(valueFile(redisPassword, { kind: "unscoped" }))).toBeUndefined();
      });
    });
  });
}
