/**
 * The public surface of `@penvhq/sink-github`.
 *
 * A GitHub Actions Secrets sink and the name pre-flight a push runs before it.
 * Everything GitHub-specific lives here; core stays destination-agnostic.
 */

export type {
  GithubNameReason,
  GithubUnavailableReason,
} from "./errors.js";
export { GithubNameError, GithubUnavailableError } from "./errors.js";
export type { GhRunner, GithubSinkOptions } from "./github.js";
export { createGithubSink, defaultGhRunner, GhInvocationError, GithubSink } from "./github.js";
export { checkGithubNames } from "./names.js";
