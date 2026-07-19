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

/**
 * The provider config types penv knows about, keyed by package name. Empty here,
 * deliberately: core owns the `Provider` contract and must not know which
 * implementations exist. Each provider package augments this interface with its
 * own config shape under its own name —
 *
 * ```ts
 * declare module "@penvhq/core" {
 *   interface ProviderConfigMap {
 *     "@penvhq/provider-vault": VaultProviderConfig;
 *   }
 * }
 * ```
 *
 * — so the compile-time union is exactly the set of providers the project has
 * installed, and {@link defineConfig} can hold a known `type`'s fields to the
 * provider's own declaration while leaving an unknown `type` the open base shape.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target — see docblock.
export interface ProviderConfigMap {}

/** The provider package names whose config types are installed and merged in. */
export type KnownProviderType = keyof ProviderConfigMap & string;

export interface ProviderConfig {
  /**
   * The provider package's fully-qualified name — `"@penvhq/provider-vault"`.
   * The name is the import specifier: penv resolves it from the project's own
   * `node_modules`, so declaring a provider and installing its package are the
   * same decision stated twice, and the config never needs a second field to
   * say where the implementation lives.
   */
  readonly type: KnownProviderType | (string & {});
  /**
   * The place inside the provider that penv maps the tree onto. The format is
   * the provider's own — a Vault KV base path, a Kubernetes
   * `namespace/secretName` — and its package's config type documents it; the
   * field name never changes between providers.
   */
  readonly location?: string;
  /** Fields beyond `location` belong to the provider's own config type. */
  readonly [key: string]: unknown;
}

/**
 * What penv hands a provider package's `penvProviderFactory` to build a provider
 * rooted at one project's `.penv`. Declared here because it is the seam every
 * provider package builds against — the CLI supplies it, the package consumes
 * it, and neither imports the other's internals.
 */
export interface ProviderFactoryContext {
  /** The `.penv/` directory, absolute. */
  readonly root: string;
  /**
   * Required because a provider parses environment segments, and a segment is an
   * environment only if the config declares it — never inferred from the store.
   */
  readonly config: PenvConfig;
  /**
   * The one environment's own `providers.*` entry, when building its declared
   * source of truth. Carries provider-side settings — the `location` above all —
   * that the config authored, never inferred.
   */
  readonly providerConfig?: ProviderConfig;
  /**
   * The environment this provider is the source of truth *for*, when that is
   * what is being built.
   */
  readonly environment?: string;
}

/** The fields a provider entry carries that its declared config type does not. */
type UnknownProviderFields<E, T extends KnownProviderType> = Exclude<
  keyof E,
  keyof ProviderConfigMap[T] | "type"
>;

/**
 * What `defineConfig` holds one `providers.<env>` entry to. A `type` that names
 * an installed provider package is checked against that package's own config
 * declaration — wrong field types fail, and a field the provider never declared
 * maps to `never` so the config cannot carry it. A `type` core has no
 * declaration for (a provider penv has not seen installed, or a third-party
 * package) keeps the open base shape: the compile-time answer and the runtime
 * `UNKNOWN_PROVIDER` answer are the same — install the package.
 */
export type ValidatedProviderEntry<E> = E extends { readonly type: infer T extends string }
  ? T extends KnownProviderType
    ? UnknownProviderFields<E, T> extends never
      ? ProviderConfigMap[T] & { readonly type: T }
      : { readonly [K in UnknownProviderFields<E, T>]: never }
    : E
  : E;

/** The `providers` block with every entry validated — see {@link ValidatedProviderEntry}. */
export type ValidatedProviders<P> = {
  readonly [E in keyof P]: ValidatedProviderEntry<P[E]>;
};

/**
 * What a provider's store can honestly do — the declaration that replaced the
 * old sink/provider split. The distinction the split guarded is real (GitHub
 * Actions Secrets never returns a value) and lives here now, in the contract,
 * instead of in a second config key the user had to learn.
 */
