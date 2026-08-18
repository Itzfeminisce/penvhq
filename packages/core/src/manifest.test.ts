import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PenvError } from "./errors.js";
import { CANONICAL_EXAMPLE, DIGESTS, GOLDEN, withDigests } from "./manifest.fixtures.js";
import type { Manifest } from "./manifest.js";
import {
  ENGINE_PACKAGE,
  MANIFEST_FORMAT,
  MANIFEST_PATH,
  ManifestError,
  parseManifest,
  serializeManifest,
  UnsupportedManifestFormatError,
} from "./manifest.js";

const ENGINE = { package: ENGINE_PACKAGE, version: "0.9.0", integrity: DIGESTS[0] };
const VAULT = { version: "0.9.0", integrity: DIGESTS[1] };
const THIRD_PARTY_TRUST = {
  tier: "third-party",
  publisher: "acme-oss",
  publishedAt: "2026-07-02T09:14:00Z",
  acknowledgedAt: "2026-08-17T00:00:00Z",
  reason: "Reviewed v1.4.2 source; Consul is our KV store.",
};
const CONSUL = { version: "1.4.2", integrity: DIGESTS[2], trust: THIRD_PARTY_TRUST };

function manifest(extensions: Record<string, unknown> = {}): Record<string, unknown> {
  return { format: MANIFEST_FORMAT, engine: { ...ENGINE }, extensions };
}

function text(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A trust block with one field changed, or removed when the value is `undefined`. */
function trust(change: Record<string, unknown>): Record<string, unknown> {
  const block: Record<string, unknown> = { ...THIRD_PARTY_TRUST, ...change };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete block[key];
  }
  return block;
}

function refusalFor(source: string): PenvError {
  try {
    parseManifest(source);
  } catch (error) {
    return error as PenvError;
  }
  throw new Error("parseManifest accepted a manifest it should have refused");
}

describe("the canonical example", () => {
  it("is the JSON block in ISSUE-04, verbatim", () => {
    const issue = fileURLToPath(
      new URL("../../../docs/rebuild/ISSUE-04-manifest-module.md", import.meta.url),
    );
    const source = readFileSync(issue, "utf8").replaceAll("\r\n", "\n");
    const block = /```json\n([\s\S]*?)```/.exec(source)?.[1];

    expect(block?.trimEnd()).toBe(CANONICAL_EXAMPLE);
  });

  it("parses once its placeholders are real digests", () => {
    const parsed = parseManifest(withDigests());

    expect(parsed.format).toBe(1);
    expect(parsed.engine.package).toBe(ENGINE_PACKAGE);
    expect(Object.keys(parsed.extensions)).toEqual([
      "@penvhq/provider-vault",
      "@acme/provider-consul",
      "@internal/provider-secrets",
    ]);
    expect(parsed.extensions["@acme/provider-consul"]?.trust?.tier).toBe("third-party");
    expect(parsed.extensions["@internal/provider-secrets"]?.trust?.tier).toBe("private");
    expect(parsed.extensions["@penvhq/provider-vault"]?.trust).toBeUndefined();
  });

  it("refuses the `sha512-…` placeholder as an integrity string", () => {
    const refusal = refusalFor(CANONICAL_EXAMPLE);

    expect(refusal).toBeInstanceOf(ManifestError);
    expect(refusal.code).toBe("MANIFEST_INTEGRITY");
  });
});

describe("the golden round trip", () => {
  it("serializes the canonical example to the committed form", () => {
    expect(serializeManifest(parseManifest(withDigests()))).toBe(GOLDEN);
  });

  it("is byte-identical on the way back out", () => {
    expect(serializeManifest(parseManifest(GOLDEN))).toBe(GOLDEN);
  });

  it("reads the same manifest either way round", () => {
    expect(parseManifest(GOLDEN)).toEqual(parseManifest(withDigests()));
  });

  it("sorts every key, indents by two, and ends with a newline", () => {
    const lines = GOLDEN.split("\n");

    expect(Object.keys(JSON.parse(GOLDEN))).toEqual(["engine", "extensions", "format"]);
    expect(Object.keys(JSON.parse(GOLDEN).extensions)).toEqual([
      "@acme/provider-consul",
      "@internal/provider-secrets",
      "@penvhq/provider-vault",
    ]);
    expect(lines[1]).toBe('  "engine": {');
    expect(GOLDEN.endsWith("}\n")).toBe(true);
  });
});

