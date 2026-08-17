# ISSUE-04 — The manifest module (format 1)

**Branch:** `issue/04-manifest-module` · **Wave 2** (after 02 merges; independent of 03 — use the
path constant `".penv/state/manifest.json"` as a string owned by this module).

## Goal

A pure, deeply-tested core module that parses, validates and serializes `manifest.json` format 1 —
the committed launcher contract. No CLI wiring, no filesystem walking beyond read/write helpers.

## Read first

PRD §2 (Manifest and launcher), §3 (extension trust), and the sealed manifest shape below.

## Settled decisions (do not relitigate)

The npm+SSRI registry model. Canonical example — this exact shape is format 1:

```json
{
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
}
```

- The engine package is `@penvhq/cli`. Versions are exact semver — a range or dist-tag is a
  validation error. Integrity is an npm SSRI `sha512-` string.
- `@penvhq/*` scope = official tier: `trust` must be absent. Any other scope: `trust` required,
  tier `third-party` (with `publisher` + `publishedAt`) or `private`.
- `registry` appears only when not npmjs; must be an https URL.
- Unknown top-level or per-entry keys are validation errors (forward compat = format bump).
- Forbidden content, enforced structurally and by value scan: no absolute paths (POSIX or
  Windows), no credentials/tokens, no provider configuration, no value data. Reject any string
  value that looks like a filesystem path outside the schema'd fields.
- Serialization is deterministic: sorted keys, 2-space indent, trailing newline — the committed
  file must diff cleanly.

## Tasks

1. `packages/core/src/manifest.ts` (+ `manifest.test.ts`): types (inferred, Zod per repo
   convention), `parseManifest(text)`, `serializeManifest(m)`, `MANIFEST_PATH` constant
   (`.penv/state/manifest.json`).
2. Errors in docs voice, one remedy each: unsupported `format` (name the launcher-update path —
   the copy hook the launcher will fill in), bad integrity, ranged version, trust
   missing/forbidden, unknown key.
3. Tests: golden round-trip (parse→serialize is byte-identical to the canonical form), each
   negative above (fires), and each valid variant (stays quiet). A type-level test that
   `parseManifest` returns the inferred type.

## Out of scope

Reading npm, verifying tarballs, `$PENV_HOME`, CLI commands (ISSUE-05/08 build on this).

## Acceptance

`pnpm typecheck && pnpm test && pnpm lint` green; the canonical example above lives in the test
fixtures verbatim.

## Decisions log

(append here)
