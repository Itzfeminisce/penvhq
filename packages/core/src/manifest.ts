/**
 * `.penv/state/manifest.json` — the committed launcher contract, format 1.
 *
 * The manifest answers exactly one question: which bytes is this project's penv?
 * It pins the engine and every extension by exact version and npm integrity, and
 * records, for anything outside the official scope, who decided to trust it. It
 * holds no values, no keys, no provider configuration and no machine paths — it
 * is committed, so everything in it is public to everyone with the repository.
 *
 * The shape is closed. An unknown key is a validation error rather than a field
 * penv ignores: forward compatibility is a format bump, so a manifest carrying a
 * key this engine does not know is either a typo or a file from a newer penv,
 * and both deserve to be said out loud.
 *
 * Pure by design — parse, validate, serialize. Nothing here reads the
 * filesystem, resolves `$PENV_HOME`, or talks to npm; the launcher and the CLI
 * build those on top.
 */

import { z } from "zod";
import { PenvError } from "./errors.js";

/** The manifest's path, relative to the project root. */
export const MANIFEST_PATH = ".penv/state/manifest.json";

/** The only layout this engine understands. A new key means a new format. */
export const MANIFEST_FORMAT = 1;

/** The engine package every manifest pins. */
export const ENGINE_PACKAGE = "@penvhq/cli";

/** The official scope: penv's own signed packages, trusted without a trust block. */
export const OFFICIAL_SCOPE = "@penvhq/";

/** The registry a manifest never names, because omitting `registry` means it. */
const DEFAULT_REGISTRY_HOSTS = ["registry.npmjs.org", "registry.npmjs.com", "npmjs.org"];

/** A manifest problem: one thing wrong, one thing to do about it. */
export class ManifestError extends PenvError {
  override readonly name = "ManifestError";
}

/** What the launcher knows and this module does not: how it was installed, and what was run. */
export interface LauncherUpdate {
  /** The exact command that updates this launcher, e.g. `npm i -g @penvhq/penv`. */
  readonly updateCommand: string;
  /** The command the user was running, replayed verbatim so it can be retried. */
  readonly invokedCommand: string;
}

/**
 * The manifest declares a format this engine does not implement.
 *
 * This is the one refusal where penv's three version concepts surface at all, so
 * it names none of them: the user learns that the launcher is behind and gets the
 * command that fixes it, never which of launcher, engine, or runtime is wrong.
 * The launcher retains the install method, so it catches this and re-throws it
 * through {@link UnsupportedManifestFormatError.withLauncherUpdate} with the
 * precise command filled in.
 */
export class UnsupportedManifestFormatError extends PenvError {
  override readonly name = "UnsupportedManifestFormatError";
  /** The format the file declares. */
  readonly found: number;
  /** The format this engine implements. */
  readonly supported: number = MANIFEST_FORMAT;

  constructor(found: number, update?: LauncherUpdate) {
    super(
      "MANIFEST_FORMAT_UNSUPPORTED",
      `${MANIFEST_PATH} is format ${found}, and this penv understands format ${MANIFEST_FORMAT}`,
      update === undefined
        ? "Update penv, then run the command again."
        : `Run \`${update.updateCommand}\`, then \`${update.invokedCommand}\` again.`,
    );
    this.found = found;
  }

  /** The same refusal, with the launcher's own update command and the user's command. */
  withLauncherUpdate(update: LauncherUpdate): UnsupportedManifestFormatError {
    return new UnsupportedManifestFormatError(this.found, update);
  }
}

/** semver.org's grammar, anchored: one exact version, never a range or a tag. */
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** npm's SSRI, sha512 only: 64 digest bytes are 86 base64 characters plus `==`. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** npm's package-name grammar, scoped or bare. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

type PathSegment = string | number;

function refusal(code: string, message: string, remedy: string) {
  return { code: "custom" as const, message, params: { code, remedy } };
}

function exactVersion() {
  return z.string().superRefine((value, ctx) => {
    if (!EXACT_VERSION.test(value)) {
      ctx.addIssue(
        refusal(
          "MANIFEST_VERSION_NOT_EXACT",
          `is \`${value}\`, which is a range or a tag rather than one exact version`,
          "Pin the version the install actually resolved to, e.g. `0.9.0`. A range resolves to " +
            "different bytes on different days, which is the drift the integrity hash exists to stop.",
        ),
      );
    }
  });
}

function integrity() {
  return z.string().superRefine((value, ctx) => {
    if (!INTEGRITY.test(value)) {
      ctx.addIssue(
        refusal(
          "MANIFEST_INTEGRITY",
          `is \`${value}\`, which is not an npm sha512 integrity string`,
          "Copy the `integrity` npm recorded for this exact version — it starts with `sha512-` " +
            "and is 88 base64 characters. penv refuses to install bytes it cannot check.",
        ),
      );
    }
  });
}

