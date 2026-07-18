/**
 * The Kubernetes Secrets provider — the third portability proof: an environment
 * flips to `kubernetes` with zero application edits, and declares no retention
 * rather than forcing the contract to accommodate its absence.
 *
 * The contract suite is not re-exported here (it imports vitest at module scope);
 * it lives in `@penvhq/provider-contract` and is consumed from this package's test
 * files. `encodeKey`/`decodeKey` are exported so the flattening can be tested — and
 * reasoned about — directly.
 */

export type { KubernetesUnavailableReason } from "./errors.js";
export { KubernetesUnavailableError } from "./errors.js";
export type { KubernetesProviderOptions, KubernetesTransport } from "./kubernetes.js";
export {
  createKubernetesProvider,
  decodeKey,
  encodeKey,
  KubernetesProvider,
} from "./kubernetes.js";
export type { DefaultKubernetesTransportOptions, KubectlRunner } from "./transport.js";
export {
  defaultKubectlRunner,
  defaultKubernetesTransport,
  KubectlInvocationError,
} from "./transport.js";
