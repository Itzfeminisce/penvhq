/**
 * What the codebase already says about itself.
 *
 * `penv init` asks a human to confirm a plan, and a plan the human has to fill
 * in from scratch is an interrogation. So penv reads the two facts it can
 * observe — the framework in `package.json`, and whether a `src/` directory
 * exists — and offers them as a suggestion.
 *
 * The line this module does not cross: a framework is an identity, never a
 * config key. Nothing here is written to `penv.config.ts` as `framework: "next"`
 * — the answers become concrete decisions (`schemaFile`, `publicPrefixes`) that
 * mean the same thing in a year, when the project has been rewritten twice and
 * penv would otherwise still be reinterpreting a name it read once.
 *
 * Everything here is a suggestion. The one thing that is never suggested is an
 * environment: deployment topology is not in `package.json`, and invariant 10
 * forbids inferring it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCHEMA_FILE } from "@penvhq/core";

/** A framework penv recognised, and what it implies about a project's layout. */
export interface Detected {
  /** The framework's own name, as a human writes it — `"Next.js"`. */
  readonly name: string;
  /** Where this framework's projects keep their modules, relative to the root. */
  readonly schemaFile: string;
  /**
   * The conventional path penv stepped aside from, because a module that is not
   * penv's schema already lives there. Set only when it happened, so the plan can
   * say why the schema is not where the convention would have put it.
   */
  readonly displacedFrom?: string;
  /** The prefixes this framework inlines into its client bundle. */
  readonly publicPrefixes: readonly string[];
}

/**
 * One framework's signature. `packages` is checked against dependencies and
 * devDependencies alike: a framework is a framework wherever it was installed,
 * and the two lists disagree often enough that reading one is reading half.
 */
interface Signature {
  readonly name: string;
  readonly packages: readonly string[];
  readonly publicPrefixes: readonly string[];
}

/**
 * Ordered most specific first: TanStack Start is Vite underneath and Next.js
 * projects carry Vite for their tests, so a signature that matches a framework's
 * *foundation* must never answer before the framework itself does.
 *
 * Remix and React Router 7 are deliberately absent. Their public-variable story
 * is not one prefix, and a guess here is worse than the fallback: the fallback
 * is reported and asks, while a wrong prefix silently arms the one `doctor`
 * check that exists to keep a secret out of a browser bundle.
 */
const SIGNATURES: readonly Signature[] = [
  { name: "Next.js", packages: ["next"], publicPrefixes: ["NEXT_PUBLIC_"] },
  { name: "SvelteKit", packages: ["@sveltejs/kit"], publicPrefixes: ["PUBLIC_"] },
  { name: "Nuxt", packages: ["nuxt"], publicPrefixes: ["NUXT_PUBLIC_"] },
  {
    name: "TanStack Start",
    packages: ["@tanstack/react-start", "@tanstack/start"],
    publicPrefixes: ["VITE_"],
  },
  { name: "Astro", packages: ["astro"], publicPrefixes: ["PUBLIC_"] },
  { name: "Vite", packages: ["vite"], publicPrefixes: ["VITE_"] },
];

/**
 * Whether the module at `file` looks like it exports penv's schema.
 *
 * A scan, not a parse, and deliberately conservative in one direction: it can
 * fail to recognise an exotic re-export and say "no", which costs a note and a
 * different filename. It cannot invent a `schema` that is not written down, so it
 * never claims someone else's module is penv's.
 *
 * The question this answers is not "does the file exist". `src/env.ts` existing
 * is the common case on a re-run — it is the schema penv wrote, and keeping it is
 * invariant 2 working. The question is whether the file at the path penv wants is
 * *penv's*, because the alternative is penv choosing a path already occupied by
 * someone else's module and then reporting, later and from somewhere else, that
 * it exports no schema.
 */
function exportsSchema(file: string): boolean {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return (
    // `export const schema = z.object({ ... })` — what penv scaffolds.
    /export\s+(?:const|let|var)\s+schema\b/.test(source) ||
    // `export { schema }`, `export { shape as schema }`.
    /export\s*\{[^}]*\bschema\b[^}]*\}/.test(source)
  );
}

/** True when something that is not penv's schema already lives at `relative`. */
function occupied(cwd: string, relative: string): boolean {
  const file = join(cwd, ...relative.split("/"));
  return existsSync(file) && !exportsSchema(file);
}

/**
 * Where a framework's projects keep the schema — and where penv puts it instead
 * when that address is already someone else's.
 *
 * `src/env.ts` is the convention and it is also a name projects already use for
 * their own env module. Proposing it regardless is how penv came to scaffold
 * around a file it could not use: it kept the user's module (invariant 2, right),
 * then `validate` failed with "src/env.ts exports no `schema`" — a complaint
 * about a path penv itself had chosen.
 *
 * Stepping aside is not a guess. The file being there, and not exporting a
 * schema, is a fact about the codebase — the kind penv may default from, because
 * a wrong answer is visible in the plan and writes nothing over anything.
 */