export interface ProviderCapabilities {
  /**
   * What the store holds. `records`: penv records verbatim — opaque envelope
   * strings at every scope, meta as a sibling record — the shape the behavioural
   * contract suite gates. `projection`: a resolved projection — generated
   * variable names, both `.local` scopes skipped, plaintext for the destination
   * to re-seal — the shape a CI secret store consumes.
   */
  readonly holds: "records" | "projection";
  /**
   * Whether stored values can be read back. GitHub's API returns names and
   * timestamps, never values, so it declares `false` — and `pull` materialises
   * names and meta while `doctor` reports value drift as unknown, never as
   * clean.
   */
  readonly readsValues: boolean;
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
}

/**
 * The provider contract. The filesystem provider is the reference
 * implementation and the ground truth: every provider satisfies this contract
 * unchanged, or the portability claim is false.
 */
export interface Provider {
  readonly type: string;
  /**
   * What this provider's store can do. Absent means records-and-readable — the
   * general case, so every record-holding provider is unchanged by the field's
   * existence. A provider that declares `holds: "projection"` is a different
   * declared kind ({@link ProjectionProvider}) and never satisfies this
   * interface's methods; penv tells the two apart through
   * {@link holdsProjection}, never by trying a method and watching it lie.
   */
  readonly capabilities?: ProviderCapabilities;
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
  /**
   * Reads the value a parameter held before its current one — the sole retention
   * operation the contract asks for, and an optional one. A provider that retains
   * previous values implements it (and thereby satisfies {@link RetainingProvider});
   * one that does not — the filesystem, Kubernetes, the general case — omits it
   * entirely and still satisfies this contract.
   *
   * Never call it without first narrowing through {@link retainsPrevious}: retention
   * is declared, not assumed, and a provider that omits this method has no such
   * property to guess at.
   */
  readPrevious?(file: ValueFile): Promise<string | undefined>;
}

/**
 * A {@link Provider} that retains a parameter's previous value. The narrowing
 * {@link retainsPrevious} produces; the type a `dual-valid` rotation demands, since
 * `atomic-cutover` does not.
 *
 * The capability is "give me the previous value" and nothing more. Retention
 * *policy* is deliberately absent, because it does not survive the crossing
 * between providers: Vault expires versions on a time TTL, SSM caps at a fixed
 * 100 and silently prunes the oldest, Kubernetes retains nothing at all. A
 * mandatory verb shaped on any one of those is unsatisfiable by the others, so
 * the contract asks for none of them — no TTL, no count, no window.
 *
 * penv owns the grace-window clock (`rotatingSince` in meta); a provider is never
 * asked to enforce a window, only to answer — and must be free to answer no. A
 * non-retaining provider is not an exception to patch over: it is the general
 * case, and the filesystem and Kubernetes sit on the same side of that line.
 */
export interface RetainingProvider extends Provider {
  /**
   * Reads the value a parameter held before its current one, at a single scope.
   * Resolves to `undefined` when the provider no longer holds it — provider
   * pruning and penv's timer do not commute, so the previous version may already
   * be gone. Absence is never an error: a rotation that cannot find its previous
   * value is a `doctor` failure, never a silent success, on the same rule the
   * encryption check follows for a sealed value penv cannot open.
   */
  readPrevious(file: ValueFile): Promise<string | undefined>;
}

/**
 * Narrows a provider to one that retains previous values, reading the capability
 * the provider declared rather than guessing at it. This is the one place penv
 * asks: a `dual-valid` rotation refuses a non-retaining provider here, up front,
 * rather than discovering the gap at the moment it reaches for a previous value.
 */
