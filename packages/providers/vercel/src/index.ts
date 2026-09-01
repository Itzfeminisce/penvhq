/**
 * The public surface of `@penvhq/provider-vercel`.
 *
 * The Vercel project environment-variable provider — a projection-holding,
 * value-withholding destination — and the name pre-flight a push runs before it.
 * Everything Vercel-specific lives here; core stays destination-agnostic.
 */

export type {
  VercelNameReason,
  VercelTargetReason,
  VercelUnavailableReason,
} from "./errors.js";
export { VercelNameError, VercelTargetError, VercelUnavailableError } from "./errors.js";
export { penvProviderFactory } from "./factory.js";
export { checkVercelNames } from "./names.js";
export type {
  DefaultVercelTransportOptions,
  VercelRequest,
  VercelResponse,
  VercelTransport,
} from "./transport.js";
export { defaultVercelTransport, TOKEN_VARIABLE, VERCEL_API_BASE } from "./transport.js";
export type { VercelProviderOptions, VercelTarget } from "./vercel.js";
export { createVercelProvider, resolveTarget, VERCEL_TARGETS, VercelProvider } from "./vercel.js";