export function schemaFileFor(cwd: string): { file: string; displaced?: string } {
  const dir = srcPrefix(cwd);
  const preferred = `${dir}env.ts`;
  if (!occupied(cwd, preferred)) {
    return { file: preferred };
  }

  const beside = `${dir}penv-env.ts`;
  if (!occupied(cwd, beside)) {
    return { file: beside, displaced: preferred };
  }
  // Both names taken by modules that are not penv's. `.penv/` is penv's own
  // directory, so it is the one address no other tool has a claim on.
  return { file: DEFAULT_SCHEMA_FILE, displaced: preferred };
}

/**
 * Every dependency name the manifest declares, or `undefined` when there is no
 * manifest to read. An unreadable or malformed `package.json` answers the same
 * way an absent one does — "I cannot tell" — because init's fallback is correct
 * and reported, while a parse error thrown from a suggestion would fail a
 * command that had not yet asked the user anything.
 */
/**
 * `"src/"` when the project keeps its modules under `src/`, else `""` — the one
 * fact both the schema location and a framework's seam file key off, read in one
 * place so the two cannot disagree about whether a project uses `src/`.
 */
export function srcPrefix(cwd: string): string {
  return existsSync(join(cwd, "src")) ? "src/" : "";
}

function dependenciesOf(cwd: string): ReadonlySet<string> | undefined {
  const manifest = manifestOf(cwd);
  if (manifest === undefined) {
    return undefined;
  }

  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block: unknown = manifest[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * The project's manifest, or `undefined` when there is nothing readable to read.
 *
 * An absent or unparseable `package.json` is not an error here: detection's whole
 * contract is that it may answer "I cannot tell", and a project penv is asked to
 * scaffold before its manifest exists is a project, not a mistake.
 */
function manifestOf(cwd: string): Readonly<Record<string, unknown>> | undefined {
  const file = join(cwd, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  return manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
    ? undefined
    : (manifest as Readonly<Record<string, unknown>>);
}

/**
 * The framework this project is built with, or `undefined` when penv cannot
 * tell. `undefined` is an answer, not a failure: init falls back to the default
 * schema path and says that it did.
 */
export function detectFramework(cwd: string): Detected | undefined {
  const dependencies = dependenciesOf(cwd);
  if (dependencies === undefined) {
    return undefined;
  }
  for (const signature of SIGNATURES) {
    if (signature.packages.some((name) => dependencies.has(name))) {
      return detectedFrom(cwd, signature.name, signature.publicPrefixes);
    }
  }
  // Bun is a runtime, not a package, so no dependency names it. A framework above
  // would have answered first (a Next-on-Bun project is a Next project); only a
  // project with no framework and a `bunfig.toml` is a plain Bun one, whose seam
  // is Bun's preload rather than Node's `--import`. It has no client bundle, so no
  // public prefix.
  if (existsSync(join(cwd, "bunfig.toml")) || dependencies.has("bun-types")) {
    return detectedFrom(cwd, "Bun", []);
  }
  return undefined;
}

function detectedFrom(cwd: string, name: string, publicPrefixes: readonly string[]): Detected {
  const schema = schemaFileFor(cwd);
  return {
    name,
    schemaFile: schema.file,
    ...(schema.displaced === undefined ? {} : { displacedFrom: schema.displaced }),
    publicPrefixes,
  };
}

/** The alias penv writes when the project says nothing about how it names its own modules. */
export const DEFAULT_ALIAS = "@env";

/** The alias for a project that already speaks Node's subpath imports. */
export const IMPORTS_ALIAS = "#env";

/**
 * The alias to offer, read from how the project already refers to itself.
 *
 * The two forms are not interchangeable, and the difference is not taste:
 *
 * - `@env` is a `tsconfig.json` `paths` entry. TypeScript understands it and a
 *   bundler resolves it. Plain `node dist/index.js` does not — `paths` is erased
 *   by the compiler, so the emitted `import ... from "@env"` reaches Node as a
 *   package that is not installed.
 * - `#env` is a `package.json` `imports` entry, which Node resolves natively and
 *   every current bundler honours. It needs a modern `moduleResolution` for the
 *   types to follow, which is why it is not simply the default.
 *
 * A project carrying an `imports` block has already answered the question, so
 * that is what is offered. Anything else gets `@env`, which is what the docs
 * describe and what a framework project wants. This is a suggestion either way:
 * the human confirms it, and the answer is written down as a decision.
 */
export function detectAlias(cwd: string): string {
  return hasImportsBlock(cwd) ? IMPORTS_ALIAS : DEFAULT_ALIAS;
}

function hasImportsBlock(cwd: string): boolean {
  const manifest = manifestOf(cwd);
  const imports = manifest?.imports;
  return imports !== null && typeof imports === "object" && !Array.isArray(imports);
}
