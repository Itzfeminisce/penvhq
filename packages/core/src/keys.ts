/**
 * Where encryption keys come from.
 *
 * Key *acquisition* and key *use* are two different halves, and separating them
 * is what lets `load(schema)` stay synchronous while keys remain provider-backed.
 * Acquisition is async and happens before the process starts — a deploy unwraps
 * the KMS-derived data key and exports it, exactly as it already runs `penv pull`
 * to materialise the tree. Use is a synchronous pure function over bytes. penv
 * never calls a KMS in-process, which is the same knife the RFC already applied
 * to providers: a provider is a sync target, not a runtime source.
 *
 * A `KeySource` therefore answers synchronously, and answers one of three ways.
 * The tri-state is the whole point: "I was never told where to look" and "I
 * looked and there is no such key" are opposite situations with opposite
 * remedies, and collapsing them would tell a developer "no key" when the truth
 * is "unlock your keychain". A source that cannot tell says so.
 *
 * Nothing here ever falls back to a weaker source. A silent downgrade would make
 * encryption decoration rather than mechanism — the value would still be sealed,
 * but under a key penv chose because it could not find the one you named.
 */

import { ConfigError, PenvError } from "./errors.js";
import type { KeyConfig, PenvConfig } from "./types.js";

/** The one algorithm's key length. A key of any other size is not a key penv can use. */
export const KEY_BYTES = 32;

/** The env-var prefix a key is exported under. `PENV_KEY_PROD` holds key id `prod`. */
const ENV_PREFIX = "PENV_KEY_";

/**
 * The answer to "give me this key". Three kinds, never two: see the module note.
 * Mirrors the `Lookup` tri-state the schema reader uses, for the same reason.
 */
export type KeyLookup =
  | { readonly kind: "found"; readonly keyId: string; readonly key: Uint8Array }
  /** The source was consulted and holds no such key. */
  | { readonly kind: "absent"; readonly detail: string }
  /** The source could not be consulted at all, so penv genuinely cannot tell. */
  | { readonly kind: "unavailable"; readonly detail: string };

export interface KeySource {
  readonly type: string;
  /** The key a stored envelope names. */
  lookup(keyId: string): KeyLookup;
  /** The key new values are sealed under. The write path's seam. */
  current(): KeyLookup;
}

