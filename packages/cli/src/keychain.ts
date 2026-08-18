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
 * an env-source path that has no business touching it. That laziness is load
 * bearing twice over: an engine installed from an npm tarball into `$PENV_HOME`
 * has no `node_modules`, so the binding is genuinely absent there, and every
 * command that is not a keychain command must still work.
 */

import { createRequire } from "node:module";
import { type Keychain, PenvError } from "@penvhq/core";

/** The native package this binding is. Named in the refusal, so it is a constant. */
export const KEYRING_MODULE = "@napi-rs/keyring";

/** The synchronous slice of `@napi-rs/keyring`'s `Entry` this binding uses. */
interface Entry {
  getPassword(): string | null;
  setPassword(password: string): void;
}
type EntryConstructor = new (service: string, account: string) => Entry;

/** How the native module is reached. Injected in tests; nothing else replaces it. */
export type NativeLoader = (id: string) => unknown;

const nodeRequire: NativeLoader = (id) => createRequire(import.meta.url)(id);

/** Node appends a require stack to a resolution failure; the sentence is the useful part. */
function firstLine(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "";
}

/**
 * The binding is missing, which is neither "the keychain is locked" nor "there is
 * no such key" — it is penv having no way to ask at all, and it has one cause.
 */
function keyringMissing(cause: unknown): PenvError {
  return new PenvError(
    "KEYCHAIN_BINDING_MISSING",
    `penv could not load ${KEYRING_MODULE}, the native binding it reads your OS keychain through`,
    `This penv engine was installed as a plain tarball, which carries no native modules. ` +
      `Install penv with \`npm install -g @penvhq/launcher\`, or declare \`source: "env"\` for ` +
      `this environment and export its key. Original error: ${firstLine(cause)}`,
  );
}

/**
 * The real binding, backed by `@napi-rs/keyring`'s synchronous `Entry`. Its
 * `getPassword` returns `null` for a missing entry (never throws for absence) and
 * throws only when the keychain genuinely cannot be read — which the core source
 * turns into `unavailable`, not `absent`.
 */
export function createKeychain(load: NativeLoader = nodeRequire): Keychain {
  let cached: EntryConstructor | undefined;

  const entryConstructor = (): EntryConstructor => {
    if (cached === undefined) {
      let module: { Entry: EntryConstructor };
      try {
        module = load(KEYRING_MODULE) as { Entry: EntryConstructor };
      } catch (cause) {
        throw keyringMissing(cause);
      }
      cached = module.Entry;
    }
    return cached;
  };

  return {
    getPassword(service, account) {
      const Entry = entryConstructor();
      return new Entry(service, account).getPassword();
    },
    setPassword(service, account, password) {
      const Entry = entryConstructor();
      new Entry(service, account).setPassword(password);
    },
  };
}

export const defaultKeychain: Keychain = createKeychain();
