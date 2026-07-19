/**
 * The public surface of `@penvhq/provider-github`.
 *
 * The GitHub Actions Secrets provider — a projection-holding, value-withholding
 * store — and the name pre-flight a push runs before it. Everything
 * GitHub-specific lives here; core stays destination-agnostic.
 */

export type { GithubNameReason, GithubUnavailableReason } from "./errors.js";
export { GithubNameError, GithubUnavailableError } from "./errors.js";
export { penvProviderFactory } from "./factory.js";
export type { GhRunner, GithubProviderOptions } from "./github.js";
export {
  createGithubProvider,
  defaultGhRunner,
  GhInvocationError,
  GithubProvider,
} from "./github.js";
export { checkGithubNames } from "./names.js";
