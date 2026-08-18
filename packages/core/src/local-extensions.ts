/**
 * The extensions a project develops rather than pins.
 *
 * `penv add` records a reviewed release: an exact version and the integrity of
 * the bytes, so every machine and every pipeline gets the adapter that was
 * reviewed. A package the project is *writing* has neither — there is no release
 * to pin and no published bytes to hash — and the manifest's whole promise is
 * that pin, so a local extension cannot live there.
 *
 * What is recordable is the fact itself: this name is resolved from the
 * project's own `node_modules`, and penv was told so once, deliberately. Names
 * only, and committed, so a repository that dogfoods its own provider says so in
 * a file a reviewer can see rather than in one developer's shell.
 */

import { PenvError } from "./errors.js";
import { LOCAL_EXTENSIONS_PATH } from "./layout.js";

function invalid(problem: string): PenvError {
  return new PenvError(
    "LOCAL_EXTENSIONS_INVALID",
    `${LOCAL_EXTENSIONS_PATH} does not hold the list penv writes: ${problem}`,
    "It is a JSON array of package names. Delete it and run `penv add --local <package>` for " +
      "each extension this project develops.",
  );
}

/** The recorded names, deduped and sorted — the order the file is written in. */
export function parseLocalExtensions(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("it is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw invalid("its root is not an array");
  }
  for (const name of parsed) {
    if (typeof name !== "string" || name.trim() === "") {
      throw invalid("it holds something that is not a package name");
    }
  }
  return normalize(parsed as string[]);
}

export function serializeLocalExtensions(names: readonly string[]): string {
  return `${JSON.stringify(normalize(names), null, 2)}\n`;
}

function normalize(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()))].sort();
}
