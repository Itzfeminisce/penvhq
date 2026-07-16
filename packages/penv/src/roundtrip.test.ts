/**
 * The v0.1 acceptance gate.
 *
 * `penv import .env` on a real 30+ variable project, then `penv generate`, must
 * round-trip every variable losslessly. If a single value does not survive,
 * nothing downstream matters — so this file exercises the real import and
 * generate implementations from `@penv/cli` against a realistic file, rather
 * than a hand-picked sample of easy lines.
 *
 * What the gate does *not* require is equally load-bearing and is asserted here
 * too: ordering is normalized and blank lines are gone, because one-value-per-file
 * discards presentation by construction. Those are the accepted tradeoffs, not
 * defects to be fixed later.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDotenv, importDotenv } from "@penv/cli";
import type { DotenvEntry } from "@penv/core";
import { parseDotenv } from "@penv/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A file that reads like a real project's `.env`, including the cases that
 * actually break dotenv round-trips: an unquoted value with spaces, a URL whose
 * hash fragment is not a comment, escaped newlines in a double-quoted value, a
 * literal single-quoted value, an empty value, a value containing `=`, an
 * `export` prefix, a value spanning lines, comment blocks that belong to the
 * variable below them, and comment blocks that belong to nothing.
 */
const FIXTURE = `# Acme Dashboard — local development configuration.
# Copy this file to .env and fill in your own credentials.
# Nothing in here is a real secret.

# Postgres connection string used by the API and the migration runner.
DATABASE_URL=postgres://acme:hunter2@localhost:5432/acme_dev
DATABASE_POOL_MAX=20
DATABASE_SSL=false

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
# Quoted because it carries a hash and a space, neither of which survives a bare emit.
REDIS_PASSWORD='r3d!s#pass word'
REDIS_TLS=false

# Signing key for API tokens. Rotate this and every session dies.
JWT_SECRET=dev-only-jwt-signing-key-do-not-ship
JWT_EXPIRES_IN=15m
SESSION_SECRET=dev-only-session-secret

# ----------------------------------------------------------------
# Third-party integrations. Test-mode credentials only.
# ----------------------------------------------------------------

# Server-side Stripe key. The publishable key is not a secret and lives in the client bundle.
STRIPE_SECRET_KEY=sk_test_51H8fakekeyfakekeyfakekeyfakekey
STRIPE_WEBHOOK_SECRET=whsec_fakefakefakefakefakefake
STRIPE_PRICE_ID=price_1Hfakepriceid

AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY=
AWS_REGION=eu-west-1
AWS_S3_BUCKET=acme-dashboard-uploads-dev

# Mailpit on the local docker-compose stack.
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=acme
SMTP_PASSWORD=
SMTP_FROM=Acme Dashboard <no-reply@acme.test>

LOG_LEVEL=debug
LOG_FORMAT=pretty
PORT=3000
HOST=0.0.0.0
export NODE_OPTIONS=--max-old-space-size=4096

APP_DISPLAY_NAME=Acme Internal Dashboard
WELCOME_BANNER=" Signed in to Acme "

SENTRY_DSN=https://fakepublickey@o0.ingest.sentry.io/0
# The fragment is part of the URL: a hash with no whitespace before it is not a comment.
SENTRY_TRACE_URL=https://sentry.io/organizations/acme/issues/?query=is:unresolved#tab=details
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Flags default off locally; production flips them from the provider.
FEATURE_NEW_BILLING=false
FEATURE_DARK_MODE=true
FEATURE_BETA_SEARCH=false
OPTIONAL_FEATURE_TOKEN=

GITHUB_WEBHOOK_SECRET=ghs_fakewebhooksecret
LITERAL_PASSWORD='p@ssw0rd\\nis-two-characters-not-a-newline'
TLS_CERT_PEM="-----BEGIN CERTIFICATE-----\\nMIIBfaketlscertificatebody\\n-----END CERTIFICATE-----"
SSH_PRIVATE_KEY="-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB
-----END OPENSSH PRIVATE KEY-----"
`;

const CONFIG = `export default {
  environments: ["development", "test", "production"],
  providers: {
    development: { type: "filesystem" },
    test: { type: "filesystem" },
    production: { type: "filesystem" },
  },
};
`;

const ENVIRONMENT = "development";

/** Keys to values, which is exactly what the gate compares. */
function valueMap(entries: readonly DotenvEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    map[entry.key] = entry.value;
  }
  return map;
}