describe("refusals", () => {
  const cases: readonly {
    readonly name: string;
    readonly code: string;
    readonly source: string;
  }[] = [
    {
      name: "text that is not JSON",
      code: "MANIFEST_PARSE",
      source: '{ "format": 1,,, }',
    },
    {
      name: "a root that is not an object",
      code: "MANIFEST_ROOT",
      source: "[]",
    },
    {
      name: "a format from a newer penv",
      code: "MANIFEST_FORMAT_UNSUPPORTED",
      source: text({ ...manifest(), format: 2 }),
    },
    {
      name: "a missing format",
      code: "MANIFEST_FORMAT_INVALID",
      source: text({ engine: { ...ENGINE }, extensions: {} }),
    },
    {
      name: "a format written as a string",
      code: "MANIFEST_FORMAT_INVALID",
      source: text({ ...manifest(), format: "1" }),
    },
    {
      name: "an unknown top-level key",
      code: "MANIFEST_UNKNOWN_KEY",
      source: text({ ...manifest(), snapshot: {} }),
    },
    {
      name: "an unknown key on an extension",
      code: "MANIFEST_UNKNOWN_KEY",
      source: text(manifest({ "@penvhq/provider-vault": { ...VAULT, config: {} } })),
    },
    {
      name: "an unknown key inside a trust block",
      code: "MANIFEST_UNKNOWN_KEY",
      source: text(manifest({ "@acme/provider-consul": { ...CONSUL, trust: trust({ age: 7 }) } })),
    },
    {
      name: "a publisher on a private trust block",
      code: "MANIFEST_UNKNOWN_KEY",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: {
              tier: "private",
              publisher: "acme-oss",
              acknowledgedAt: "2026-08-17T00:00:00Z",
              reason: "First-party adapter.",
            },
          },
        }),
      ),
    },
    {
      name: "a ranged engine version",
      code: "MANIFEST_VERSION_NOT_EXACT",
      source: text({ ...manifest(), engine: { ...ENGINE, version: "^0.9.0" } }),
    },
    {
      name: "a dist-tag version",
      code: "MANIFEST_VERSION_NOT_EXACT",
      source: text(manifest({ "@penvhq/provider-vault": { ...VAULT, version: "latest" } })),
    },
    {
      name: "an integrity that is not sha512",
      code: "MANIFEST_INTEGRITY",
      source: text({
        ...manifest(),
        engine: { ...ENGINE, integrity: "sha1-cnwjOZa1QIgWKlIvbaFnCcOVYGA=" },
      }),
    },
    {
      name: "a truncated integrity",
      code: "MANIFEST_INTEGRITY",
      source: text({ ...manifest(), engine: { ...ENGINE, integrity: "sha512-abc==" } }),
    },
    {
      name: "an engine that is not @penvhq/cli",
      code: "MANIFEST_FIELD_VALUE",
      source: text({ ...manifest(), engine: { ...ENGINE, package: "@acme/cli" } }),
    },
    {
      name: "a missing engine",
      code: "MANIFEST_FIELD_MISSING",
      source: text({ format: MANIFEST_FORMAT, extensions: {} }),
    },
    {
      name: "a missing extensions block",
      code: "MANIFEST_FIELD_MISSING",
      source: text({ format: MANIFEST_FORMAT, engine: { ...ENGINE } }),
    },
    {
      name: "a third-party trust block with no publisher",
      code: "MANIFEST_FIELD_MISSING",
      source: text(
        manifest({
          "@acme/provider-consul": { ...CONSUL, trust: trust({ publisher: undefined }) },
        }),
      ),
    },
    {
      name: "a version that is not a string",
      code: "MANIFEST_FIELD_TYPE",
      source: text({ ...manifest(), engine: { ...ENGINE, version: 9 } }),
    },
    {
      name: "a trust block on an official extension",
      code: "MANIFEST_TRUST_FORBIDDEN",
      source: text(manifest({ "@penvhq/provider-vault": { ...VAULT, trust: THIRD_PARTY_TRUST } })),
    },
    {
      name: "a third-party extension with no trust block",
      code: "MANIFEST_TRUST_REQUIRED",
      source: text(
        manifest({ "@acme/provider-consul": { version: "1.4.2", integrity: DIGESTS[2] } }),
      ),
    },
    {
      name: "a trust tier penv does not know",
      code: "MANIFEST_TRUST_TIER",
      source: text(
        manifest({ "@acme/provider-consul": { ...CONSUL, trust: trust({ tier: "internal" }) } }),
      ),
    },
    {
      name: "an empty trust reason",
      code: "MANIFEST_TRUST_REASON",
      source: text(
        manifest({ "@acme/provider-consul": { ...CONSUL, trust: trust({ reason: " " }) } }),
      ),
    },
    {
      name: "an empty publisher",
      code: "MANIFEST_TRUST_PUBLISHER",
      source: text(
        manifest({ "@acme/provider-consul": { ...CONSUL, trust: trust({ publisher: "" }) } }),
      ),
    },
    {
      name: "a date with no time",
      code: "MANIFEST_TIMESTAMP",
      source: text(
        manifest({
          "@acme/provider-consul": { ...CONSUL, trust: trust({ publishedAt: "2026-07-02" }) },
        }),
      ),
    },
    {
      name: "a timestamp with a local offset",
      code: "MANIFEST_TIMESTAMP",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ acknowledgedAt: "2026-08-17T00:00:00+02:00" }),
          },
        }),
      ),
    },
    {
      name: "a registry served over http",
      code: "MANIFEST_REGISTRY_NOT_HTTPS",
      source: text(
        manifest({
          "@acme/provider-consul": { ...CONSUL, registry: "http://npm.acme.internal" },
        }),
      ),
    },
    {
      name: "a registry that is npmjs anyway",
      code: "MANIFEST_REGISTRY_DEFAULT",
      source: text(
        manifest({
          "@acme/provider-consul": { ...CONSUL, registry: "https://registry.npmjs.org" },
        }),
      ),
    },
    {
      name: "a registry that is not a URL",
      code: "MANIFEST_REGISTRY_INVALID",
      source: text(
        manifest({ "@acme/provider-consul": { ...CONSUL, registry: "npm.acme.internal" } }),
      ),
    },
    {
      name: "an extension key that is not a package name",
      code: "MANIFEST_PACKAGE_NAME",
      source: text(manifest({ "Provider Consul": { ...CONSUL } })),
    },
    {
      name: "a POSIX absolute path in a reason",
      code: "MANIFEST_ABSOLUTE_PATH",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Vendored at /home/dana/src/consul-adapter." }),
          },
        }),
      ),
    },
    {
      name: "a Windows absolute path in a reason",
      code: "MANIFEST_ABSOLUTE_PATH",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Reviewed at C:\\Users\\dana\\consul." }),
          },
        }),
      ),
    },
    {
      name: "a token in a reason",
      code: "MANIFEST_CREDENTIAL",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Pulled with ghp_0123456789abcdefghijKLMNOPQRSTUVWXYZ." }),
          },
        }),
      ),
    },
    {
      name: "credentials embedded in a registry URL",
      code: "MANIFEST_CREDENTIAL",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            registry: "https://deploy:s3cret@npm.acme.internal",
          },
        }),
      ),
    },
    {
      name: "provider configuration in a reason",
      code: "MANIFEST_PROVIDER_CONFIG",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Set CONSUL_HTTP_ADDR=https://consul.acme.internal:8500." }),
          },
        }),
      ),
    },
    {
      name: "a value in a reason",
      code: "MANIFEST_PROVIDER_CONFIG",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Replaces postgres://app@db.acme.internal/main." }),
          },
        }),
      ),
    },
  ];

  it.each(cases)("refuses $name", ({ code, source }) => {
    expect(refusalFor(source).code).toBe(code);
  });

  it.each(cases)("names the file and exactly one remedy for $name", ({ source }) => {
    const refusal = refusalFor(source);

    expect(refusal.remedy).toBeTruthy();
    expect(refusal.message).toContain(MANIFEST_PATH);
    expect(refusal.message.split(refusal.remedy ?? "")).toHaveLength(2);
  });
});

