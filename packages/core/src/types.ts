/**
 * The shared vocabulary of penv. Every package speaks these types.
 *
 * A local penv record and a provider path are two serializations of one logical
 * record `(environment, path, name)`. These types are that record.
 */

/**
 * Tokens that can never be a parameter name or a declared environment name.
 *
 * Filenames are split on `.`, so any of these appearing as a name would make the
 * grammar ambiguous. Collision is a `penv validate` error, never a warning.
 * `enc` is reserved from day one even though encrypt/decrypt is not implemented,
 * so that reserving it later is not a migration.
 */
export const RESERVED_TOKENS = ["enc", "json", "toml", "yml", "local"] as const;
export type ReservedToken = (typeof RESERVED_TOKENS)[number];

/** Meta formats the grammar reserves. Only `json` is parsed today. */
export const META_FORMATS = ["json", "toml", "yml"] as const;
export type MetaFormat = (typeof META_FORMATS)[number];

/**
 * The scope of a value file — its position in the resolution cascade. The four
 * kinds mirror `.env`, `.env.[mode]`, `.env.local`, and `.env.[mode].local`, in
 * that correspondence and no other.
 *
 * `.enc` is deliberately not part of this union: encryption is a storage
 * property, orthogonal to precedence.
 */
export type Scope =
  | { readonly kind: "unscoped" }
  | { readonly kind: "environment"; readonly environment: string }
  | { readonly kind: "local" }
  /** A personal override that applies to one environment only. */
  | { readonly kind: "environment-local"; readonly environment: string };

/**
 * Fails to compile when a union gains a member some `switch` does not handle.
 * Scope is the union this matters most for: without it, a new scope silently
 * formats and resolves as though it were the unscoped default.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}

/** Identifies one parameter, independent of scope. `redis/password`. */
export interface ParameterRef {
  /** Namespace folder segments. `[]` for a root parameter. */
  readonly namespace: readonly string[];
  /** The parameter's own name. `password`. */
  readonly name: string;
}

/** A parsed value filename: one parameter at one scope, maybe encrypted. */
export interface ValueFile extends ParameterRef {
  readonly scope: Scope;
  /** True when the filename carries the terminal `.enc` marker. */
  readonly encrypted: boolean;
}

/** A parsed meta filename. Meta is per-parameter and always plaintext. */
export interface MetaFileRef extends ParameterRef {
  readonly format: MetaFormat;
}

export type ParsedFile =
  | ({ readonly kind: "value" } & ValueFile)
  | ({ readonly kind: "meta" } & MetaFileRef);

/**
 * Policy for one parameter in one environment. Unknown keys pass through
 * untouched so that fields introduced later are not destroyed by a round-trip
 * through an older penv.
 */
export interface MetaBlock {
  readonly description?: string;
  readonly owner?: string;
  readonly required?: boolean;
  /**
   * Declares this parameter a secret. Encryption is policy-driven: the `.enc`
   * marker is validated against this, never the other way round.
   */
  readonly secret?: boolean;
  readonly [key: string]: unknown;
}

/** A parameter's meta file: a base block plus per-environment overrides. */
export interface Meta extends MetaBlock {
  readonly environments?: Readonly<Record<string, MetaBlock>>;
}

export interface ProviderConfig {
  readonly type: string;
  /** The provider-side base path penv maps records onto. */
  readonly path?: string;
}

/**
 * A destination penv pushes values *to* and cannot read back. Declared under
 * `sinks`, never `providers`: a sink is not the system of record, so it is not a
 * provider, and collapsing the two in the config collapses them everywhere. An
 * environment may have both — a provider holding the truth and a sink receiving
 * it — which one key cannot express and two keys express exactly.
 */
export interface SinkConfig {
  readonly type: string;
  /**
   * The destination-side target, when it needs one — a GitHub `owner/repo`. Left
   * unset, the destination's own CLI resolves it from the working directory.
   */
  readonly repo?: string;
}

/**
 * Where one environment's encryption key comes from. Declared, never guessed: a
 * key source penv picked for you is a key you did not choose.
 */
