/**
 * This package's `penv.config.ts` shape — the file `penv.types` names, which
 * `penv add` copies verbatim into the project as a committed declaration.
 *
 * It lands in a repository where this package is not installed, so it names no
 * module but `@penvhq/core`, the interface it augments. Declaring the shape is
 * what makes a key this provider never reads a compile error: the open base
 * shape it would otherwise get carries an index signature that accepts any.
 */

export {};

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-kubernetes": {
      /** The Secret penv maps the whole tree onto. Defaults to `penv`. */
      readonly secret?: string;
      /**
       * The cluster namespace that Secret lives in. Defaults to the current
       * `kubectl` context's namespace, which is the one a config can reach
       * without naming the cluster it is running against.
       */
      readonly namespace?: string;
    };
  }
}
