/**
 * The filename grammar. Filenames are split on `.`, so this module is the only
 * place that decides what a dot segment means.
 *
 * A dot segment is an environment only if `config.environments` declares it —
 * never inferred from the folder or the filename.
 */

import {
  FilenameGrammarError,
  IllegalEnvironmentNameError,
  PenvError,
  ReservedTokenError,
  UnknownEnvironmentError,
} from "./errors.js";
import { schemaInsideTree } from "./schema-file.js";
import type {
  MetaFileRef,
  MetaFormat,
  ParameterRef,
  ParsedFile,
  PenvConfig,
  Scope,
  ValueFile,
} from "./types.js";
import { assertNever, META_FORMATS, RESERVED_TOKENS } from "./types.js";

/** A segment penv can plausibly read as an environment name, for the better error. */
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

const ENC = "enc";
const LOCAL = "local";

/** The only meta format penv parses. `.toml`/`.yml` are reserved, not implemented. */
const SUPPORTED_META_FORMAT: MetaFormat = "json";

/**
 * Every token that cannot be a parameter name: the static tokens plus every
 * declared environment name. Environments are config-driven (invariant 10), so
 * what is reserved is config-driven too — `production` is only reserved when
 * `penv.config.ts` declares it.
 */
export function reservedTokensFor(config: PenvConfig): string[] {
  return [...new Set<string>([...RESERVED_TOKENS, ...config.environments])];
}

/**
 * True when `token` cannot be used as a parameter name under `config`.
 *
 * This reserves an environment name as a *parameter name* only. The scope
 * segment of `<name>.production` is unaffected — that is the environment doing
 * its job, not a collision.
 */
export function isReservedToken(token: string, config: PenvConfig): boolean {
  return reservedTokensFor(config).includes(token);
}

function isMetaFormat(segment: string): segment is MetaFormat {
  return (META_FORMATS as readonly string[]).includes(segment);
}

function refPath(ref: ParameterRef): string {
  return [...ref.namespace, ref.name].join("/");
}

export function parameterId(ref: ParameterRef): string {
  return [...ref.namespace, ref.name].join(".");
}

export function formatValueFile(file: ValueFile): string {
  let out = refPath(file);
  switch (file.scope.kind) {
    case "environment":
      out += `.${file.scope.environment}`;
      break;
    case "local":
      out += `.${LOCAL}`;
      break;
    case "environment-local":
      // The environment precedes `local`, mirroring `.env.[mode].local`.
      out += `.${file.scope.environment}.${LOCAL}`;
      break;
    case "unscoped":
      break;
    default:
      assertNever(file.scope, "scope");
  }
  if (file.encrypted) {
    out += `.${ENC}`;
  }
  return out;
}

export function formatMetaFile(ref: MetaFileRef): string {
  return `${refPath(ref)}.${ref.format}`;
}

function declaredList(config: PenvConfig): string {
  if (config.environments.length === 0) {
    return "no environments are declared in penv.config.ts";
  }
  return `declared environments are ${config.environments.map((e) => `\`${e}\``).join(", ")}`;
}

/**
 * Resolves one dot segment to a declared environment. A segment is an
 * environment only because `config.environments` declares it (invariant 10), so
 * an undeclared segment is an error at every scope position — including the one
 * before `local`.
 */
function asEnvironment(segment: string, relativePath: string, config: PenvConfig): string {
  if (config.environments.includes(segment)) {
    return segment;
  }
  if (BARE_WORD.test(segment)) {
    throw new UnknownEnvironmentError(segment, config.environments);
  }
  throw new FilenameGrammarError(
    relativePath,
    `\`${segment}\` is not an environment, \`local\`, \`enc\`, or a meta format`,
    `A dot segment must be one of those — ${declaredList(config)}. Rename the file.`,
  );
}

/**
 * Reads the scope segments that sit between the name and the terminal `.enc`.
 *
 * `<env>.local` is the only two-segment scope, and the order is fixed: the
 * environment always precedes `local`, mirroring `.env.[mode].local`. The
 * reverse spelling is an error, never a synonym — accepting both would make one
 * cascade level addressable by two names.
 */
