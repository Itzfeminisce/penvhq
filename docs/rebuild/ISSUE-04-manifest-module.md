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

1. **Sorted means sorted everywhere.** `serializeManifest` orders every key alphabetically, top
   level included, so the committed file reads `engine`, `extensions`, `format`. The example above
   is a display of the shape, not of the byte order — its extensions are not in any order either —
   and a clean diff is the property the decision was made for.
2. **The canonical example lives in `manifest.fixtures.ts` as a string, not as a `.json` file.**
   Biome formats JSON in this repo and would rewrite the one-line `trust` block, so a verbatim
   `.json` fixture cannot pass `pnpm lint`. A test extracts the JSON block from this issue file and
   asserts the fixture still matches it character for character.
3. **The `sha512-…` placeholders are not integrity strings**, so they double as the bad-integrity
   negative case; the parsing tests substitute real digests through `withDigests()`.
4. **The format gate splits two failures.** A positive integer other than 1 is
   `UnsupportedManifestFormatError` — updating penv fixes it. A missing, non-integer or non-positive
   `format` is `MANIFEST_FORMAT_INVALID`, because no launcher update fixes a file that never said
   what it is.
5. **The unsupported-format copy is `UnsupportedManifestFormatError.withLauncherUpdate({ updateCommand, invokedCommand })`.**
   Thrown from here the remedy is "Update penv, then run the command again"; the launcher catches it
   and re-throws with its own install command and the command the user typed. Neither form names
   launcher, engine or runtime — friction review item 4.
6. **One refusal per parse**, the first issue in document order, because each error carries exactly
   one remedy and a wall of them has none.
7. **`extensions` is required and written `{}` when empty.** A defaulted key would mean the object
   penv parsed and the file it committed disagree about what is there.
8. **`reason` is required for both trust tiers**; `publisher` and `publishedAt` are required for
   `third-party` and refused on `private` by the closed shape.
9. **`registry` is allowed on any entry, official scope included** — an internal mirror is a
   legitimate source — and refused when it names npmjs, is not https, or carries credentials.
10. **Timestamps are ISO-8601 UTC with a `Z`** (real calendar dates, no local offsets). Nothing here
    checks them against a clock: a pure module does not decide what "now" is, and the seven-day age
    gate belongs to `penv add`.
11. **`serializeManifest` validates on the way out too**, so the command meant to keep the manifest
    correct cannot commit one penv would refuse to read.
12. **The forbidden-content scan runs before the shape check** and skips only `integrity` values,
    which are base64 and structurally pinned by their own rule. A secret reaching git history is not
    undone by a later edit, so it is checked before anything else can pass or fail.
13. **The manifest's errors live in `manifest.ts`**, as `crypto.ts` keeps its own — `errors.ts` holds
    the vocabulary shared across modules.
