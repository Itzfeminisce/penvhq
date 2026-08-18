/**
 * The published identity of the engine that ships with this launcher.
 *
 * A manifest pins bytes, and bytes are named by the SSRI npm recorded for the
 * tarball — which nothing can compute from an installed directory, and which
 * `init` may not go and ask for, because adoption is offline. So the launcher
 * carries the answer: the release pipeline publishes `@penvhq/cli`, reads that
 * integrity from the registry, writes it here, and only then publishes `penv`.
 * The pin and the engine beside it describe one release or the launcher refuses
 * to use either.
 *
 * The value checked into this repository is a placeholder that no registry could
 * ever serve, and {@link assertReleasePin} is the gate that keeps it out of a
 * published launcher and out of anyone's project.
 */

import { ENGINE_PACKAGE, type ManifestEngine } from "@penvhq/core";
import { EnginePinMismatchError, EnginePinUnreleasedError } from "./errors.js";

/** Deliberately not an SSRI: nothing can install, or verify, what it names. */
export const DEV_PIN_INTEGRITY = "sha512-development-build-not-a-published-release";

/** The version that goes with it, equally unpublishable. */
export const DEV_PIN_VERSION = "0.0.0-dev";

/** Rewritten by the release step, after `@penvhq/cli` is on the registry. */
export const BUNDLED_ENGINE_PIN: ManifestEngine = {
  package: ENGINE_PACKAGE,
  version: DEV_PIN_VERSION,
  integrity: DEV_PIN_INTEGRITY,
};

/** The release gate: a launcher built from source has nothing to pin. */
export function assertReleasePin(pin: ManifestEngine): void {
  if (pin.integrity === DEV_PIN_INTEGRITY || pin.version === DEV_PIN_VERSION) {
    throw new EnginePinUnreleasedError();
  }
}

/** The pin for the engine that just ran, or the refusal that says there is none. */
export function releaseEnginePin(pin: ManifestEngine, ranVersion: string): ManifestEngine {
  assertReleasePin(pin);
  if (pin.version !== ranVersion) {
    throw new EnginePinMismatchError(pin.version, ranVersion);
  }
  return pin;
}
