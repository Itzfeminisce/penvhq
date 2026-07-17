/**
 * The OS-keychain binding, and the one place the native module is touched.
 *
 * `@penvhq/core` defines the `Keychain` contract but carries no native dependency:
 * `load` runs in every deploy, and a native module in the runtime's tree is a
 * build failure in someone's container. So the binding lives here, in the CLI —
 * whose dependency budget is looser and which never ships inside a user's app —
 * and is registered into core (see `runMain`). Where it is never registered (the
 * runtime), a keychain source answers `unavailable`, which is the honest verdict.
 *
 * The native module is required lazily, so it loads only when a keychain key is
 * actually read or written — never merely because the CLI started, and never on
 * an env-source path that has no business touching it.
 */

import { createRequire } from "node:module";
import type { Keychain } from "@penvhq/core";

/** The synchronous slice of `@napi-rs/keyring`'s `Entry` this binding uses. */
interface Entry {
  getPassword(): string | null;
  setPassword(password: string): void;
}
type EntryConstructor = new (service: string, account: string) => Entry;

let cached: EntryConstructor | undefined;

function entryConstructor(): EntryConstructor {
  if (cached === undefined) {
    const require = createRequire(import.meta.url);
    cached = (require("@napi-rs/keyring") as { Entry: EntryConstructor }).Entry;
  }
  return cached;
}

/**
 * The real binding, backed by `@napi-rs/keyring`'s synchronous `Entry`. Its
 * `getPassword` returns `null` for a missing entry (never throws for absence) and
 * throws only when the keychain genuinely cannot be read — which the core source
 * turns into `unavailable`, not `absent`.
 */
export const defaultKeychain: Keychain = {
  getPassword(service, account) {
    const Entry = entryConstructor();
    return new Entry(service, account).getPassword();
  },
  setPassword(service, account, password) {
    const Entry = entryConstructor();
    new Entry(service, account).setPassword(password);
  },
};