export interface KeyConfig {
  readonly source: "env" | "keychain";
  /**
   * Names the key. Written into every value file sealed under it, so it must
   * outlive any one machine — and cannot contain `:`, which separates the
   * envelope's fields.
   */
  readonly id: string;
}

export interface PenvConfig {
  /**
   * The whitelist of valid environment names — the only source of truth for
   * what counts as an environment. Segments are matched against this list,
   * never inferred from folders or filenames.
   */
  readonly environments: readonly string[];
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  /**
   * Where the module holding the schema lives, relative to this config.
   * Defaults to `.penv/env.ts`.
   *
   * A path rather than a convention because the file is the user's (invariant 2)
   * — a file penv insists on owning the location of is not fully theirs, and
   * `src/env.ts` is where most projects would put it. Nothing downstream moves
   * when it does: consumers import `@env`, and the alias is what penv writes.
   */
  readonly schemaFile?: string;
  /**
   * The variable-name prefixes a framework inlines into its client bundle —
   * `NEXT_PUBLIC_`, `VITE_`.
   *
   * penv does not enforce these; the framework already does. Declaring them is
   * what lets `doctor` catch the one mistake neither penv nor the framework can
   * catch alone: a parameter meta declares `secret` whose name makes the
   * framework ship it to a browser. To the framework the prefix *is* the intent,
   * so only penv — holding both the policy and the name — can see the
   * contradiction.
   */
  readonly publicPrefixes?: readonly string[];
  /** Overrides the default name transform for generated `.env` output. */
  readonly names?: Readonly<Record<string, string>>;
  /**
   * Where each environment's encryption key lives. An environment with no entry
   * has no key source, which is not the same as having no key — see `keys.ts`.
   */
  readonly keys?: Readonly<Record<string, KeyConfig>>;
  /**
   * Where each environment's resolved values are pushed. A sink is a destination,
   * never the system of record — declared here, beside `providers` and never
   * inside it, so the two concepts cannot be mistaken for one at the first place
   * a user reads.
   */
  readonly sinks?: Readonly<Record<string, SinkConfig>>;
}

/**
 * The provider contract. The filesystem provider is the reference
 * implementation and the ground truth: every provider satisfies this contract
 * unchanged, or the portability claim is false.
 */
export interface Provider {
  readonly type: string;
  /** Reads one value file. Resolves to `undefined` when absent. */
  read(file: ValueFile): Promise<string | undefined>;
  /** Writes one value file, creating namespaces as needed. */
  write(file: ValueFile, value: string): Promise<void>;
  /** Lists every value file the provider holds. */
  list(): Promise<ValueFile[]>;
  /** Removes one value file. Absent is not an error. */
  remove(file: ValueFile): Promise<void>;
  /** Reads a parameter's meta. Resolves to `undefined` when absent. */
  readMeta(ref: ParameterRef): Promise<Meta | undefined>;
  /** Writes a parameter's meta. */
  writeMeta(ref: ParameterRef, meta: Meta): Promise<void>;
  /**
   * Removes a parameter's meta. Absent is not an error, mirroring `remove`.
   *
   * The counterpart `writeMeta` lacked. Without it a parameter's policy could be
   * created and never destroyed, so renaming one could only ever leave the old
   * policy behind — and an orphaned meta file is invisible to every check penv
   * has, because `list` reports values and a parameter with no value files is a
   * parameter nothing walks.
   */
  removeMeta(ref: ParameterRef): Promise<void>;
}

/**
 * Which destination store a value lands in. The two members are penv's own
 * precedence axis wearing the destination's names: the unscoped default is the
 * value every context falls back to (`repository`), an environment-scoped value
 * belongs to exactly one (`environment`). GitHub resolves the two in penv's own
 * order — environment over repository — so the cascade is reproduced by the
 * destination's native mechanism rather than flattened at the boundary.
 */
export type SecretScope =
  | { readonly kind: "repository" }
  | { readonly kind: "environment"; readonly environment: string };

