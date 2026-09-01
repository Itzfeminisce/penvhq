/**
 * The dotenv files a project's framework reads, and what each one says.
 *
 * One module answers this for both ends of adoption: `penv init` offers these
 * files for the cutover, and `penv run` refuses the ones that come back
 * afterwards. Two readings of "which files are active" would eventually let init
 * move a file run does not watch, or run refuse a file init never offered.
 *
 * The four scopes are invariant 4's, which are Next.js's and Vite's:
 * `.env` > `.env.local` > `.env.<environment>` > `.env.<environment>.local`.
 * Anything else with an `.env` prefix is documentation (`.env.example`), a
 * leftover (`.env.backup`), or a filename penv has no reading of — none of them
 * is configuration a framework loads, so none is offered or refused.
 *
 * Reading an environment out of a filename here is not inference: nothing
 * reaches `penv.config.ts` until a human selects the file, and
 * {@link activeDotenvFiles} judges the segment against the declared whitelist
 * (invariant 10) rather than believing it.
 */

import { readdirSync } from "node:fs";
import type { PenvConfig } from "@penvhq/core";
import { environmentNames, isLegalEnvironmentName, RESERVED_TOKENS } from "@penvhq/core";

/** The prefix every dotenv filename carries, and the bare shared-default name. */
const SHARED = ".env";
const LOCAL = "local";

/**
 * Segments that look like an environment but are documentation (`.env.example`),
 * a copy (`.env.backup`, which `penv import` itself writes), or one of the
 * grammar's reserved scope markers. A file named for one of these is never
 * offered: it declares nothing, and adopting it would put a name in the
 * whitelist no value file can be scoped to.
 */
const NOT_ENVIRONMENTS: readonly string[] = [
  ...RESERVED_TOKENS,
  "example",
  "sample",
  "template",
  "backup",
];

/** Where a dotenv file sits in the cascade. */
export type DotenvKind = "shared" | "local" | "environment" | "environment-local";

export interface DotenvFile {
  /** The filename exactly as it is on disk — what undo restores. */
  readonly name: string;
  readonly kind: DotenvKind;
  /** The environment the filename names, for the two environment-scoped kinds. */
  readonly environment?: string;
  /** How the file is described in the selection table. */
  readonly label: string;
}

function classify(name: string): DotenvFile | undefined {
  if (name === SHARED) {
    return { name, kind: "shared", label: "shared default" };
  }
  if (!name.startsWith(`${SHARED}.`)) {
    return undefined;
  }
  const segments = name.slice(SHARED.length + 1).split(".");
  const [first, second] = segments;
  if (first === undefined || first.length === 0) {
    return undefined;
  }
  if (segments.length === 1) {
    if (first === LOCAL) {
      return { name, kind: "local", label: "local override" };
    }
    return environmentFile(name, first, "environment");
  }
  if (segments.length === 2 && second === LOCAL) {
    return environmentFile(name, first, "environment-local");
  }
  // Three or more segments, or `.env.local.production` — no scope penv reads.
  return undefined;
}

function environmentFile(
  name: string,
  environment: string,
  kind: "environment" | "environment-local",
): DotenvFile | undefined {
  if (!isLegalEnvironmentName(environment) || NOT_ENVIRONMENTS.includes(environment)) {
    return undefined;
  }
  return {
    name,
    kind,
    environment,
    label: kind === "environment" ? environment : `${environment}-local`,
  };
}

/** Shared, then local, then each environment's pair, alphabetically — the same list everywhere. */
function order(file: DotenvFile): string {
  switch (file.kind) {
    case "shared":
      return "0";
    case "local":
      return "1";
    case "environment":
      return `2${file.environment}0`;
    default:
      return `2${file.environment}1`;
  }
}

/**
 * Every dotenv file at the project root that carries one of the four scopes,
 * in display order. A directory named `.env.something` is not a file a framework
 * reads, so `withFileTypes` keeps it out.
 */
export function discoverDotenvFiles(root: string): DotenvFile[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const files: DotenvFile[] = [];
  for (const entry of entries) {
    const file = classify(entry);
    if (file !== undefined) {
      files.push(file);
    }
  }
  return files.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/**
 * The files this project's framework would actually load: the two unscoped ones,
 * and the environment-scoped ones whose environment the config declares.
 *
 * A `.env.staging` in a project that never declared `staging` is not active — no
 * framework loads it, and reading it as one would be penv inferring the
 * environment invariant 10 forbids it from inferring.
 */
export function activeDotenvFiles(root: string, config: PenvConfig): DotenvFile[] {
  const declared = environmentNames(config);
  return discoverDotenvFiles(root).filter(
    (file) => file.environment === undefined || declared.includes(file.environment),
  );
}

/** The environments a set of selected files declares. `.env` alone declares none. */
export function environmentsDeclaredBy(files: readonly DotenvFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (file.environment !== undefined) {
      names.add(file.environment);
    }
  }
  return [...names].sort();
}

/** The cascade `environment` reads, most general first — invariant 4's four levels. */
export function cascadeFor(environment: string): string[] {
  return [
    SHARED,
    `${SHARED}.${LOCAL}`,
    `${SHARED}.${environment}`,
    `${SHARED}.${environment}.${LOCAL}`,
  ];
}
