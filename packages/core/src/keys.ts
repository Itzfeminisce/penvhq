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
import { environmentEntry } from "./types.js";

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
 * The source for an environment that declares no `keySource`.
 *
 * Every lookup is `unavailable`, never `absent`. penv was never told where to
 * look, so it has not looked — and reporting "no such key" would send the user
 * to create one when the fix is to declare where keys live.
 */
export function nullKeySource(environment: string): KeySource {
  const detail =
    `environment ${environment} declares no \`keySource\` in penv.config.ts, ` +
    "so penv was never told where its keys live";
  return {
    type: "none",
    lookup: () => ({ kind: "unavailable", detail }),
    current: () => ({ kind: "unavailable", detail }),
  };
}

/**
 * The environment's declared key, with the shorthand expanded: `keySource: "env"`
 * is the key named after the environment itself, and rotation to a
 * differently-named key is what the object form says. The defaulted id *is* the
 * environment name, so the identifier an artifact carries is unchanged by the
 * shorthand.
 */
export function keyConfigFor(config: PenvConfig, environment: string): KeyConfig | undefined {
  const declared = environmentEntry(config, environment)?.keySource;
  if (declared === undefined) {
    return undefined;
  }
  if (typeof declared === "string") {
    return { source: declared, id: environment };
  }
  return { source: declared.source, id: declared.id ?? environment };
}

/**
 * The key source for one environment. The single authority both the CLI and the
 * runtime call, so neither chooses — two choosers would be two answers to one
 * question, and one of them would eventually seal under a key the other cannot
 * find.
 */
export function resolveKeySource(config: PenvConfig, environment: string): KeySource {
  const declared = keyConfigFor(config, environment);
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
    `\`${String(declared.source)}\` is not a key source penv knows. Declare \`keySource: "env"\` (exported as \`${envVarFor(declared.id)}\`) or \`keySource: "keychain"\`.`,
  );
}

/** What an artifact's `keySource` says when the environment declares none. */
export const NO_KEY_SOURCE = "none";

/**
 * The environment's key source, written as the one identifier a deployment
 * artifact carries — `env:prod`, `keychain:prod`, or `none`.
 *
 * It names *where the key lives*, never the key. That is what lets an artifact
 * be read in a container with no `penv.config.ts`: the declaration does not
 * travel, so the artifact says which door to knock on and nothing else.
 * {@link resolveKeySource} decides, here as everywhere, so an unrecognised
 * source refuses at build time instead of producing an artifact that names a
 * source nothing can read.
 */
export function keySourceIdentifier(config: PenvConfig, environment: string): string {
  const source = resolveKeySource(config, environment);
  const declared = keyConfigFor(config, environment);
  if (declared === undefined) {
    return NO_KEY_SOURCE;
  }
  return `${source.type}${SOURCE_SEPARATOR}${declared.id}`;
}

const SOURCE_SEPARATOR = ":";

/**
 * The key source an artifact's identifier names.
 *
 * The mirror of {@link keySourceIdentifier}, and it falls back to nothing: an
 * identifier this penv does not recognise refuses rather than reaching for
 * whatever key happens to be exported (invariant 15).
 */
export function keySourceFrom(identifier: string, environment: string): KeySource {
  if (identifier === NO_KEY_SOURCE) {
    return nullKeySource(environment);
  }
  const [source, id] = identifier.split(SOURCE_SEPARATOR);
  if (source !== undefined && id !== undefined && KEY_ID.test(id)) {
    if (source === "env") {
      return createEnvKeySource({ source: "env", id });
    }
    if (source === "keychain") {
      return createKeychainKeySource({ source: "keychain", id });
    }
  }
  throw new PenvError(
    "KEY_SOURCE_UNSUPPORTED",
    `\`${identifier}\` names no key source penv can read`,
    `A key source is ${SOURCES.map((s) => `\`${s}:<id>\``).join(" or ")}, or \`${NO_KEY_SOURCE}\`. ` +
      "Rebuild the artifact with the penv that reads it.",
  );
}

/** The `id` charset. `:` is excluded because it separates the envelope's fields. */
const KEY_ID = /^[A-Za-z0-9._-]+$/;

const SOURCES: readonly string[] = ["env", "keychain"];

/**
 * Every problem in a declared `keySource`, collected rather than thrown so `penv
 * validate` reports the whole config. `declared` is the whitelist validation
 * already judged, so a blank or unwritable environment name is reported once,
 * where it is wrong, rather than again here.
 */
export function validateKeys(config: PenvConfig, declared: ReadonlySet<string>): PenvError[] {
  const errors: PenvError[] = [];

  for (const environment of declared) {
    const keySource: unknown = environmentEntry(config, environment)?.keySource;
    if (keySource === undefined) {
      continue;
    }

    // The shorthand carries no id of its own: it is the environment's name, which
    // the whitelist checks already hold to a stricter charset than a key id.
    if (typeof keySource === "string") {
      if (!SOURCES.includes(keySource)) {
        errors.push(unknownSource(environment, keySource));
      }
      continue;
    }

    if (keySource === null || typeof keySource !== "object" || Array.isArray(keySource)) {
      errors.push(
        new ConfigError(
          `The \`keySource\` for environment ${environment} is not a key source`,
          `Declare it as \`keySource: "env"\` — the key named after the environment — or as ` +
            `\`keySource: { source: "env", id: "prod" }\` to name a different key.`,
        ),
      );
      continue;
    }

    const { source, id } = keySource as Readonly<Record<string, unknown>>;
    if (typeof source !== "string" || !SOURCES.includes(source)) {
      errors.push(unknownSource(environment, String(source)));
    }
    if (id !== undefined && (typeof id !== "string" || !KEY_ID.test(id))) {
      errors.push(
        new ConfigError(
          `The \`keySource\` for environment ${environment} declares id \`${String(id)}\``,
          "A key id is one or more of `A-Za-z0-9._-`. It is written into every value file " +
            "sealed under it, where `:` separates the fields, so `:` cannot appear in one. " +
            "Omit `id` to use the environment's own name.",
        ),
      );
    }
  }

  return errors;
}

function unknownSource(environment: string, source: string): ConfigError {
  return new ConfigError(
    `The \`keySource\` for environment ${environment} declares source \`${source}\``,
    `A key source is ${SOURCES.map((s) => `\`${s}\``).join(" or ")}.`,
  );
}