function parseScope(
  rest: readonly string[],
  ref: ParameterRef,
  encrypted: boolean,
  relativePath: string,
  config: PenvConfig,
): Scope {
  const tooManyScopeSegments = (): FilenameGrammarError =>
    new FilenameGrammarError(
      relativePath,
      `\`${rest.join("` and `")}\` are ${rest.length} scope segments`,
      "A value file carries exactly one scope: `<name>`, `<name>.<env>`, `<name>.local`, or " +
        "`<name>.<env>.local`. Write one file per environment.",
    );

  if (rest.length > 2) {
    throw tooManyScopeSegments();
  }

  const first = rest[0];
  const second = rest[1];

  if (first === undefined) {
    return { kind: "unscoped" };
  }

  if (second === undefined) {
    if (first === LOCAL) {
      return { kind: LOCAL };
    }
    return { kind: "environment", environment: asEnvironment(first, relativePath, config) };
  }

  if (second === LOCAL) {
    if (first === LOCAL) {
      throw tooManyScopeSegments();
    }
    return { kind: "environment-local", environment: asEnvironment(first, relativePath, config) };
  }

  if (first === LOCAL) {
    // Validate before complaining about order: an ordering error asserts `second`
    // IS the environment, which is only true once it is declared (invariant 10).
    // An undeclared segment is diagnosed here exactly as the mirror order
    // diagnoses it, and the rename below can only name a filename penv accepts.
    const environment = asEnvironment(second, relativePath, config);
    const corrected = formatValueFile({
      ...ref,
      scope: { kind: "environment-local", environment },
      encrypted,
    });
    throw new FilenameGrammarError(
      relativePath,
      "`local` precedes the environment segment",
      `The environment segment always precedes \`local\` — \`<name>.<env>.local\` mirrors ` +
        `\`.env.[mode].local\` — so \`${refPath(ref)}.${LOCAL}.${second}\` is an error, not a ` +
        `synonym. Rename it to \`${corrected}\`.`,
    );
  }

  throw tooManyScopeSegments();
}

/**
 * True when `relativePath` is a file penv should hand to {@link parseFilename}.
 *
 * The tree holds files penv never wrote — `.DS_Store`, `.gitignore`, editor
 * swap files — and, when the project leaves it there, the schema, which is a
 * TypeScript module and not a parameter. Those are ignored rather than rejected:
 * a stray dotfile is not a user error, and `list`/`load` must not fail on one.
 * Anything this returns true for is held to the grammar in full.
 *
 * The schema is excluded by where the config says it lives, not by its name. A
 * project whose schema sits in `src/` has nothing here to skip — which is the
 * quiet argument for moving it out: the exclusion stops being needed rather than
 * being configured.
 */
export function isParameterFile(relativePath: string, config: PenvConfig): boolean {
  const posix = relativePath.replace(/\\/g, "/");
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  const basename = segments[segments.length - 1];
  if (basename === undefined) {
    return false;
  }
  if (basename.startsWith(".")) {
    return false;
  }
  return segments.join("/") !== schemaInsideTree(config);
}

