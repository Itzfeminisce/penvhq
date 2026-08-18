/**
 * The manifest type is the schema's, inferred — never a second declaration.
 *
 * A hand-written interface beside a validator is the drift penv exists to remove,
 * and it would fail here first: if `parseManifest` ever returned something other
 * than what the schema infers, these assertions break before a caller does.
 */

import { describe, expectTypeOf, it } from "vitest";
import type { Manifest, ManifestEngine, ManifestExtension, ManifestTrust } from "./manifest.js";
import { parseManifest, serializeManifest } from "./manifest.js";

describe("the manifest type", () => {
  it("is what parseManifest returns", () => {
    expectTypeOf(parseManifest("")).toEqualTypeOf<Manifest>();
    expectTypeOf(parseManifest("")).not.toBeAny();
  });

  it("pins the format and the engine package to their literals", () => {
    expectTypeOf<Manifest["format"]>().toEqualTypeOf<1>();
    expectTypeOf<Manifest["engine"]>().toEqualTypeOf<ManifestEngine>();
    expectTypeOf<ManifestEngine["package"]>().toEqualTypeOf<"@penvhq/cli">();
  });

  it("keys extensions by package name", () => {
    expectTypeOf<Manifest["extensions"]>().toEqualTypeOf<Record<string, ManifestExtension>>();
    expectTypeOf<ManifestExtension["trust"]>().toEqualTypeOf<ManifestTrust | undefined>();
    expectTypeOf<ManifestExtension["registry"]>().toEqualTypeOf<string | undefined>();
  });

  it("discriminates the trust tiers", () => {
    expectTypeOf<
      Extract<ManifestTrust, { tier: "third-party" }>["publisher"]
    >().toEqualTypeOf<string>();
    // @ts-expect-error a private trust block records no publisher.
    expectTypeOf<Extract<ManifestTrust, { tier: "private" }>["publisher"]>();
  });

  it("serializes exactly what parsing produced", () => {
    expectTypeOf(serializeManifest).parameter(0).toEqualTypeOf<Manifest>();
    expectTypeOf(serializeManifest).returns.toEqualTypeOf<string>();
  });
});
