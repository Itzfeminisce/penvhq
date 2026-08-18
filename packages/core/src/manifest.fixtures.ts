/**
 * The format-1 manifests the tests read.
 *
 * `CANONICAL_EXAMPLE` is the JSON block from `docs/rebuild/ISSUE-04-manifest-module.md`
 * verbatim — `manifest.test.ts` asserts it still matches the issue file character
 * for character, so the spec and the fixture cannot drift apart. Its `sha512-…`
 * placeholders are not integrity strings, which is why every parsing test uses
 * `withDigests`.
 */

export const CANONICAL_EXAMPLE = `{
  "format": 1,
  "engine": {
    "package": "@penvhq/cli",
    "version": "0.9.0",
    "integrity": "sha512-…"
  },
  "extensions": {
    "@penvhq/provider-vault": { "version": "0.9.0", "integrity": "sha512-…" },
    "@acme/provider-consul": {
      "version": "1.4.2",
      "integrity": "sha512-…",
      "trust": {
        "tier": "third-party",
        "publisher": "acme-oss",
        "publishedAt": "2026-07-02T09:14:00Z",
        "acknowledgedAt": "2026-08-17T00:00:00Z",
        "reason": "Reviewed v1.4.2 source; Consul is our KV store."
      }
    },
    "@internal/provider-secrets": {
      "version": "2.0.0",
      "integrity": "sha512-…",
      "registry": "https://npm.acme.internal",
      "trust": { "tier": "private", "acknowledgedAt": "2026-08-17T00:00:00Z", "reason": "First-party adapter." }
    }
  }
}`;

/** Real sha512 digests, in the order the placeholders appear. */
export const DIGESTS = [
  "sha512-5kGoFb1nQsF5Bk33S2U4Adm9GUf24ma6vzGWsBFyM1N+ljuHB1ON+mb+EWXbrchCidASRHFvrtEZstFegBMZUA==",
  "sha512-fcaLwC3yc/uLbil8GsT7wKDXCP82+RfOfJhuzbSTYp3A9AbxystdyO+zmXtrnz8sqFnEujDtYKHlyXpxwpESSQ==",
  "sha512-JZP481lR/6SflxCPv4mXzPRNkZ01uCKV+UQPWh4li6DCx913ToMv8GhFM5xjhAVDUCfwl4Q1kKlWAdSsvWddOw==",
  "sha512-J80l+5d3S5iLJXMw/p8CnRA2kgWTcLK9tM7xJVoA4ceS3wfR2TCvh2d8eJ0y25xT23ETxg/n5A8pR3EAqcpRBQ==",
] as const;

/** The canonical example with its placeholders replaced by digests npm could have written. */
export function withDigests(text = CANONICAL_EXAMPLE): string {
  let index = 0;
  return text.replaceAll("sha512-…", () => DIGESTS[index++ % DIGESTS.length] ?? "");
}

/** The canonical example as `serializeManifest` writes it: keys sorted, trailing newline. */
export const GOLDEN = `{
  "engine": {
    "integrity": "${DIGESTS[0]}",
    "package": "@penvhq/cli",
    "version": "0.9.0"
  },
  "extensions": {
    "@acme/provider-consul": {
      "integrity": "${DIGESTS[2]}",
      "trust": {
        "acknowledgedAt": "2026-08-17T00:00:00Z",
        "publishedAt": "2026-07-02T09:14:00Z",
        "publisher": "acme-oss",
        "reason": "Reviewed v1.4.2 source; Consul is our KV store.",
        "tier": "third-party"
      },
      "version": "1.4.2"
    },
    "@internal/provider-secrets": {
      "integrity": "${DIGESTS[3]}",
      "registry": "https://npm.acme.internal",
      "trust": {
        "acknowledgedAt": "2026-08-17T00:00:00Z",
        "reason": "First-party adapter.",
        "tier": "private"
      },
      "version": "2.0.0"
    },
    "@penvhq/provider-vault": {
      "integrity": "${DIGESTS[1]}",
      "version": "0.9.0"
    }
  },
  "format": 1
}
`;
