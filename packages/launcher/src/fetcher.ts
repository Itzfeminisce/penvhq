/**
 * Every byte penv downloads comes through here.
 *
 * One method, so the test suite hands the store a fake and the whole launcher
 * runs with no network at all — and so the "CI never downloads" guarantee is a
 * property of one call site rather than of every place a URL is built.
 */

export interface Fetcher {
  /** The bytes at `url`, or a thrown error saying what the registry did. */
  get(url: string): Promise<Uint8Array>;
}

/** The real one: `fetch`, and a thrown error for anything that is not 200. */
export function httpFetcher(): Fetcher {
  return {
    async get(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`the registry answered ${response.status} ${response.statusText}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
