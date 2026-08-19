import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attestationWarning,
  developmentPin,
  embedPin,
  integrityOf,
  LAUNCHER_PUBLISH_ARGS,
  publishedPackageDirs,
  REPOSITORY_URL,
  readPin,
  repositoryProblem,
  repositoryProblems,
} from "../../../scripts/engine-pin.js";
import { DEV_PIN_INTEGRITY, DEV_PIN_VERSION } from "./pins.js";

/**
 * The release rewrite, tested against the real committed pins.ts — not a copy —
 * so the script and the file it rewrites cannot drift apart.
 */
const source = readFileSync(new URL("./pins.ts", import.meta.url), "utf8");

const RELEASE = {
  version: "0.9.1",
  integrity: `sha512-${"A".repeat(86)}==`,
} as const;

describe("the pin the repository commits", () => {
  it("is the development placeholder, resolved through its constants", () => {
    expect(readPin(source)).toEqual({ version: DEV_PIN_VERSION, integrity: DEV_PIN_INTEGRITY });
  });

  it("names the placeholder in constants the script can find", () => {
    expect(developmentPin(source)).toEqual({
      version: DEV_PIN_VERSION,
      integrity: DEV_PIN_INTEGRITY,
    });
  });
});

describe("the embed rewrite", () => {
  it("replaces exactly the two pin literals", () => {
    const embedded = embedPin(source, RELEASE);
    expect(readPin(embedded)).toEqual(RELEASE);
    // The placeholder constants stay — the launcher's own dev-refusal reads them.
    expect(developmentPin(embedded)).toEqual(developmentPin(source));
  });

  it("is idempotent", () => {
    const once = embedPin(source, RELEASE);
    expect(embedPin(once, RELEASE)).toBe(once);
  });

  it("refuses an integrity that is not an npm sha512", () => {
    expect(() => embedPin(source, { version: "0.9.1", integrity: "sha256-short" })).toThrow(
      "not an npm sha512 integrity",
    );
  });

  it("refuses to embed the development placeholder", () => {
    expect(() =>
      embedPin(source, { version: DEV_PIN_VERSION, integrity: RELEASE.integrity }),
    ).toThrow("development placeholder");
  });

  it("refuses a pins.ts whose package is not the shared constant", () => {
    const tampered = source.replace("package: ENGINE_PACKAGE,", 'package: "@acme/engine",');
    expect(() => embedPin(tampered, RELEASE)).toThrow("not the shared ENGINE_PACKAGE");
  });
});

describe("the ssri", () => {
  it("is the sha512 of the bytes, in npm's spelling", () => {
    const integrity = integrityOf(new TextEncoder().encode("penv"));
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });
});

/**
 * Finding 27: penv's own packages carried no provenance attestation, and the
 * official trust tier — the one `penv add` skips every question for — rests on
 * one. Two causes, both silent: pnpm 11 reads no `npm_config_*`, so the
 * workflow's `NPM_CONFIG_PROVENANCE` reached nobody, and npm's registry rejects
 * a provenance bundle for a package with no matching `repository`.
 */
describe("what a release needs before npm will attest it", () => {
  it("is declared by every package this repository publishes", () => {
    expect(publishedPackageDirs()).toContain("packages/cli");
    expect(publishedPackageDirs()).toContain("packages/providers/vercel");
    expect(repositoryProblems()).toEqual([]);
  });

  it("fires on a package that declares no repository at all", () => {
    expect(repositoryProblem({ name: "@penvhq/x", version: "1.0.0" }, "packages/x")).toBe(
      "@penvhq/x declares no `repository` object, so npm will not attest it",
    );
  });

  /** The case that costs a release: npm's match is case-sensitive on the owner. */
  it("fires on a url that is not this repository, and on the wrong directory", () => {
    const wrongUrl = repositoryProblem(
      {
        name: "@penvhq/x",
        version: "1.0.0",
        repository: { url: REPOSITORY_URL.toLowerCase(), directory: "packages/x" },
      },
      "packages/x",
    );
    expect(wrongUrl).toContain(`not \`${REPOSITORY_URL}\``);

    const wrongDirectory = repositoryProblem(
      { name: "@penvhq/x", version: "1.0.0", repository: { url: REPOSITORY_URL, directory: "x" } },
      "packages/x",
    );
    expect(wrongDirectory).toContain("not `packages/x`");
  });

  it("is stated outright by the one publish changesets never sees", () => {
    expect(LAUNCHER_PUBLISH_ARGS).toContain("--provenance");
    expect(LAUNCHER_PUBLISH_ARGS.join(" ")).toBe(
      "--filter @penvhq/launcher publish --access public --provenance --no-git-checks",
    );
  });
});

describe("the attestation the release reads back", () => {
  it("warns loudly when npm recorded none", () => {
    const warning = attestationWarning("@penvhq/cli", "0.11.0", { integrity: "sha512-x" });

    expect(warning[0]).toBe("⚠ npm records no provenance attestation for @penvhq/cli 0.11.0");
    expect(warning.join("\n")).toContain("PNPM_CONFIG_PROVENANCE");
  });

  /** The quiet half — an attested release says nothing, the way a passing check should. */
  it("stays silent when it did", () => {
    expect(
      attestationWarning("@penvhq/cli", "0.11.0", {
        integrity: "sha512-x",
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@penvhq%2fcli@0.11.0",
        },
      }),
    ).toEqual([]);
  });
});