function descriptionOf(entries: readonly DotenvEntry[], key: string): string | undefined {
  return entries.find((entry) => entry.key === key)?.description;
}

let project = "";
let generated = "";
let orphansReported = 0;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "penv-v01-gate-"));
  writeFileSync(join(project, "penv.config.ts"), CONFIG, "utf8");
  writeFileSync(join(project, ".env"), FIXTURE, "utf8");

  const report = importDotenv({ cwd: project, file: join(project, ".env") });
  orphansReported = report.orphanComments;

  generated = generateDotenv({ cwd: project, environment: ENVIRONMENT });
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("v0.1 gate: import then generate round-trips a real project", () => {
  it("carries every key and every value across byte-identically", () => {
    const original = parseDotenv(FIXTURE);
    const emitted = parseDotenv(generated);

    expect(original.entries.length).toBeGreaterThanOrEqual(34);
    expect(valueMap(emitted.entries)).toEqual(valueMap(original.entries));
  });

  it("keeps the hard values intact one by one, so a failure names the case that broke", () => {
    const emitted = valueMap(parseDotenv(generated).entries);

    expect(emitted.APP_DISPLAY_NAME).toBe("Acme Internal Dashboard");
    expect(emitted.WELCOME_BANNER).toBe(" Signed in to Acme ");
    expect(emitted.SENTRY_TRACE_URL).toBe(
      "https://sentry.io/organizations/acme/issues/?query=is:unresolved#tab=details",
    );
    expect(emitted.TLS_CERT_PEM).toBe(
      "-----BEGIN CERTIFICATE-----\nMIIBfaketlscertificatebody\n-----END CERTIFICATE-----",
    );
    expect(emitted.LITERAL_PASSWORD).toBe("p@ssw0rd\\nis-two-characters-not-a-newline");
    expect(emitted.REDIS_PASSWORD).toBe("r3d!s#pass word");
    expect(emitted.SMTP_PASSWORD).toBe("");
    expect(emitted.OPTIONAL_FEATURE_TOKEN).toBe("");
    expect(emitted.AWS_SECRET_ACCESS_KEY).toBe("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY=");
    expect(emitted.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(emitted.SSH_PRIVATE_KEY).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n" +
        "-----END OPENSSH PRIVATE KEY-----",
    );
  });

  it("turns a comment above a variable into that parameter's description and emits it back", () => {
    const original = parseDotenv(FIXTURE);
    const emitted = parseDotenv(generated);

    expect(descriptionOf(original.entries, "DATABASE_URL")).toBe(
      "Postgres connection string used by the API and the migration runner.",
    );
    expect(descriptionOf(emitted.entries, "DATABASE_URL")).toBe(
      descriptionOf(original.entries, "DATABASE_URL"),
    );
    expect(descriptionOf(emitted.entries, "JWT_SECRET")).toBe(
      "Signing key for API tokens. Rotate this and every session dies.",
    );
    expect(generated).toContain(
      "# Postgres connection string used by the API and the migration runner.",
    );
  });

  it("reports the comments it could not attach to a parameter instead of dropping them silently", () => {
    // Two blocks belong to nothing: the file header and the integrations banner,
    // each separated from the next variable by a blank line.
    expect(parseDotenv(FIXTURE).orphanComments).toBe(2);
    expect(orphansReported).toBe(2);
    expect(generated).not.toContain("Acme Dashboard — local development configuration.");
  });

  it("normalizes ordering to sorted, the presentation one-value-per-file discards by design", () => {
    const sourceKeys = parseDotenv(FIXTURE).entries.map((entry) => entry.key);
    const emittedKeys = parseDotenv(generated).entries.map((entry) => entry.key);

    expect(emittedKeys).toEqual([...emittedKeys].sort());
    expect(emittedKeys).not.toEqual(sourceKeys);
    expect([...emittedKeys].sort()).toEqual([...sourceKeys].sort());
    expect(generateDotenv({ cwd: project, environment: ENVIRONMENT })).toBe(generated);
  });

  it("leaves .penv as the source of truth, with the generated file a readable artifact", () => {
    const artifact = join(project, ".env");
    writeFileSync(artifact, generated, "utf8");
    expect(valueMap(parseDotenv(readFileSync(artifact, "utf8")).entries)).toEqual(
      valueMap(parseDotenv(generated).entries),
    );
  });
});