export function parseFilename(relativePath: string, config: PenvConfig): ParsedFile {
  const posix = relativePath.replace(/\\/g, "/");
  const pathSegments = posix.split("/").filter((s) => s.length > 0 && s !== ".");

  const filename = pathSegments[pathSegments.length - 1];
  if (filename === undefined) {
    throw new FilenameGrammarError(
      relativePath,
      "it names no parameter",
      "A value file is `<namespace>/<name>`, e.g. `redis/password`.",
    );
  }
  const namespace = pathSegments.slice(0, -1);
  for (const segment of namespace) {
    if (segment === "..") {
      throw new FilenameGrammarError(
        relativePath,
        "`..` is not a namespace",
        "Namespaces are plain folders below `.penv/`, e.g. `redis/password`. Remove the `..` segment.",
      );
    }
  }

  const segments = filename.split(".");
  if (segments.some((s) => s.length === 0)) {
    throw new FilenameGrammarError(
      relativePath,
      "it has an empty `.` segment",
      "Filenames are split on `.`, so every segment must be non-empty, e.g. `redis/password.production`.",
    );
  }

  const name = segments[0];
  if (name === undefined) {
    throw new FilenameGrammarError(
      relativePath,
      "it names no parameter",
      "A value file is `<namespace>/<name>`, e.g. `redis/password`.",
    );
  }
  if (isReservedToken(name, config)) {
    throw new ReservedTokenError("parameter", name, relativePath);
  }

  const ref: ParameterRef = { namespace, name };

  let rest = segments.slice(1);
  let encrypted = false;
  if (rest[rest.length - 1] === ENC) {
    encrypted = true;
    rest = rest.slice(0, -1);
  }
  if (rest.includes(ENC)) {
    const suggestion = [...rest.filter((s) => s !== ENC), ENC];
    throw new FilenameGrammarError(
      relativePath,
      "`.enc` is not the terminal segment",
      "`.enc` is always last and the scope always precedes it, so `<name>.enc.<env>` is an error, " +
        `not a synonym. Rename it to \`${[refPath(ref), ...suggestion].join(".")}\`.`,
    );
  }

  const metaSegment = rest.find(isMetaFormat);
  if (metaSegment !== undefined) {
    const meta: ParsedFile = { kind: "meta", namespace, name, format: metaSegment };
    if (encrypted) {
      throw new FilenameGrammarError(
        relativePath,
        "a meta file cannot be encrypted",
        `Meta is always plaintext — it holds policy, never a value. Rename it to \`${formatMetaFile(meta)}\`.`,
      );
    }
    if (rest.length !== 1) {
      throw new FilenameGrammarError(
        relativePath,
        `\`${metaSegment}\` is a meta format, so it must be the only dot segment`,
        "One meta file carries policy for every environment; per-environment policy goes in its " +
          `\`environments\` block. Rename it to \`${formatMetaFile(meta)}\`.`,
      );
    }
    if (metaSegment !== SUPPORTED_META_FORMAT) {
      // The grammar reserves `.toml`/`.yml` from day one, but nothing parses
      // them in this release. Reserving without implementing must be loud: a
      // policy file penv silently ignored would be worse than no file at all.
      throw new PenvError(
        "META_FORMAT_UNSUPPORTED",
        `Meta file ${relativePath} is \`${metaSegment}\`, which penv cannot read`,
        `\`.${metaSegment}\` meta is reserved by the filename grammar but not parsed in this ` +
          `release — leaving it in place would apply no policy. Convert it to JSON and rename ` +
          `it to \`${formatMetaFile({ ...meta, format: SUPPORTED_META_FORMAT })}\`.`,
      );
    }
    return meta;
  }

  const scope = parseScope(rest, ref, encrypted, relativePath, config);

  return { kind: "value", namespace, name, scope, encrypted };
}

/**
 * The names a dot segment can be. An environment name becomes a filename segment
 * verbatim, and filenames are split on `.`, so a name carrying one would be read
 * back as two segments that mean something else — or, when it starts with a dot,
 * as an empty segment the grammar refuses outright.
 */
const ENVIRONMENT_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * True when `name` can survive a round trip through a filename.
 *
 * Whitelist membership is necessary and not sufficient: it says a name was
 * *declared*, not that it can be *written*. `.env.development.local` is a name a
 * user can genuinely reach for — it is what their file is called — and declaring
 * it produced `api-key..env.development.local`, which the grammar then refuses to
 * read. Every later `list`/`get`/`generate`/`validate` on that tree threw, and
 * the only repair was deleting the file by hand.
 */
export function isLegalEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

/**
 * Bad names in `environments`. Collected rather than thrown so `penv validate`
 * reports every one in one pass.
 */
export function validateEnvironmentNames(config: PenvConfig): PenvError[] {
  const errors: PenvError[] = [];
  for (const environment of config.environments) {
    // Deliberately the static tokens, not `isReservedToken` — that reserves the
    // declared environments too, so every name here would collide with itself.
    if ((RESERVED_TOKENS as readonly string[]).includes(environment)) {
      errors.push(new ReservedTokenError("environment", environment, "penv.config.ts"));
      continue;
    }
    if (typeof environment === "string" && !isLegalEnvironmentName(environment)) {
      errors.push(new IllegalEnvironmentNameError(environment));
    }
  }
  return errors;
}
