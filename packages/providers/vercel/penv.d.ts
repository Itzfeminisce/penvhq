/**
 * This package's `penv.config.ts` shape — the file `penv.types` names, which
 * `penv add` copies verbatim into the project as a committed declaration.
 *
 * It lands in a repository where this package is not installed, so it names no
 * module but `@penvhq/core`, the interface it augments: every type it needs is
 * written out here, including the three targets Vercel accepts. Without that a
 * config gets the open base shape, whose index signature accepts a misspelled
 * target and a target keyed by an environment that does not exist.
 */

export {};

declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@penvhq/provider-vercel": {
      /** The Vercel project penv writes into — its id (`prj_…`) or its name. */
      readonly location: string;
      /**
       * Which Vercel target each environment deploys to, keyed by penv
       * environment. penv never guesses this: choosing between production,
       * preview and development is choosing which deployment reads a secret.
       */
      readonly targets: Readonly<Record<string, "production" | "preview" | "development">>;
      /** The team owning the project. Only an account-wide token needs to name one. */
      readonly teamId?: string;
    };
  }
}
