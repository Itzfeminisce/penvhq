/**
 * The runtime is a sync target's reader, never a provider selector.
 *
 * `resolve.ts` reads the local `.penv` tree for every environment, whatever
 * provider that environment declares — `penv pull` materialises the tree and the
 * runtime reads what is on disk. That identity is what makes changing a provider
 * a config change rather than an application rewrite, and it only holds if the
 * runtime cannot dial a network provider at boot. The provider *registry* — the
 * one place a `providers.*.type` becomes a concrete provider — lives in the CLI
 * for exactly this reason.
 *
 * `load.test.ts` pins the *behaviour* (a vault-declared environment resolves off
 * disk). This pins the *structure* that guarantees it: the runtime never imports
 * a registry, never depends on the CLI, and reaches for exactly one provider —
 * the filesystem — and never branches on a declared type to pick another. A
 * future edit that gave the runtime the ability to select a provider would trip
 * this before it could ship.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCES = ["config.ts", "load.ts", "resolve.ts", "index.ts"] as const;

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * The source with its comments removed, so a docstring that *names* the
 * invariant it upholds — `load` "never inspects `providers.*.type`" — is not
 * mistaken for the code that would break it.
 */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("the runtime never selects a provider", () => {
  it("imports no provider registry and no dispatch", () => {
    // The registry's exported surface (see `cli/src/registry.ts`) and the words
    // that would mean "pick a provider by its declared type". None may appear in
    // any runtime source.
    const forbidden = [
      "registry",
      "createProvider",
      "providerFactory",
      "isProviderRegistered",
      "assertProvidersRegistered",
      "@penv/cli",
    ];
    for (const source of SOURCES) {
      const text = code(source);
      for (const token of forbidden) {
        expect(text, `${source} must not reference \`${token}\``).not.toContain(token);
      }
    }
  });

  it("reaches for the filesystem provider and no other", () => {
    // The one provider the runtime constructs is the local tree's. A second
    // provider package appearing here would be a network provider the runtime
    // could reach at boot — the thing the sync-target rule forbids.
    const resolve = code("resolve.ts");
    expect(resolve).toContain("@penv/provider-filesystem");
    expect(resolve).toContain("createFilesystemProvider");

    const providerImports = [...resolve.matchAll(/from\s+"(@penv\/provider-[^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(providerImports).toEqual(["@penv/provider-filesystem"]);
  });

  it("never inspects a declared provider type", () => {
    // The runtime reads config for environments and keys, never to choose a
    // backend: `providers.*.type` is the CLI's to dispatch on, never the
    // runtime's. No runtime source may read a provider's `type`.
    for (const source of SOURCES) {
      const text = code(source);
      expect(text, `${source} must not read a provider's \`type\``).not.toMatch(
        /providers\b[^\n]*\.type/,
      );
    }
  });

  it("does not depend on the CLI, only on the filesystem provider", () => {
    const manifest = JSON.parse(read("../package.json")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = manifest.dependencies ?? {};
    expect(dependencies).toHaveProperty("@penv/provider-filesystem");
    expect(dependencies).not.toHaveProperty("@penv/cli");
  });
});
