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
    "@penvhq/provider-vault": {
      /**
       * The KV v2 base path penv maps records onto, mount-relative —
       * `penv/staging`. Defaults to `penv`. The mount itself comes from
       * `VAULT_MOUNT` (default `secret`), because which mount to talk to is a
       * property of the Vault deployment, not of one project's config.
       */
      readonly location?: string;
    };
  }
}
