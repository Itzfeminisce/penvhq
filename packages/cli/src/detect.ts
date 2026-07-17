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

/** A framework penv recognised, and what it implies about a project's layout. */
export interface Detected {
  /** The framework's own name, as a human writes it — `"Next.js"`. */
  readonly name: string;
  /** Where this framework's projects keep their modules, relative to the root. */
  readonly schemaFile: string;
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
  {
    name: "TanStack Start",
    packages: ["@tanstack/react-start", "@tanstack/start"],
    publicPrefixes: ["VITE_"],
  },
  { name: "Astro", packages: ["astro"], publicPrefixes: ["PUBLIC_"] },
  { name: "Vite", packages: ["vite"], publicPrefixes: ["VITE_"] },
];

/** The schema module's suggested home, at the root unless `src/` is really there. */
function schemaFileFor(cwd: string): string {
  return existsSync(join(cwd, "src")) ? "src/env.ts" : "env.ts";
}

/**
 * Every dependency name the manifest declares, or `undefined` when there is no
 * manifest to read. An unreadable or malformed `package.json` answers the same
 * way an absent one does — "I cannot tell" — because init's fallback is correct
 * and reported, while a parse error thrown from a suggestion would fail a
 * command that had not yet asked the user anything.
 */
function dependenciesOf(cwd: string): ReadonlySet<string> | undefined {
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
  if (manifest === null || typeof manifest !== "object") {
    return undefined;
  }

  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block: unknown = (manifest as Readonly<Record<string, unknown>>)[field];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
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
      return {
        name: signature.name,
        schemaFile: schemaFileFor(cwd),
        publicPrefixes: signature.publicPrefixes,
      };
    }
  }
  return undefined;
}
