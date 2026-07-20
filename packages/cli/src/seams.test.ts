/**
 * The injection seams, one assertion per shape: a framework with a clean pre-app
 * file gets a scaffold carrying the guarded/ordered import and an explaining
 * comment; a framework with no file penv can own gets a printed instruction; a
 * pure client SPA is told injection does not apply; and the alias the seam
 * carries is the project's own.
 */

import { describe, expect, it } from "vitest";
import { type Seam, seamFor } from "./seams.js";

const CTX = { alias: "@env", srcDir: "" };

function scaffold(seam: Seam) {
  if (seam.kind !== "scaffold") throw new Error(`expected a scaffold seam, got ${seam.kind}`);
  return seam;
}

describe("seamFor", () => {
  it("Next.js: a guarded register() in instrumentation.ts, src-aware", () => {
    const seam = scaffold(seamFor("Next.js", CTX));
    expect(seam.file).toBe("instrumentation.ts");
    // The Edge guard is mandatory — Next calls register on Edge, where penv can't read the fs.
    expect(seam.content).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(seam.content).toContain('await import("@env")');
    // The comment explains the file, not just penv's line.
    expect(seam.content).toContain("Next.js's own startup hook");

    // src/ layout moves the file, as Next requires.
    expect(scaffold(seamFor("Next.js", { alias: "@env", srcDir: "src/" })).file).toBe(
      "src/instrumentation.ts",
    );
  });

  it("SvelteKit: import as the first line of hooks.server.ts, with the kit.alias note", () => {
    const seam = scaffold(seamFor("SvelteKit", CTX));
    expect(seam.file).toBe("src/hooks.server.ts");
    expect(seam.content).toContain('import "@env";');
    expect(seam.notes.join(" ")).toContain("kit.alias");
  });

  it("Nuxt: a first-sorting Nitro plugin", () => {
    const seam = scaffold(seamFor("Nuxt", CTX));
    expect(seam.file).toBe("server/plugins/0.penv.ts");
    expect(seam.content).toContain("defineNitroPlugin");
    expect(seam.content).toContain('import "@env";');
  });

  it("Bun: a preload file, with the bunfig registration as a note", () => {
    const seam = scaffold(seamFor("Bun", CTX));
    expect(seam.file).toBe(".penv/preload.ts");
    expect(seam.notes.join(" ")).toContain("bunfig.toml");
  });

  it("carries the project's own alias into the scaffold", () => {
    expect(scaffold(seamFor("SvelteKit", { alias: "#env", srcDir: "" })).content).toContain(
      'import "#env";',
    );
  });

  it("TanStack Start: printed, because its server entry is version-shaped", () => {
    const seam = seamFor("TanStack Start", CTX);
    expect(seam.kind).toBe("instruct");
    if (seam.kind === "instruct") expect(seam.instruction).toContain("server.ts");
  });

  it("Astro: printed, because it has no universal pre-app hook", () => {
    const seam = seamFor("Astro", CTX);
    expect(seam.kind).toBe("instruct");
    if (seam.kind === "instruct") expect(seam.instruction).toContain("astro.config");
  });

  it("an unknown or absent framework falls back to the universal Node instruction", () => {
    for (const framework of [undefined, "Express", "Something New"]) {
      const seam = seamFor(framework, CTX);
      expect(seam.kind).toBe("instruct");
      if (seam.kind === "instruct") expect(seam.instruction).toContain("--import");
    }
  });

  it("Node: steers a tsconfig @env project to a runtime-resolvable path", () => {
    // `@env` (tsconfig paths) does not resolve at raw-Node runtime — the instruction
    // must point at the built module or #env instead.
    const atEnv = seamFor(undefined, { alias: "@env", srcDir: "" });
    if (atEnv.kind === "instruct") expect(atEnv.instruction).toContain(".penv/env.js");

    const hashEnv = seamFor(undefined, { alias: "#env", srcDir: "" });
    if (hashEnv.kind === "instruct") expect(hashEnv.instruction).toContain('"#env"');
  });

  it("Vite SPA: injection does not apply — no server reads process.env", () => {
    const seam = seamFor("Vite", CTX);
    expect(seam.kind).toBe("none");
    if (seam.kind === "none") expect(seam.reason).toContain("import.meta.env");
  });
});
