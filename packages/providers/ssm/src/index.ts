/**
 * The AWS SSM Parameter Store provider — the second proof that a provider is
 * portable: an environment flips from `filesystem` (or `vault`) to `ssm` with zero
 * application edits.
 *
 * The contract suite is not re-exported here: it imports vitest at module scope,
 * so it lives in `@penvhq/provider-contract` and is consumed only from this
 * package's test files. The in-memory fake likewise stays in the tests — a
 * fixture, not shipped surface.
 */

export type { SsmUnavailableReason } from "./errors.js";
export { SsmUnavailableError } from "./errors.js";
export type { SsmProviderOptions, SsmTransport, SsmValue } from "./ssm.js";
export { createSsmProvider, SsmProvider } from "./ssm.js";
export type { AwsRunner, DefaultSsmTransportOptions } from "./transport.js";
export { AwsInvocationError, defaultAwsRunner, defaultSsmTransport } from "./transport.js";