describe("an unsupported format", () => {
  const source = text({ ...manifest(), format: 2 });

  it("says which format the file is and asks for nothing to be diagnosed", () => {
    const refusal = refusalFor(source);

    expect(refusal).toBeInstanceOf(UnsupportedManifestFormatError);
    expect(refusal.message).toContain("is format 2");
    expect(refusal.remedy).toBe("Update penv, then run the command again.");
  });

  it("takes the launcher's own update command and the command that was running", () => {
    const refusal = refusalFor(source) as UnsupportedManifestFormatError;
    const filled = refusal.withLauncherUpdate({
      updateCommand: "brew upgrade penv",
      invokedCommand: "penv run -- pnpm dev",
    });

    expect(filled.found).toBe(2);
    expect(filled.supported).toBe(MANIFEST_FORMAT);
    expect(filled.remedy).toBe("Run `brew upgrade penv`, then `penv run -- pnpm dev` again.");
  });
});

describe("manifests that stay quiet", () => {
  const cases: readonly { readonly name: string; readonly source: string }[] = [
    { name: "no extensions at all", source: text(manifest()) },
    {
      name: "an official extension with no trust block",
      source: text(manifest({ "@penvhq/provider-vault": VAULT })),
    },
    {
      name: "a third-party extension with a full trust block",
      source: text(manifest({ "@acme/provider-consul": CONSUL })),
    },
    {
      name: "a private extension on its own registry",
      source: text(
        manifest({
          "@internal/provider-secrets": {
            version: "2.0.0",
            integrity: DIGESTS[3],
            registry: "https://npm.acme.internal/repo/",
            trust: {
              tier: "private",
              acknowledgedAt: "2026-08-17T00:00:00Z",
              reason: "First-party adapter.",
            },
          },
        }),
      ),
    },
    {
      name: "an unscoped package with a trust block",
      source: text(manifest({ "provider-consul": { ...CONSUL } })),
    },
    {
      name: "a prerelease engine version",
      source: text({ ...manifest(), engine: { ...ENGINE, version: "1.0.0-rc.1" } }),
    },
    {
      name: "a version carrying build metadata",
      source: text({ ...manifest(), engine: { ...ENGINE, version: "1.0.0+build.5" } }),
    },
    {
      name: "a reason that links to the source it reviewed",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "Read https://github.com/acme/provider-consul at v1.4.2." }),
          },
        }),
      ),
    },
    {
      name: "a reason with slashes in ordinary prose",
      source: text(
        manifest({
          "@acme/provider-consul": {
            ...CONSUL,
            trust: trust({ reason: "On-call 24/7; the KV store is ours and/or Consul's." }),
          },
        }),
      ),
    },
  ];

  it.each(cases)("accepts $name", ({ source }) => {
    expect(() => parseManifest(source)).not.toThrow();
  });

  it("round-trips every one of them", () => {
    for (const { source } of cases) {
      const once = serializeManifest(parseManifest(source));
      expect(serializeManifest(parseManifest(once))).toBe(once);
    }
  });
});

describe("serializeManifest", () => {
  it("refuses to write a manifest penv could not read back", () => {
    const invalid = manifest({
      "@penvhq/provider-vault": { ...VAULT, trust: THIRD_PARTY_TRUST },
    }) as unknown as Manifest;

    expect(() => serializeManifest(invalid)).toThrow(ManifestError);
  });

  it("refuses to write a credential someone put in a trust reason", () => {
    const invalid = manifest({
      "@acme/provider-consul": {
        ...CONSUL,
        trust: trust({ reason: "Key AKIAIOSFODNN7EXAMPLE is in the CI secret store." }),
      },
    }) as unknown as Manifest;

    expect(() => serializeManifest(invalid)).toThrow(ManifestError);
  });
});