function registryUrl() {
  return z.string().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue(
        refusal(
          "MANIFEST_REGISTRY_INVALID",
          `is \`${value}\`, which is not a URL`,
          "Write the registry's origin, e.g. `https://npm.acme.internal`.",
        ),
      );
      return;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue(
        refusal(
          "MANIFEST_REGISTRY_NOT_HTTPS",
          `is \`${value}\`, and a registry penv downloads engines from is https`,
          "Use the registry's https URL. Over plain http the integrity pin checks bytes an " +
            "attacker on the network chose.",
        ),
      );
      return;
    }
    if (DEFAULT_REGISTRY_HOSTS.includes(url.hostname)) {
      ctx.addIssue(
        refusal(
          "MANIFEST_REGISTRY_DEFAULT",
          "names npmjs, which is where penv already looks",
          "Remove the `registry` key. It appears only when the package comes from somewhere " +
            "other than npmjs.",
        ),
      );
    }
  });
}

function nonEmptyText(code: string, problem: string, remedy: string) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue(refusal(code, problem, remedy));
    }
  });
}

const TRUST_REASON = nonEmptyText(
  "MANIFEST_TRUST_REASON",
  "is empty, and a trust block exists to record why a human trusted this package",
  "Write one line on what you checked, e.g. `Reviewed v1.4.2 source; Consul is our KV store.` " +
    "The next reviewer reads this, not the diff.",
);

const TIMESTAMP = z.iso.datetime();

const TRUST = z.discriminatedUnion("tier", [
  z.strictObject({
    tier: z.literal("third-party"),
    publisher: nonEmptyText(
      "MANIFEST_TRUST_PUBLISHER",
      "is empty, and a third-party trust block records who published the package",
      "Name the npm publisher you verified, e.g. `acme-oss`.",
    ),
    publishedAt: TIMESTAMP,
    acknowledgedAt: TIMESTAMP,
    reason: TRUST_REASON,
  }),
  z.strictObject({
    tier: z.literal("private"),
    acknowledgedAt: TIMESTAMP,
    reason: TRUST_REASON,
  }),
]);

const EXTENSION = z.strictObject({
  version: exactVersion(),
  integrity: integrity(),
  registry: registryUrl().optional(),
  trust: TRUST.optional(),
});

/**
 * Trust is a property of the scope, so it is checked here rather than per entry:
 * the package name decides whether a trust block is required or forbidden, and
 * the entry alone cannot see its own name.
 */
const EXTENSIONS = z
  .record(z.string().regex(PACKAGE_NAME), EXTENSION)
  .superRefine((entries, ctx) => {
    for (const [name, entry] of Object.entries(entries)) {
      const official = name.startsWith(OFFICIAL_SCOPE);
      if (official && entry.trust !== undefined) {
        ctx.addIssue({
          ...refusal(
            "MANIFEST_TRUST_FORBIDDEN",
            `carries a trust block, and \`${OFFICIAL_SCOPE}*\` packages come from penv's signed registry`,
            "Delete the `trust` block. Recording an acknowledgement nobody had to make teaches " +
              "the next reader that trust decisions here are ceremony.",
          ),
          path: [name, "trust"],
        });
      }
      if (!official && entry.trust === undefined) {
        ctx.addIssue({
          ...refusal(
            "MANIFEST_TRUST_REQUIRED",
            `has no trust block, and only \`${OFFICIAL_SCOPE}*\` packages are trusted without one`,
            `Run \`penv add ${name}\` and record the decision it asks for. Integrity proves which ` +
              "bytes you get, never that running them is a good idea.",
          ),
          path: [name, "trust"],
        });
      }
    }
  });

const MANIFEST = z.strictObject({
  format: z.literal(MANIFEST_FORMAT),
  engine: z.strictObject({
    package: z.literal(ENGINE_PACKAGE),
    version: exactVersion(),
    integrity: integrity(),
  }),
  extensions: EXTENSIONS,
});

export type Manifest = z.infer<typeof MANIFEST>;
export type ManifestEngine = Manifest["engine"];
export type ManifestExtension = z.infer<typeof EXTENSION>;
export type ManifestTrust = z.infer<typeof TRUST>;

/**
 * Content a committed file must never carry, wherever it hides.
 *
 * The schema already forbids every field these could belong in, so this is the
 * check for the fields that legitimately hold human text — a `reason` is the one
 * place someone can paste a Vault address or a token and have it look like prose.
 * It is a scan rather than a shape rule because the failure it prevents is a
 * secret in git history, which no later edit undoes.
 */
