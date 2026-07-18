# The provider contract

This is the interface every penv provider satisfies, extracted and stated on its
own so that the adapters still to come — AWS SSM and Kubernetes at
[v0.6](./Roadmap.md#v06--second-and-third-providers), a public SDK at
[v1.0](./Roadmap.md#v10--stable-sdk) — build against a written contract rather than
against the filesystem provider's habits. The [RFC](./RFC.md) owns *why* these
shapes are what they are; the [v0.5 plan](./v0.5-plan.md) owns *how* the Vault
adapter was built to fit them; this file owns *what the contract is*, in one place,
as the thing those milestones are measured against.

The contract is not prose. It is `runProviderContractSuite` in
[`@penvhq/provider-contract`](../packages/providers/contract/src/contract.ts), a
single behavioural suite that the filesystem provider, an in-memory fixture, and now
Vault all pass **unchanged**. This document explains that suite; the suite is the
authority. Where the two ever disagree, the suite is right and this document has a
bug.

The canonical types are in
[`packages/core/src/types.ts`](../packages/core/src/types.ts). Every signature
quoted below is copied from there.

---

## The unit of address

A provider is addressed by the vocabulary of `@penvhq/core` and nothing else — no
paths, no `node:fs`, no on-disk layout. Four types make up that vocabulary.

A **`ParameterRef`** identifies one parameter, independent of scope:

```ts
export interface ParameterRef {
  /** Namespace folder segments. `[]` for a root parameter. */
  readonly namespace: readonly string[];
  /** The parameter's own name. `password`. */
  readonly name: string;
}
```

A **`ValueFile`** is a `ParameterRef` at one scope, maybe encrypted — the unit a
value is stored under:

```ts
export interface ValueFile extends ParameterRef {
  readonly scope: Scope;
  /** True when the filename carries the terminal `.enc` marker. */
  readonly encrypted: boolean;
}
```

A **`Scope`** is the position in the resolution cascade — four kinds, mirroring
`.env`, `.env.[mode]`, `.env.local`, and `.env.[mode].local`, in that
correspondence and no other:

```ts
export type Scope =
  | { readonly kind: "unscoped" }
  | { readonly kind: "environment"; readonly environment: string }
  | { readonly kind: "local" }
  /** A personal override that applies to one environment only. */
  | { readonly kind: "environment-local"; readonly environment: string };
```

Two of the four carry an `environment`, and that field is load-bearing: it is not
decoration on the kind, it is part of the address. Dropping it is the scope-widening
leak this contract exists to catch, and the suite is built to catch it — see
[the orthogonal-axes invariant](#each-address-is-its-own-address) below.

**`Meta`** is a parameter's policy, addressed by the bare `ParameterRef`. It is a
base block plus per-environment overrides, and unknown keys pass through untouched:

```ts
export interface MetaBlock {
  readonly description?: string;
  readonly owner?: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly [key: string]: unknown;
}

export interface Meta extends MetaBlock {
  readonly environments?: Readonly<Record<string, MetaBlock>>;
}
```

The provider is told which store to talk to by **`ProviderConfig`** — a `type` and an
optional base `path` the provider maps records onto:

```ts
export interface ProviderConfig {
  readonly type: string;
  /** The provider-side base path penv maps records onto. */
  readonly path?: string;
}
```

Everything a provider does is a translation between these types and its own store.
The Vault adapter turns them into KV v2 paths; the filesystem provider turns them
into filenames under `.penv/`. Neither is allowed to change the types to make the
translation easier.

---

## The seven required methods

```ts
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
  /** Removes a parameter's meta. Absent is not an error, mirroring `remove`. */
  removeMeta(ref: ParameterRef): Promise<void>;
  readPrevious?(file: ValueFile): Promise<string | undefined>;
}
```

Seven required methods over `ValueFile` and `ParameterRef`, plus one optional
`readPrevious` treated separately [below](#the-optional-capability-readprevious).
The `type` is a non-empty string naming the provider (`"filesystem"`, `"vault"`);
the suite's first assertion is only that it exists and is non-empty.

The invariants below are not advisory. Each is a test the suite runs against every
provider, and a provider that violates one fails the suite.

### Absence is success, on every read and every remove

`read`, `readMeta`, `readPrevious`, `remove`, and `removeMeta` all treat "not there"
as an ordinary outcome, never an error.

- `read` and `readMeta` **resolve to `undefined`** for a value or meta that was never
  written. They do not throw, and they do not reject. A parameter that has a value at
  one scope and nothing at another is the normal state of the tree, not an exception
  to handle.
- `remove` and `removeMeta` are **idempotent**: removing something absent resolves
  with no error, and removing the same thing twice resolves both times. The suite
  asserts this at the unscoped scope and again at the environment-local scope,
  because a provider that keys its addresses wrong could easily make one work and the
  other throw.

This is the single most important thing a provider gets right or wrong, because
every higher layer of penv — resolution, `doctor`, `pull` — is written assuming a
read of an absent value comes back `undefined` rather than blowing up. A provider
that rejects on "not found" does not merely fail a test; it makes the cascade
unresolvable, since resolving a parameter *is* asking for values that are mostly not
there.

There is one narrow rule that sits underneath this, visible in the filesystem
provider's comment on its `async` methods: a contract method returning a promise
must never *throw synchronously*. Failure has exactly one channel — the rejected
promise — because no caller of the contract watches two. Absence is not a failure at
all; a genuine failure (the store is unreachable, the bytes are corrupt) is a
rejection, never a synchronous throw.

### Values are opaque, byte-exact strings

A value is a string of bytes penv hands the provider to hold and hand back
unchanged. The provider does not parse it, trim it, normalise it, or interpret it.
The suite proves this with a battery of round-trip cases, and every one must come
back identical to what went in:

- the empty string `""`,
- leading and trailing spaces, `"  padded  "`,
- a leading tab, `"\tindented"`,
- an embedded newline, `"line one\nline two"`,
- a single trailing newline, `"trailing\n"`,
- several trailing newlines, `"trailing\n\n\n"`,
- a CRLF sequence, `"crlf\r\nvalue"`,
- unicode, `"clé-privée-🔐-Ω"`,
- quotes and escapes, `` `{"a":"b\\n"} 'single' "double"` ``,
- a base64-shaped value with its own trailing newline, `"aGVsbG8gd29ybGQ=\n"`.

The trailing-newline cases are the ones a naive provider gets wrong. The filesystem
provider writes `` `${value}\n` `` and strips exactly one trailing newline on read —
no more — precisely so that `"trailing\n"`, `"trailing\n\n\n"`, and `""` remain three
distinct values and not one. A provider that "helpfully" trims whitespace, or that
stores values in a format with its own escaping, will collapse cases that must stay
apart. Opacity is why encryption is free to the provider: core seals a value into a
single-line envelope before the provider ever sees it (see the
[v0.5 plan](./v0.5-plan.md)), so a store that round-trips an arbitrary string
round-trips a ciphertext with no extra work.

### Meta is per-parameter, and always plaintext JSON

`readMeta`, `writeMeta`, and `removeMeta` address a parameter by its bare
`ParameterRef` — no scope, no `encrypted` flag. A parameter has exactly one meta
record regardless of how many value files it has across how many scopes. The suite
asserts meta round-trips faithfully, including its nested `environments` block and —
critically — **unknown keys**: a `rotationPolicy`, a `rotatingSince`, any field a
newer penv writes must survive a round-trip through a provider that has never heard
of it, so that an older penv reading and rewriting a record does not silently delete
a newer field it did not understand.

Meta is stored plaintext, as JSON, always. It is policy, not secret material — a
`description`, an `owner`, a `required` flag — and it is never encrypted and never
mapped onto a provider's native metadata facility. That last point is a decision with
teeth: Vault's `custom_metadata` cannot hold penv's nested meta (512-byte values, no
nesting), SSM's `PutParameter` cannot write a description without also writing a
value, and Kubernetes annotations are per-Secret rather than per-parameter. So meta
is a *sibling record at its own address* on every provider — the filesystem's
`.json` file was the portable answer all along. The RFC works this through in full
under [Meta is a record with its own address](./RFC.md#meta-is-a-record-with-its-own-address-not-a-providers-native-metadata).

Two consequences the suite pins down explicitly:

- **Meta and value are independent.** `readMeta` returns a record for a parameter
  that has no value file at all, and `read` returns `undefined` for a parameter that
  has meta but no value. `remove` leaves meta alone; `removeMeta` leaves every value
  alone. Policy and value are two faces of one logical record, removed on separate
  verbs, because a `penv mv` that moves a description must not delete the secret, and
  a rename that drops a value must not orphan its policy.
- **`removeMeta` exists so policy can be destroyed.** It is the counterpart `writeMeta`
  lacked. Without it a parameter's policy could be created and never removed, and a
  rename could only ever leave the old policy behind — an orphan invisible to every
  check penv has, because `list` reports values and a parameter with no value files is
  a parameter nothing walks.

### Each address is its own address

The four scopes and the `encrypted` flag are **orthogonal axes**, and every
combination is a distinct storage address. One parameter can therefore hold, all at
once and all distinct:

- an unscoped value,
- an environment-scoped value per environment,
- a `local` value,
- an environment-local value per environment,

and each of those in a plaintext and an encrypted variant. The suite writes all four
scopes of one parameter with four different values and reads back four different
values; it writes a plaintext and an encrypted value at the same scope and reads back
two; it removes one scope and confirms the other three survive untouched.

The sharpest case — the one the suite was built around — is **environment-local
values keyed on their environment**. An `environment-local` override for `production`
and one for `development` are two records, not one:

```ts
it("keeps environment-local values for different environments apart", async () => {
  const forProduction = valueFile(redisPassword, {
    kind: "environment-local",
    environment: ENVIRONMENT,
  });
  const forOther = valueFile(redisPassword, {
    kind: "environment-local",
    environment: OTHER_ENVIRONMENT,
  });

  await provider.write(forProduction, "personal-production");
  await provider.write(forOther, "personal-development");

  expect(await provider.read(forProduction)).toBe("personal-production");
  expect(await provider.read(forOther)).toBe("personal-development");
});
```

A provider that builds its address from the scope *kind* while dropping the
`environment` string would pass a cursory eye — both values are `environment-local`,
after all — and would then quietly store one developer's override for one environment
as the override for *every* environment. That is the scope-widening leak penv exists
to delete, reintroduced inside the provider. The suite's `scopeKey` helper keys every
environment-bearing scope on its `environment` for exactly this reason, and its
comment says so: "a key that dropped the environment would make this suite pass while
a provider overwrote one with the other." The environment is part of the address, and
a provider that treats it as anything less fails.

### `list()` returns every value, and only values

`list()` returns every `ValueFile` the provider holds, across every scope and both
encryption states, and it returns them as `ValueFile` records — never meta. The suite
asserts:

- an empty provider lists `[]`,
- a provider with values at eight different (parameter, scope, encrypted) addresses
  lists all eight as eight distinct records,
- all four scopes of one parameter list as four distinct records, and
  environment-local values for two environments list as two,
- a removed value does not appear,
- **a written meta is never returned as a value** — meta lives at its own address and
  is excluded from the walk.

The distinctness assertions are load-bearing rather than decorative, and the suite's
own comment flags the trap: both sides of the comparison run through the same
`identity` function, so an identity that dropped the environment would collapse both
sides equally and the test would still pass while treating two records as one. The
suite defends against its own blind spot by also asserting the *count* of distinct
identities, which no collapse can fake.

**Order is not part of the contract.** The suite compares `list()` results as sorted
sets of stable identities, never as sequences, so a provider is free to return
records in whatever order its store yields them. The filesystem walks directories
alphabetically and Vault walks LIST results as they arrive; both are correct, because
neither order is asserted.

### Namespaces are created as needed

`write` creates whatever namespace structure the `ValueFile` implies — the suite
writes to `{ namespace: ["app", "auth"], name: "jwt-secret" }` against a store that
has never seen `app` or `auth` and expects it to succeed. On the filesystem this is
`mkdir -p`; on Vault the path simply comes into being on write. A provider never
requires a namespace to be declared before a value is written into it.

---

## Why async, and why never on the runtime hot path

Every method returns a `Promise`, and yet penv's runtime `load(schema)` is
synchronous and never awaits a provider. Both are true at once because **a provider
is a sync target, not a runtime source** — the application does not read its
configuration from Vault at boot.

The values *live* in the provider; the application reads them from the local `.penv`
tree that `penv pull` materialises from the provider. Resolution is always local,
always synchronous, and never branches on provider type — the runtime reads disk
regardless of which provider holds the truth. A provider is touched only by the
commands that sync: `pull`, `push`/`set`, and `doctor`. The RFC works through why
this is forced rather than chosen — a synchronous `load` returning `z.infer<T>`
cannot make a network call, so the provider cannot be what the runtime reads without
breaking either the type or the portability claim — under
[A provider is a sync target, not a runtime source](./RFC.md#a-provider-is-a-sync-target-not-a-runtime-source).

The consequence for the contract is that `async` costs nothing. Since no provider
method is ever on the boot path, a network round-trip per method is paid only by
sync-time commands, where latency is expected and acceptable. The filesystem provider
implements each async method over a synchronous core and notes that the runtime "never
awaits a provider, and must keep not doing so"; the async signature exists so that a
network provider satisfies the *same* interface, not because the reference provider
needs it. This is why the contract could be async from day one without any cost to the
surface penv leads with.

---

## The optional capability: `readPrevious`

One operation is optional, and it is the only retention operation the contract asks
for:

```ts
export interface RetainingProvider extends Provider {
  readPrevious(file: ValueFile): Promise<string | undefined>;
}

export function retainsPrevious(provider: Provider): provider is RetainingProvider {
  return typeof provider.readPrevious === "function";
}
```

On the base `Provider` the method is optional (`readPrevious?`). A provider that
retains previous values implements it and thereby satisfies `RetainingProvider`; one
that does not — the filesystem, Kubernetes, the general case — omits it entirely and
still satisfies the contract in full. penv never calls `readPrevious` without first
narrowing through `retainsPrevious`, because retention is *declared*, not assumed: a
`dual-valid` rotation refuses a non-retaining provider up front, at the one place penv
asks, rather than discovering the gap at the moment it reaches for a previous value.

### Why retention *policy* is deliberately absent

The capability is "give me the previous value" and nothing more. There is no TTL, no
version count, no window — and their absence is the whole design, not an omission to
be filled in later. Retention policy does not survive the crossing between providers:

- **Vault KV v2** retains natively and expires versions on a **time** TTL
  (`delete_version_after`), with `max_versions` defaulting to 10.
- **AWS SSM** retains too, but caps at a fixed **count** of 100 versions, not
  configurable, oldest silently pruned, with no TTL of any kind.
- **Kubernetes Secrets** retain **nothing** — no version history, no rollback, no
  revision store, by design.

Present-with-a-TTL, present-with-a-count-cap, and absent. A mandatory verb shaped on
any one of those is unsatisfiable by the others, so the contract asks for none of
them. The only portable shape is the read itself. The RFC records this finding — and
the fact that it was found by reading three providers' documentation rather than by
building three adapters — under
[Previous-value retention is a declared capability, not a universal verb](./RFC.md#previous-value-retention-is-a-declared-capability-not-a-universal-verb).

The correct mental model is that **a non-retaining provider is the general case, not
an exception to patch over.** The filesystem and Kubernetes sit on the same side of
that line, and dual validity is a property of a live system rather than a filesystem
quirk. A provider declares retention; `doctor` reports what a non-retaining one
cannot do, rather than letting a team discover it mid-rotation.

### penv owns the clock; the provider is only ever asked

penv owns the grace-window clock — `rotatingSince`, kept in meta. A provider is
**never** asked to enforce a window; it is only ever asked to answer, and it must be
free to answer `undefined`. This is not a courtesy — it is forced. Provider pruning is
counted (Vault's ten versions, SSM's hundred) and penv's window is timed, and the two
do not commute: a parameter written past the provider's cap inside a grace window has
already lost the version penv meant to keep. So `readPrevious` resolves to `undefined`
whenever the provider no longer holds the previous value, and that is a legitimate,
expected answer.

What it is *not* is a silent success. A rotation that cannot find its previous value
is a **`doctor` failure**, on exactly the rule the encryption check already follows
for a sealed value penv cannot open: the absence is surfaced and named, never swallowed.
The provider's job ends at answering honestly; deciding what a missing previous value
means is penv's, and penv decides it out loud.

Vault's implementation is the reference: `readPrevious` reads the version below the
current one and returns `undefined` when there is no prior version or when Vault has
already pruned it. It never treats a pruned version as an error — it answers `no`, and
lets `doctor` decide.

---

## The acceptance test

There is one behavioural suite, `runProviderContractSuite`, exported from
[`@penvhq/provider-contract`](../packages/providers/contract/src/contract.ts):

```ts
export function runProviderContractSuite(
  name: string,
  makeProvider: () => Promise<{ provider: Provider; cleanup: () => Promise<void> }>,
): void
```

A provider package points `makeProvider` at a fresh, empty instance that accepts the
environments `development` and `production`, and the suite does the rest. The
filesystem provider, the in-memory fixture that ships alongside the suite, and the
Vault adapter all pass **the same suite, unchanged**. That identity is the portability
claim made concrete: "portable" means precisely "passes this suite without the suite
knowing which provider it is running," and the suite is deliberately filesystem-free —
no paths, no `node:fs`, no on-disk assumptions, no `list()` ordering — so that it can
mean that.

The rule that gives the suite its authority: **a suite edit made to accommodate a
provider is a design finding, not a fix.** If a real provider cannot pass the suite as
written, that is the contract bending — a fact about the contract to be surfaced and
decided, at the level of the RFC and roadmap — and not a test to quietly loosen. The
one bend already found (retention is not portable) was taken this way, up front and on
purpose, before any adapter was written. The [v0.5 plan §3](./v0.5-plan.md#step-3--relocate-the-contract-suite-so-a-sibling-provider-can-consume-it)
states the constraint in the same terms: "If Vault forces a change to the suite, that
is a finding about the contract, surfaced and decided, not a quiet accommodation." The
[v0.6 gate](./Roadmap.md#v06--second-and-third-providers) holds SSM and Kubernetes to
the same line — they satisfy the existing contract unchanged, or a bend reopens v0.5.

The retention section runs only against providers that declare the capability, via
`retainsPrevious`. A non-retaining provider is not failed for omitting `readPrevious`;
it is a provider of the general kind, and the suite treats it as one.

---

## For a future adapter

If you are writing the SSM adapter, the Kubernetes adapter, or a provider against the
v1.0 SDK, the whole job is:

1. Implement the seven required methods as a translation between `@penvhq/core`'s
   types and your store, changing the types for nobody.
2. Honour every invariant above — absence is success, values are opaque bytes, meta is
   a plaintext sibling record excluded from `list()`, every scope-and-encryption
   combination is its own address, and environment-bearing scopes key on their
   environment.
3. Implement `readPrevious` **only if** your store genuinely retains previous values,
   and let it answer `undefined` freely when it does not still hold one. If your store
   retains nothing — as Kubernetes does not — omit the method and declare no retention.
   That is the contract working, not the contract failing.
4. Run `runProviderContractSuite` against a fresh instance. If it passes unchanged, you
   have a provider. If it does not pass, fix the provider. If it *cannot* pass without
   editing the suite, stop — you have found something about the contract, and that is a
   decision to raise, not a test to edit.

The reference implementations to read alongside this document are the filesystem
provider
([`packages/providers/filesystem/src/filesystem.ts`](../packages/providers/filesystem/src/filesystem.ts)),
which is the ground truth, and the Vault provider
([`packages/providers/vault/src/vault.ts`](../packages/providers/vault/src/vault.ts)),
which is the first network-backed adapter and the first `RetainingProvider`.
