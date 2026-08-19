/**
 * The default {@link VercelTransport}: a thin boundary over `fetch` against
 * `https://api.vercel.com`.
 *
 * Unlike the Vault and GitHub adapters there is no vendor CLI to hold the
 * credential, so penv carries the token itself — as the ambient `VERCEL_TOKEN`
 * this package declares in `penv.credentials`, never as a config field and never
 * in the manifest. The transport only performs the call and parses the body;
 * every status is the provider's to interpret, so the refusals stay in one place.
 */

import { VercelUnavailableError } from "./errors.js";

/** Vercel's REST API root. https://vercel.com/docs/rest-api */
export const VERCEL_API_BASE = "https://api.vercel.com";

/** The variable the access token arrives in. Declared in this package's `penv.credentials`. */
export const TOKEN_VARIABLE = "VERCEL_TOKEN";

export interface VercelRequest {
  readonly method: "GET" | "POST";
  /** Absolute API path, version prefix included — `/v10/projects/prj_x/env`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON when present. */
  readonly body?: unknown;
}

export interface VercelResponse {
  readonly status: number;
  /** Header names lower-cased, so the provider reads one spelling. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON body, or `undefined` when there was none. */
  readonly body: unknown;
}

/** One Vercel API call. Injectable so the provider is testable with zero network. */
export type VercelTransport = (request: VercelRequest) => Promise<VercelResponse>;

function missingToken(): VercelUnavailableError {
  return new VercelUnavailableError(
    "no-token",
    `penv found no \`${TOKEN_VARIABLE}\` to authenticate to Vercel with`,
    `Create an access token at https://vercel.com/account/tokens and export it as ` +
      `\`${TOKEN_VARIABLE}\`. penv reads it from the environment — it is never written into ` +
      "penv.config.ts and never recorded in the manifest.",
  );
}

function unreachable(cause: unknown): VercelUnavailableError {
  return new VercelUnavailableError(
    "request-failed",
    "penv could not reach the Vercel API",
    `Check your network and that https://api.vercel.com is reachable, then try again.\n  ` +
      `the request failed with: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

export interface DefaultVercelTransportOptions {
  /** The access token. Defaults to reading `VERCEL_TOKEN` from the environment. */
  readonly token?: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export function defaultVercelTransport(
  options: DefaultVercelTransportOptions = {},
): VercelTransport {
  const call = options.fetch ?? globalThis.fetch;

  return async (request) => {
    const token = options.token ?? process.env[TOKEN_VARIABLE];
    if (token === undefined || token.trim() === "") {
      throw missingToken();
    }

    const url = new URL(`${VERCEL_API_BASE}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(name, value);
    }

    let response: Response;
    try {
      response = await call(url.toString(), {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (cause) {
      throw unreachable(cause);
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      // A non-JSON body is not a parse failure to report on its own — the status
      // decides the refusal, and the raw text is all the detail there is.
      body = { error: { message: text } };
    }

    return { status: response.status, headers, body };
  };
}