const FORBIDDEN: readonly {
  readonly pattern: RegExp;
  readonly code: string;
  readonly problem: string;
  readonly remedy: string;
}[] = [
  {
    pattern: /(?:^|[\s"'=(])(?:\/(?:[A-Za-z0-9._-]+\/)+|~\/|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+\\)/,
    code: "MANIFEST_ABSOLUTE_PATH",
    problem: "holds an absolute path",
    remedy:
      "Remove it. The manifest is committed and read on every machine that clones the repo, so " +
      "it names packages and versions only — never a location on one of them.",
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abopsr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|hv[sb]\.[A-Za-z0-9._-]{10,}|sk-[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|:\/\/[^/\s:@]+:[^/\s@]+@/,
    code: "MANIFEST_CREDENTIAL",
    problem: "holds something shaped like a credential",
    remedy:
      "Remove it and rotate that credential. Anything committed here is readable by everyone " +
      "with the repository, and by everyone who ever had it.",
  },
  {
    pattern:
      /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*=|\b(?:postgres|postgresql|mysql|mongodb|redis|amqps?|s3)(?:\+[a-z]+)?:\/\//,
    code: "MANIFEST_PROVIDER_CONFIG",
    problem: "holds provider configuration or a value",
    remedy:
      "Move it to penv.config.ts. The manifest records which extension is pinned and why it is " +
      "trusted, never how it is configured or what it holds.",
  },
];

/** Integrity is base64 and structurally checked; scanning it would only misfire. */
const UNSCANNED_KEY = "integrity";

function pathText(path: readonly PathSegment[]): string {
  return path
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return `[${JSON.stringify(segment)}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join("");
}

function fieldName(path: readonly PathSegment[]): string {
  return path.length === 0 ? "root" : `\`${pathText(path)}\``;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly PathSegment[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[String(segment)];
  }
  return current;
}

function scanForbidden(value: unknown, path: PathSegment[]): ManifestError | undefined {
  if (typeof value === "string") {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(value)) {
        return new ManifestError(
          rule.code,
          `${fieldName(path)} in ${MANIFEST_PATH} ${rule.problem}: \`${value}\``,
          rule.remedy,
        );
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = scanForbidden(item, [...path, index]);
      if (found) return found;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === UNSCANNED_KEY) continue;
      const found = scanForbidden(item, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * What clears the refusal, for whatever section the bad field sits in.
 *
 * An extension entry has a command that rewrites it. The engine pin has none —
 * no penv command moves it — so the remedy says what to write instead of naming
 * something that would refuse the same way when it read the same file.
 */
function sectionRemedy(path: readonly PathSegment[]): string {
  const [section, name] = path;
  if (section === "engine") {
    return (
      `Restore it with \`git checkout ${MANIFEST_PATH}\`, or write the exact version and the ` +
      `\`integrity\` npm published for that ${ENGINE_PACKAGE} release. penv runs the bytes this ` +
      "pin names, so it will not guess one."
    );
  }
  if (section === "extensions" && typeof name === "string") {
    return `Run \`penv add ${name}\` to rewrite that entry.`;
  }
  return `Restore it — format ${MANIFEST_FORMAT} requires it.`;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function customParams(issue: z.core.$ZodIssue): { code: string; remedy: string } | undefined {
  if (issue.code !== "custom") return undefined;
  const params: unknown = issue.params;
  if (!isPlainObject(params)) return undefined;
  const code = params.code;
  const remedy = params.remedy;
  if (typeof code !== "string" || typeof remedy !== "string") return undefined;
  return { code, remedy };
}

/**
 * One Zod issue becomes one penv refusal.
 *
 * Zod's own messages describe the schema ("expected string, received number");
 * penv's name the field, the file, and the single command that fixes it. Every
 * check that has a better answer than the shape carries it in `params`, so this
 * maps rather than invents.
 */
function toManifestError(issue: z.core.$ZodIssue, raw: unknown): ManifestError {
  const path = issue.path as PathSegment[];
  const custom = customParams(issue);
  if (custom) {
    return new ManifestError(
      custom.code,
      `${fieldName(path)} in ${MANIFEST_PATH} ${issue.message}`,
      custom.remedy,
    );
  }

  switch (issue.code) {
    case "unrecognized_keys": {
      const key = issue.keys[0] ?? "";
      const where = path.length === 0 ? "at its root" : `in ${fieldName(path)}`;
      return new ManifestError(
        "MANIFEST_UNKNOWN_KEY",
        `${MANIFEST_PATH} has an unknown key \`${key}\` ${where}`,
        `Remove it. Format ${MANIFEST_FORMAT} is a closed shape, so a key penv does not know is ` +
          "either a typo or a file a newer penv wrote.",
      );
    }
    case "invalid_key":
      return new ManifestError(
        "MANIFEST_PACKAGE_NAME",
        `\`${String(path[path.length - 1] ?? "")}\` in ${MANIFEST_PATH} is not an npm package name`,
        "Name the package exactly as npm does, e.g. `@acme/provider-consul`.",
      );
    case "invalid_union":
      return new ManifestError(
        "MANIFEST_TRUST_TIER",
        `${fieldName(path)} in ${MANIFEST_PATH} is \`${String(valueAt(raw, path))}\`, which is not a trust tier`,
        "Use `third-party` for a package published outside your organisation, or `private` for " +
          "one your own team publishes.",
      );
    case "invalid_value":
      return new ManifestError(
        "MANIFEST_FIELD_VALUE",
        `${fieldName(path)} in ${MANIFEST_PATH} is \`${String(valueAt(raw, path))}\`, and format ` +
          `${MANIFEST_FORMAT} requires \`${String(issue.values[0])}\``,
        sectionRemedy(path),
      );
    case "invalid_format": {
      if (issue.format !== "datetime") break;
      return new ManifestError(
        "MANIFEST_TIMESTAMP",
        `${fieldName(path)} in ${MANIFEST_PATH} is \`${String(valueAt(raw, path))}\`, which is not a UTC timestamp`,
        "Write it as ISO 8601 in UTC, e.g. `2026-08-17T00:00:00Z`.",
      );
    }
    default:
      break;
  }

  const actual = valueAt(raw, path);
  if (actual === undefined) {
    return new ManifestError(
      "MANIFEST_FIELD_MISSING",
      `${MANIFEST_PATH} is missing ${fieldName(path)}`,
      sectionRemedy(path),
    );
  }
  return new ManifestError(
    "MANIFEST_FIELD_TYPE",
    `${fieldName(path)} in ${MANIFEST_PATH} is ${describeType(actual)}, not what format ${MANIFEST_FORMAT} declares`,
    sectionRemedy(path),
  );
}

/**
 * The format gate, ahead of every other check.
 *
 * A manifest from a newer penv is not a broken manifest, and reporting it as
 * twelve unknown keys would send the reader editing a file whose only problem is
 * that this penv is old.
 */
function assertFormat(root: Record<string, unknown>): void {
  const format = root.format;
  if (typeof format === "number" && Number.isInteger(format) && format > 0) {
    if (format !== MANIFEST_FORMAT) {
      throw new UnsupportedManifestFormatError(format);
    }
    return;
  }
  const declared = format === undefined ? "no format" : `\`${String(format)}\` as its format`;
  throw new ManifestError(
    "MANIFEST_FORMAT_INVALID",
    `${MANIFEST_PATH} declares ${declared}, so penv cannot tell how to read it`,
    `Restore the key as \`"format": ${MANIFEST_FORMAT}\` — every manifest says its format first.`,
  );
}

function validateManifest(value: unknown): Manifest {
  if (!isPlainObject(value)) {
    throw new ManifestError(
      "MANIFEST_ROOT",
      `${MANIFEST_PATH} holds ${describeType(value)} at its root, not a manifest object`,
      `Restore it with \`git checkout ${MANIFEST_PATH}\` — penv writes this file, and every ` +
        "manifest is a JSON object.",
    );
  }

  assertFormat(value);

  const forbidden = scanForbidden(value, []);
  if (forbidden) {
    throw forbidden;
  }

  const result = MANIFEST.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue === undefined) {
      throw new ManifestError(
        "MANIFEST_INVALID",
        `${MANIFEST_PATH} is not a format ${MANIFEST_FORMAT} manifest`,
        `Restore it with \`git checkout ${MANIFEST_PATH}\` — penv writes this file, and it is committed.`,
      );
    }
    throw toManifestError(issue, value);
  }
  return result.data;
}

/** Parses and validates a manifest, or throws the one thing wrong with it. */
export function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ManifestError(
      "MANIFEST_PARSE",
      `${MANIFEST_PATH} is not valid JSON: ${detail}`,
      `Restore it with \`git checkout ${MANIFEST_PATH}\` — penv writes this file, so a syntax ` +
        "error in it is an edit that went wrong.",
    );
  }
  return validateManifest(parsed);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortDeep(value[key]);
  }
  return sorted;
}

/**
 * The committed form: keys sorted, two-space indent, trailing newline.
 *
 * Validated on the way out as well as in, because the alternative is a committed
 * manifest no penv can read, written by the one command that was supposed to
 * keep it correct.
 */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(sortDeep(validateManifest(manifest)), null, 2)}\n`;
}