/** `prod-key` → `PENV_KEY_PROD_KEY`. Every non-alphanumeric becomes an underscore. */
function envVarFor(id: string): string {
  return ENV_PREFIX + id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/** Base64 as `Buffer` would accept it, checked before decoding rather than after. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes an exported key, or says why it is not one.
 *
 * `Buffer.from(text, "base64")` silently ignores characters outside the alphabet,
 * so a typo'd key decodes to *something* — shorter, and wrong. The length check
 * below would catch most of those, but not all: the failure mode is a key that
 * happens to decode to 32 bytes of the wrong material, which fails later as an
 * unexplained `undecipherable`. Checking the shape first makes the typo say it is
 * a typo. A short key is never padded and a long one is never truncated — either
 * would seal values under a key nobody chose.
 */
function decodeKey(text: string, variable: string): KeyLookup {
  const trimmed = text.trim();
  if (!BASE64.test(trimmed)) {
    return {
      kind: "absent",
      detail: `${variable} is not base64`,
    };
  }
  const key = new Uint8Array(Buffer.from(trimmed, "base64"));
  if (key.length !== KEY_BYTES) {
    return {
      kind: "absent",
      detail: `${variable} decodes to ${key.length} bytes, and a key is ${KEY_BYTES}`,
    };
  }
  return { kind: "found", keyId: "", key };
}

/**
 * A key held in the environment: the source a deploy uses, and the only one that
 * needs no dependency. The KMS-derived data key is unwrapped before the process
 * starts and exported here, so penv reads bytes rather than calling a service.
 */
export function createEnvKeySource(config: KeyConfig): KeySource {
  const variable = envVarFor(config.id);

  const read = (keyId: string): KeyLookup => {
    const text = process.env[variable];
    if (text === undefined || text.trim().length === 0) {
      return {
        kind: "absent",
        detail: `${variable} is not set`,
      };
    }
    const decoded = decodeKey(text, variable);
    return decoded.kind === "found" ? { ...decoded, keyId } : decoded;
  };

  return {
    type: "env",
    // An env source holds exactly one key, so a lookup for any other id is an
    // honest absence rather than this key under the wrong name: returning it
    // would decrypt a value sealed under a key penv no longer has, or claim to.
    lookup(keyId) {
      if (keyId !== config.id) {
        return {
          kind: "absent",
          detail: `${variable} holds key \`${config.id}\`, not \`${keyId}\``,
        };
      }
      return read(keyId);
    },
    current() {
      return read(config.id);
    },
  };
}

/**
 * A synchronous read of, and write to, the OS keychain.
 *
 * The contract lives here but its implementation does not: a native keychain
 * binding is a build failure in a deploy container, and `load` runs in every
 * deploy. So core carries the interface and the CLI — whose dependency budget is
 * looser, and which never ships inside a user's app — registers the binding via
 * {@link setKeychain}. Where none is registered (the runtime, in production), a
 * keychain source answers `unavailable` and a keychain-sealed value refuses to
 * open loudly, exactly as it should somewhere the keychain was never meant to be
 * read.
 */
export interface Keychain {
  /**
   * The secret stored for `(service, account)`, or `null` when the keychain is
   * reachable but holds none. Throws when the keychain cannot be consulted at all
   * — locked, or the binding missing — which the source reports as `unavailable`.
   */
  getPassword(service: string, account: string): string | null;
  /** Stores a secret for `(service, account)`, replacing any existing one. */
  setPassword(service: string, account: string, password: string): void;
}

/** The service name every penv key is stored under; the account is the key's id. */
export const KEYCHAIN_SERVICE = "penv";

let registeredKeychain: Keychain | undefined;

/**
 * Registers the OS-keychain binding. The CLI calls this at startup with a native
 * implementation; the runtime never does, so its dependency tree stays free of
 * the native module that would break a deploy build.
 */
export function setKeychain(keychain: Keychain | undefined): void {
  registeredKeychain = keychain;
}

/**
 * A key held in the OS keychain: the local-machine source, so a laptop that is
 * the master copy of production's secrets stops keeping its key in a dotfile.
 *
 * Reads through the registered (or injected) {@link Keychain} binding, never a
 * native module of its own — so it is safe to reach from the runtime, which finds
 * no binding and answers `unavailable` rather than dragging a native dependency
 * into a deployed app. Mirrors `createEnvKeySource`: one key per id, an honest
 * `absent` for any other id, and the tri-state distinction between a locked
 * keychain (`unavailable`) and a readable one with no such key (`absent`).
 */
export function createKeychainKeySource(config: KeyConfig, keychain?: Keychain): KeySource {
  const backend = keychain ?? registeredKeychain;

  const read = (keyId: string): KeyLookup => {
    if (backend === undefined) {
      return {
        kind: "unavailable",
        detail:
          "no OS keychain binding is available here; keychain keys are read through the penv CLI, " +
          "not inside a deployed app",
      };
    }
    let stored: string | null;
    try {
      stored = backend.getPassword(KEYCHAIN_SERVICE, config.id);
    } catch (cause) {
      return {
        kind: "unavailable",
        detail: `the OS keychain could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    if (stored === null) {
      return {
        kind: "absent",
        detail: `the OS keychain holds no key \`${config.id}\` under service \`${KEYCHAIN_SERVICE}\``,
      };
    }
    const decoded = decodeKey(stored, `the OS keychain entry for \`${config.id}\``);
    return decoded.kind === "found" ? { ...decoded, keyId } : decoded;
  };

  return {
    type: "keychain",
    lookup(keyId) {
      if (keyId !== config.id) {
        return {
          kind: "absent",
          detail: `the OS keychain entry holds key \`${config.id}\`, not \`${keyId}\``,
        };
      }
      return read(keyId);
    },
    current() {
      return read(config.id);
    },
  };
}

/**
 * The source for an environment that declares no `keys` block.
 *
 * Every lookup is `unavailable`, never `absent`. penv was never told where to
 * look, so it has not looked — and reporting "no such key" would send the user
 * to create one when the fix is to declare where keys live.
 */
export function nullKeySource(environment: string): KeySource {
  const detail =
    `environment ${environment} declares no \`keys\` block in penv.config.ts, ` +
    "so penv was never told where its keys live";
  return {
    type: "none",
    lookup: () => ({ kind: "unavailable", detail }),
    current: () => ({ kind: "unavailable", detail }),
  };
}

/**
 * The key source for one environment. The single authority both the CLI and the
 * runtime call, so neither chooses — two choosers would be two answers to one
 * question, and one of them would eventually seal under a key the other cannot
 * find.
 */
export function resolveKeySource(config: PenvConfig, environment: string): KeySource {
  const declared = config.keys?.[environment];
  if (declared === undefined) {
    return nullKeySource(environment);
  }

  if (declared.source === "env") {
    return createEnvKeySource(declared);
  }
  if (declared.source === "keychain") {
    return createKeychainKeySource(declared);
  }

  // A source name penv has never heard of never falls through to a weaker one.
  //
  // `KeyConfig.source` is a closed union, and at this line that union is a
  // fiction: the config is a user's TypeScript file evaluated by jiti and cast
  // unchecked, so `source` is whatever they typed. Dispatching by name and
  // refusing the rest is what stops `source: "vault"` from sealing production
  // secrets under `PENV_KEY_*` while the config said Vault — the silent downgrade
  // this module exists to make impossible. `validateConfig` names it too, but
  // only for someone who ran `penv validate`; sealing a value must not depend on
  // that.
  throw new PenvError(
    "KEY_SOURCE_UNSUPPORTED",
    `Environment ${environment} declares key source \`${String(declared.source)}\`, which penv cannot read`,
    `\`${String(declared.source)}\` is not a key source penv knows. Declare \`source: "env"\` (exported as \`${envVarFor(declared.id)}\`) or \`source: "keychain"\`.`,
  );
}

/** The `id` charset. `:` is excluded because it separates the envelope's fields. */
const KEY_ID = /^[A-Za-z0-9._-]+$/;

const SOURCES: readonly string[] = ["env", "keychain"];

/**
 * Every problem in the `keys` block, collected rather than thrown so `penv
 * validate` reports the whole config. Mirrors the `providers` validation
 * deliberately: `keys` is the same shape of fact — one entry per environment —
 * and a second style of check for the same shape is a second thing to learn.
 */
export function validateKeys(config: PenvConfig, declared: ReadonlySet<string>): PenvError[] {
  const errors: PenvError[] = [];
  const keys: unknown = config.keys;
  if (keys === undefined) {
    return errors;
  }
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) {
    errors.push(
      new ConfigError(
        "`keys` in penv.config.ts is not an object",
        'Declare one key source per environment, e.g. `keys: { production: { source: "env", id: "prod" } }`, or remove the block.',
      ),
    );
    return errors;
  }

  const entries = keys as Readonly<Record<string, unknown>>;
  for (const environment of Object.keys(entries)) {
    if (!declared.has(environment)) {
      errors.push(
        new ConfigError(
          `The \`keys\` block in penv.config.ts names environment ${environment}, which is not declared`,
          `Add \`${environment}\` to the \`environments\` list, or remove its \`keys\` entry. ` +
            "Environments are a whitelist — penv never infers one.",
        ),
      );
      continue;
    }
    const entry = entries[environment];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        new ConfigError(
          `The \`keys\` entry for environment ${environment} is not a key-source object`,
          `Declare it as \`${environment}: { source: "env", id: "prod" }\`.`,
        ),
      );
      continue;
    }
    const { source, id } = entry as Readonly<Record<string, unknown>>;
    if (typeof source !== "string" || !SOURCES.includes(source)) {
      errors.push(
        new ConfigError(
          `The \`keys\` entry for environment ${environment} declares source \`${String(source)}\``,
          `A key source is ${SOURCES.map((s) => `\`${s}\``).join(" or ")}.`,
        ),
      );
    }
    if (typeof id !== "string" || !KEY_ID.test(id)) {
      errors.push(
        new ConfigError(
          `The \`keys\` entry for environment ${environment} declares id \`${String(id)}\``,
          "A key id is one or more of `A-Za-z0-9._-`. It is written into every value file " +
            "sealed under it, where `:` separates the fields, so `:` cannot appear in one.",
        ),
      );
    }
  }

  return errors;
}
