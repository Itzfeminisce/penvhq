/**
 * Finding 24: penv's own first-party packages were the ones omitting
 * `penv.types`, so what `penv add` committed for them was the open fallback —
 * whose index signature accepts a misspelled key and a misspelled value alike.
 *
 * Every official provider that has a config shape is checked here against the
 * three rules the committed file lives by: the declared path exists inside the
 * package, its text passes the self-containment check — it lands in a repository
 * where the package it came from is not installed — and it names none of the
 * fields core writes into an entry. The last two are what `renderDeclaration`
 * refuses, so a render that returns at all is both of them passing.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readExtensionPackage, renderDeclaration } from "./declaration.js";

const providers = resolve(import.meta.dirname, "..", "..", "providers");

/** The providers a project installs from a registry. `filesystem` and `mock` ship inside the engine. */
const OFFICIAL = ["vercel", "github", "vault", "ssm", "kubernetes"] as const;

describe.each(OFFICIAL)("@penvhq/provider-%s", (provider) => {
  const dir = join(providers, provider);
  const installed = readExtensionPackage(dir);

  it("declares its config shape in `penv.types`", () => {
    expect(installed.types).toBeDefined();
  });

  it("ships a declaration `penv add` commits verbatim, not the open fallback", () => {
    const source = readFileSync(join(dir, installed.types ?? ""), "utf8");
    const written = renderDeclaration(
      { name: installed.name ?? "", version: installed.version ?? "", attested: false },
      { file: installed.types ?? "", source },
    );

    expect(written).toContain(`interface ProviderConfigMap`);
    expect(written).toContain(JSON.stringify(installed.name));
    expect(written).not.toContain("ProviderConfig &");
  });

  it("packs that declaration, or the store copy has nothing to commit", () => {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      files: readonly string[];
    };

    expect(manifest.files).toContain(installed.types);
  });
});