/** One secret as a write-only destination reports it: a name and when it last changed, never a value. */
export interface SinkSecret {
  readonly name: string;
  /** The destination's last-modified time, ISO 8601. Compared against penv's last-push time to catch a hand-edit. */
  readonly updatedAt: string;
}

/**
 * A write-only destination. Unlike a {@link Provider} it cannot `read`, so no
 * adapter for it ever passes the provider contract, it never appears as an
 * environment's `provider`, and it does not participate in `penv pull`. penv
 * resolves the tree; the sink receives it.
 */
export interface Sink {
  readonly type: string;
  /**
   * Confirms the destination is reachable before the first push. Every name is
   * already judged up front, so a push never places half its secrets and then
   * hits a reserved name; this closes the other pre-push gap — the destination
   * being unreachable. GitHub through `gh` checks it is installed, authenticated,
   * and can reach this repository's secrets, and refuses loudly rather than
   * falling back. It cannot prove per-environment write permission without
   * writing, so that narrower failure surfaces at push time as the same loud
   * refusal. Resolves when it is safe to push.
   */
  verify(): Promise<void>;
  /**
   * Sends one value to the destination, which seals it under its own key. The
   * value crosses in plaintext because a CI runner holds no penv key — penv's
   * encryption stops at the sink and the destination's custody takes over.
   */
  push(name: string, value: string, scope: SecretScope): Promise<void>;
  /**
   * The names the destination holds at a scope, each with its last-modified
   * time. Listing names is the one read a write-only destination allows; values
   * never come back.
   */
  list(scope: SecretScope): Promise<SinkSecret[]>;
}

/**
 * Why a value did not open. Four reasons, each one penv is certain of; there is
 * deliberately no "unknown".
 *
 * `undecipherable` covers three causes at once — the wrong key, damaged bytes, or
 * a ciphertext moved from another address — because authenticated encryption
 * genuinely cannot tell them apart: all three are the same failed tag check. penv
 * does not guess between them, so the remedy names all three.
 */
export type DecryptReason =
  /** The key source could not be consulted, so penv cannot say whether the key exists. */
  | "key-source-unavailable"
  /** The source was consulted and holds no key with the envelope's id. */
  | "key-absent"
  /** The stored bytes are not a penv envelope. Decided without touching a key. */
  | "malformed-envelope"
  /** The envelope parsed and the key was found, and the value still did not open. */
  | "undecipherable";

export interface DecryptFailure {
  readonly reason: DecryptReason;
  readonly detail: string;
}

/** One value file considered during resolution, in precedence order. */
export interface ResolutionCandidate {
  readonly file: ValueFile;
  /** Provider-addressable location, for `--explain`. */
  readonly location: string;
  /** Whether this candidate exists in the provider. */
  readonly present: boolean;
  /** Set when a present candidate was passed over for a higher-precedence one. */
  readonly skippedReason?: "lower-precedence" | "local-skipped-in-test" | "local-skipped-in-push";
}

/** The outcome of resolving one parameter for one environment. */
export interface Resolution {
  readonly ref: ParameterRef;
  /** Dotted access path — `redis.password`. */
  readonly parameter: string;
  /** `undefined` when no candidate was present, or when the winner did not open. */
  readonly value: string | undefined;
  readonly winner: ResolutionCandidate | undefined;
  /**
   * Set only when `winner` is present, encrypted, and did not decrypt.
   *
   * A present winner yields exactly one of `value` or `undecryptable`, and that
   * is what keeps "there is no value" and "there is a value penv cannot read"
   * from being one answer to two questions. They have opposite remedies: one
   * says `penv set`, the other says find your key — and a caller that offered
   * the first would be telling you to overwrite a secret you still have.
   *
   * Both absent means no candidate was present at all.
   */
  readonly undecryptable?: DecryptFailure;
  /** Every candidate, highest precedence first. */
  readonly candidates: readonly ResolutionCandidate[];
  /**
   * True when a real environment resolved via the unscoped default. Fallback is
   * never silent — `penv doctor` surfaces every one of these.
   */
  readonly viaUnscopedFallback: boolean;
}