export function retainsPrevious(provider: Provider): provider is RetainingProvider {
  return typeof provider.readPrevious === "function";
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

/** One secret as a value-withholding store reports it: a name and when it last changed, never a value. */
export interface ProjectionSecret {
  readonly name: string;
  /** The destination's last-modified time, ISO 8601. Compared against penv's last-push time to catch a hand-edit. */
  readonly updatedAt: string;
}

/**
 * A provider whose store holds a resolved *projection* rather than penv records
 * — generated variable names, both `.local` scopes skipped, plaintext the
 * destination re-seals under its own custody. It declares
 * `capabilities.holds: "projection"` and satisfies this contract instead of the
 * seven-method record contract, which its store cannot honestly implement: a
 * `read` that can never return a value would make every downstream check read
 * an unreadable store as an empty one.
 *
 * penv resolves the tree; the projection receives it. `push` speaks this
 * surface; `pull` materialises what `list` can honestly give — names and
 * timestamps, never values.
 */
export interface ProjectionProvider {
  readonly type: string;
  readonly capabilities: ProviderCapabilities & { readonly holds: "projection" };
  /**
   * Confirms the destination is reachable before the first push. Every name is
   * already judged up front, so a push never places half its secrets and then
   * hits a reserved name; this closes the other pre-push gap — the destination
   * being unreachable. GitHub through `gh` checks it is installed, authenticated,
   * and can reach this repository's secrets, and refuses loudly rather than
   * falling back. Resolves when it is safe to push.
   */
  verify(): Promise<void>;
  /**
   * Sends one value to the destination, which seals it under its own key. The
   * value crosses in plaintext because a CI runner holds no penv key — penv's
   * encryption stops at the projection and the destination's custody takes over.
   */
  push(name: string, value: string, scope: SecretScope): Promise<void>;
  /**
   * The names the destination holds at a scope, each with its last-modified
   * time. Listing names is the one read a value-withholding store allows.
   */
  list(scope: SecretScope): Promise<ProjectionSecret[]>;
  /**
   * The destination's own name grammar, judged before the first PUT. The rules
   * are the destination's (GitHub's reserved `GITHUB_` prefix, its charset, its
   * case-insensitivity), so the provider owns the check — the CLI only insists
   * it runs before anything is pushed, never mid-push.
   */
  checkNames?(refs: readonly ParameterRef[], config: PenvConfig): PenvErrorLike[];
  /**
   * Whether the destination-side target an environment's push lands in exists
   * yet — a GitHub deployment environment, say. Implemented only where the
   * destination has such a notion.
   */
  targetExists?(environment: string): Promise<boolean>;
  /**
   * Creates the destination-side target for an environment. Never called
   * without an explicit go-ahead: the CLI prompts (or `--yes` pre-approves) and
   * only then asks the provider, which stays non-interactive. Creation on an
   * explicit answer, never a guess — a typo'd environment name must not summon
   * infrastructure.
   */
  ensureTarget?(environment: string): Promise<void>;
}

/**
 * The error shape {@link ProjectionProvider.checkNames} returns — structurally
 * `PenvError`, stated as an interface so the contract does not force provider
 * packages to subclass core's error class.
 */
export interface PenvErrorLike extends Error {
  readonly code: string;
  readonly remedy?: string | undefined;
}

/** Any provider penv can build from a `providers.*` entry: records or projection. */
export type AnyProvider = Provider | ProjectionProvider;

/**
 * Narrows to a projection-holding provider, reading the capability it declared.
 * The one place penv asks — the same pattern as {@link retainsPrevious}, one
 * level up.
 */
export function holdsProjection(provider: AnyProvider): provider is ProjectionProvider {
  return provider.capabilities?.holds === "projection";
}

/** Narrows to a record-holding provider — the general case, absent capabilities included. */
export function holdsRecords(provider: AnyProvider): provider is Provider {
  return !holdsProjection(provider);
}

/** Whether a provider's stored values can be read back. Absent capabilities means yes. */
export function readsValues(provider: AnyProvider): boolean {
  return provider.capabilities?.readsValues !== false;
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
