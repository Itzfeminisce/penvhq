import { describe, expect, it } from "vitest";
import { type DotenvEntry, parseDotenv, serializeDotenv } from "./dotenv.js";

/**
 * A realistic 30+ variable `.env` — the v0.1 gate's subject. It covers bare,
 * double-quoted, single-quoted, spaced, empty, a URL with a hash fragment, a
 * multi-line value, escapes, an `export` prefix, and a duplicate key.
 */
const realWorldEnv = [
  "# Acme API — local development environment",
  "# Copy from .env.example and fill in the blanks.",
  "",
  "NODE_ENV=development",
  "PORT=3000",
  "HOST=0.0.0.0",
  "",
  "# Primary Postgres connection",
  "# Rotate with the platform team.",
  "DATABASE_URL=postgres://acme:hunter2@localhost:5432/acme_dev",
  "DATABASE_POOL_MIN=2",
  "DATABASE_POOL_MAX=10",
  "DATABASE_SSL=false",
  "",
  "# Redis is optional locally",
  "REDIS_URL=redis://localhost:6379",
  "REDIS_PASSWORD=",
  "",
  "# Signs and verifies user session JWTs",
  'JWT_SECRET="s3cr3t-with spaces-and-#-hash"',
  "JWT_ISSUER=acme.dev",
  "JWT_TTL=  900  # seconds, trimmed by the parser",
  "",
  "# The docs anchor keeps its fragment: no whitespace before the hash",
  "DOCS_URL=https://docs.acme.dev/config#environment-variables",
  "OAUTH_CALLBACK=http://localhost:3000/auth/callback#done",
  "",
  "STRIPE_KEY='sk_test_$literal\\n_not_an_escape'",
  "STRIPE_WEBHOOK_SECRET='whsec_#hash_inside_single_quotes'",
  'SENDGRID_TEMPLATE="line one\\nline two\\ttabbed"',
  'WINDOWS_PATH="C:\\\\Users\\\\acme\\\\app"',
  'QUOTED_QUOTE="she said \\"hello\\""',
  "APOSTROPHE=it's fine unquoted",
  "",
  "# A PEM key spanning lines, single-quoted so nothing is interpreted",
  "PUBLIC_KEY='-----BEGIN PUBLIC KEY-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A",
  "-----END PUBLIC KEY-----'",
  "",
  'BANNER="Welcome to Acme',
  'Line two of the banner"',
  "",
  "export AWS_REGION=us-east-1",
  "export AWS_PROFILE=acme-dev",
  "  export LEADING_WHITESPACE=indented",
  "SPACED_EQUALS  =  padded",
  'PADDED_VALUE="  keep my padding  "',
  "",
  "# Comment orphaned by the blank line below it",
  "",
  "FEATURE_FLAGS=a,b,c",
  "EMPTY_STRING=",
  'EMPTY_QUOTED=""',
  "LOG_LEVEL=debug",
  "LOG_LEVEL=trace",
  "SENTRY_DSN=https://abc123@o0.ingest.sentry.io/1",
  "MAX_UPLOAD_MB=25",
  "TIMEZONE=Europe/London",
].join("\n");

function keys(entries: readonly DotenvEntry[]): string[] {
  return entries.map((e) => e.key);
}

describe("parseDotenv", () => {
  it("reads bare, quoted, spaced, empty and export-prefixed assignments", () => {
    const { entries } = parseDotenv(realWorldEnv);
    const byKey = new Map(entries.map((e) => [e.key, e.value]));

    expect(byKey.get("NODE_ENV")).toBe("development");
    expect(byKey.get("REDIS_PASSWORD")).toBe("");
    expect(byKey.get("EMPTY_STRING")).toBe("");
    expect(byKey.get("EMPTY_QUOTED")).toBe("");
    expect(byKey.get("AWS_REGION")).toBe("us-east-1");
    expect(byKey.get("LEADING_WHITESPACE")).toBe("indented");
    expect(byKey.get("SPACED_EQUALS")).toBe("padded");
    expect(byKey.get("PADDED_VALUE")).toBe("  keep my padding  ");
    expect(byKey.get("APOSTROPHE")).toBe("it's fine unquoted");
    expect(byKey.get("FEATURE_FLAGS")).toBe("a,b,c");
  });

  it("covers 30+ variables, one entry per key", () => {
    const { entries } = parseDotenv(realWorldEnv);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(new Set(keys(entries)).size).toBe(entries.length);
  });

  it("keeps inner whitespace and trims the outside of an unquoted value", () => {
    const { entries } = parseDotenv("GREETING=   hello   there   \n");
    expect(entries[0]?.value).toBe("hello   there");
  });

  it("ignores blank lines and unparseable lines without inventing entries", () => {
    const { entries } = parseDotenv("\n\nthis is not an assignment\n\nA=1\n");
    expect(keys(entries)).toEqual(["A"]);
  });

  it("reads a value on the final line with no trailing newline", () => {
    const { entries } = parseDotenv("A=1\nB=last");
    expect(entries[1]).toEqual({ key: "B", value: "last" });
  });
});

describe("inline comments", () => {
  it("strips a hash preceded by whitespace", () => {
    const { entries } = parseDotenv("JWT_TTL=  900  # seconds\n");
    expect(entries[0]?.value).toBe("900");
  });

  it("keeps a hash with no whitespace before it, as in a URL fragment", () => {
    const { entries } = parseDotenv(
      "DOCS_URL=https://docs.acme.dev/config#environment-variables\n",
    );
    expect(entries[0]?.value).toBe("https://docs.acme.dev/config#environment-variables");
  });

  it("does not strip a hash inside a double-quoted value", () => {
    const { entries } = parseDotenv('JWT_SECRET="s3cr3t with # hash"\n');
    expect(entries[0]?.value).toBe("s3cr3t with # hash");
  });

  it("does not strip a hash inside a single-quoted value", () => {
    const { entries } = parseDotenv("SECRET='whsec_# hash inside'\n");
    expect(entries[0]?.value).toBe("whsec_# hash inside");
  });

  it("treats a value that is only an inline comment as empty", () => {
    const { entries } = parseDotenv("KEY= # nothing here\n");
    expect(entries[0]?.value).toBe("");
  });
});

describe("quoting semantics", () => {
  it("processes escapes inside double quotes", () => {
    const { entries } = parseDotenv('A="line one\\nline two\\ttabbed\\r\\\\ \\"quoted\\""\n');
    expect(entries[0]?.value).toBe('line one\nline two\ttabbed\r\\ "quoted"');
  });

  it("leaves an unknown escape sequence alone inside double quotes", () => {
    const { entries } = parseDotenv('A="keep \\d as written"\n');
    expect(entries[0]?.value).toBe("keep \\d as written");
  });

  it("processes no escapes at all inside single quotes", () => {
    const { entries } = parseDotenv("A='literal \\n and \\\\ and $NOT_INTERPOLATED'\n");
    expect(entries[0]?.value).toBe("literal \\n and \\\\ and $NOT_INTERPOLATED");
  });

  it("allows multi-line double-quoted and single-quoted values", () => {
    const { entries } = parseDotenv("A=\"one\ntwo\"\nB='three\nfour'\nC=after\n");
    expect(entries[0]?.value).toBe("one\ntwo");
    expect(entries[1]?.value).toBe("three\nfour");
    expect(entries[2]?.value).toBe("after");
  });

  it("treats an unterminated quote as an ordinary character on one line", () => {
    const { entries } = parseDotenv('A="oops\nB=2\n');
    expect(entries[0]?.value).toBe('"oops');
    expect(entries[1]?.value).toBe("2");
  });
});

describe("diagnostics", () => {
  it("says nothing about a healthy file", () => {
    expect(parseDotenv(realWorldEnv).diagnostics).toEqual([]);
    expect(parseDotenv("A=1\nB='two'\nC=\"three\"\n").diagnostics).toEqual([]);
  });

  it("reports the assignment a value swallowed, without changing what it parsed", () => {
    const { entries, diagnostics } = parseDotenv('A="oops\nB="x"\nC=3\n');

    // Semantics are dotenv's and stay dotenv's: A really does span to B's quote.
    expect(entries[0]).toEqual({ key: "A", value: "oops\nB=" });
    expect(keys(entries)).toEqual(["A", "C"]);

    const swallow = diagnostics.find((d) => d.kind === "value-spans-lines");
    expect(swallow?.key).toBe("A");
    expect(swallow?.line).toBe(1);
    expect(swallow?.detail).toContain("B");
    expect(swallow?.detail).toContain("unclosed");
  });

  it("keeps the swallowed value's round trip intact", () => {
    const first = parseDotenv('A="oops\nB="x"\nC=3\n');
    const second = parseDotenv(serializeDotenv(first.entries));
    expect(second.entries).toEqual(first.entries);
  });

  it("stays quiet on a genuine multi-line PEM value", () => {
    const pem = [
      "PUBLIC_KEY='-----BEGIN PUBLIC KEY-----",
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1x",
      "kWaQpUuXm7Zr9wYt3NfVc2Hs5Lp0Qd8Jb6Rg4Tz1AoIBAQ=",
      "-----END PUBLIC KEY-----'",
      "NEXT=fine",
    ].join("\n");
    const { entries, diagnostics } = parseDotenv(pem);

    expect(diagnostics).toEqual([]);
    expect(entries[0]?.value).toContain("BEGIN PUBLIC KEY");
    expect(entries[1]).toEqual({ key: "NEXT", value: "fine" });
  });

  it("stays quiet on a genuine multi-line JSON value", () => {
    const json = ["SERVICE_ACCOUNT='{", '  "type": "service_account",', '  "id": 42', "}'"].join(
      "\n",
    );
    const { entries, diagnostics } = parseDotenv(json);

    expect(diagnostics).toEqual([]);
    expect(entries[0]?.value).toBe('{\n  "type": "service_account",\n  "id": 42\n}');
  });

  it("stays quiet on a multi-line value whose inner lines look like assignments", () => {
    // An ini blob's `key=value` lines have their value after the equals sign, so the
    // rule must not mistake them for a variable this value ate.
    const { entries, diagnostics } = parseDotenv("CONFIG='[db]\nhost=localhost\nport=5432'\n");
    expect(diagnostics).toEqual([]);
    expect(entries[0]?.value).toBe("[db]\nhost=localhost\nport=5432");
  });

  it("stays quiet on an unterminated quote, which never spans lines", () => {
    expect(parseDotenv('A="oops\nB=2\n').diagnostics).toEqual([]);
  });

  it("reports characters dropped after a closing quote", () => {
    const { entries, diagnostics } = parseDotenv("A='it's\n");

    expect(entries[0]).toEqual({ key: "A", value: "it" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.kind).toBe("trailing-characters-after-quote");
    expect(diagnostics[0]?.key).toBe("A");
    expect(diagnostics[0]?.line).toBe(1);
    expect(diagnostics[0]?.detail).toContain('"s"');
  });

  it("points at the closing quote's line, not the assignment's", () => {
    const { diagnostics } = parseDotenv('A="one\ntwo" dropped\n');
    expect(diagnostics[0]?.line).toBe(2);
  });

  it("does not mistake an inline comment for dropped characters", () => {
    expect(parseDotenv("A=\"x\" # a note\nB='y'  # another\n").diagnostics).toEqual([]);
  });
});

describe("descriptions and orphan comments", () => {
  it("attaches a contiguous comment block directly above a key", () => {
    const { entries, orphanComments } = parseDotenv(
      "# Signs and verifies user session JWTs\n# Rotate every 90 days.\nJWT_SECRET=abc\n",
    );
    expect(entries[0]?.description).toBe(
      "Signs and verifies user session JWTs\nRotate every 90 days.",
    );
    expect(orphanComments).toBe(0);
  });

  it("strips both `# ` and `#` markers and keeps deeper indentation", () => {
    const { entries } = parseDotenv("#no space\n#   indented\n#\nA=1\n");
    expect(entries[0]?.description).toBe("no space\n  indented\n");
  });

  it("counts a file header as an orphan", () => {
    const { entries, orphanComments } = parseDotenv("# Acme API config\n\nA=1\n");
    expect(orphanComments).toBe(1);
    expect(entries[0]?.description).toBeUndefined();
  });

  it("counts a comment separated from the next key by a blank line", () => {
    const { orphanComments } = parseDotenv("A=1\n# orphaned\n\nB=2\n");
    expect(orphanComments).toBe(1);
  });

  it("counts a trailing comment block at end of file", () => {
    const { orphanComments } = parseDotenv("A=1\n\n# nothing follows me\n");
    expect(orphanComments).toBe(1);
  });

  it("counts an orphan block once, not once per line", () => {
    const { orphanComments } = parseDotenv("# one\n# two\n# three\n\nA=1\n");
    expect(orphanComments).toBe(1);
  });

  it("does not count an attached comment as an orphan", () => {
    const { orphanComments } = parseDotenv("# attached\nA=1\n");
    expect(orphanComments).toBe(0);
  });

  it("counts the header and the blank-separated block in the real-world file", () => {
    expect(parseDotenv(realWorldEnv).orphanComments).toBe(2);
  });
});

describe("duplicate keys", () => {
  it("lets the later duplicate win without double-counting the key", () => {
    const { entries } = parseDotenv("LOG_LEVEL=debug\nA=1\nLOG_LEVEL=trace\n");
    expect(keys(entries)).toEqual(["LOG_LEVEL", "A"]);
    expect(entries[0]?.value).toBe("trace");
  });

  it("takes the later duplicate's description too", () => {
    const { entries } = parseDotenv("# first\nA=1\n# second\nA=2\n");
    expect(entries).toEqual([{ key: "A", value: "2", description: "second" }]);
  });

  it("keeps one LOG_LEVEL, set to the last value, in the real-world file", () => {
    const { entries } = parseDotenv(realWorldEnv);
    const found = entries.filter((e) => e.key === "LOG_LEVEL");
    expect(found).toEqual([{ key: "LOG_LEVEL", value: "trace" }]);
  });
});

describe("serializeDotenv", () => {
  it("emits a safe value bare and ends the file with a newline", () => {
    expect(serializeDotenv([{ key: "A", value: "1" }])).toBe("A=1\n");
  });

  it("emits an empty value bare", () => {
    expect(serializeDotenv([{ key: "A", value: "" }])).toBe("A=\n");
  });

  it("quotes only when the value needs it", () => {
    const out = serializeDotenv([
      { key: "BARE", value: "hello-world" },
      { key: "INNER_SPACE", value: "hello world" },
      { key: "URL_FRAGMENT", value: "https://x.dev/a#b" },
      { key: "PADDED", value: " pad " },
      { key: "NEWLINE", value: "a\nb" },
      { key: "DQUOTE", value: 'say "hi"' },
      { key: "SQUOTE", value: "it's" },
      { key: "BACKSLASH", value: "C:\\acme" },
    ]);
    expect(out).toBe(
      [
        "BARE=hello-world",
        "INNER_SPACE=hello world",
        'URL_FRAGMENT="https://x.dev/a#b"',
        'PADDED=" pad "',
        'NEWLINE="a\\nb"',
        'DQUOTE="say \\"hi\\""',
        `SQUOTE="it's"`,
        "BACKSLASH=C:\\acme",
        "",
      ].join("\n"),
    );
  });

  it("emits the description as comment lines directly above the entry", () => {
    const out = serializeDotenv([
      { key: "A", value: "1", description: "First line\n\nThird line" },
      { key: "B", value: "2" },
    ]);
    expect(out).toBe("# First line\n#\n# Third line\nA=1\nB=2\n");
  });

  it("emits entries in the order given and never sorts", () => {
    const out = serializeDotenv([
      { key: "Z", value: "1" },
      { key: "A", value: "2" },
      { key: "M", value: "3" },
    ]);
    expect(out).toBe("Z=1\nA=2\nM=3\n");
  });

  it("emits nothing for no entries", () => {
    expect(serializeDotenv([])).toBe("");
  });
});

describe("the v0.1 round-trip gate", () => {
  it("preserves every key, value and description through parse → serialize → parse", () => {
    const first = parseDotenv(realWorldEnv);
    const second = parseDotenv(serializeDotenv(first.entries));

    expect(second.entries).toEqual(first.entries);
    expect(second.orphanComments).toBe(0);
  });

  it("stays fixed under a second round-trip", () => {
    const once = serializeDotenv(parseDotenv(realWorldEnv).entries);
    const twice = serializeDotenv(parseDotenv(once).entries);
    expect(twice).toBe(once);
  });

  it("round-trips losslessly after the caller sorts, as generate does", () => {
    const original = parseDotenv(realWorldEnv).entries;
    const sorted = [...original].sort((a, b) => a.key.localeCompare(b.key));
    const reparsed = parseDotenv(serializeDotenv(sorted)).entries;

    expect(reparsed).toEqual(sorted);
    expect(new Set(keys(reparsed))).toEqual(new Set(keys(original)));
  });

  it("round-trips awkward values one at a time", () => {
    const awkward: readonly DotenvEntry[] = [
      { key: "HASH_ONLY", value: "#" },
      { key: "SPACE_HASH", value: "a #b" },
      { key: "TRAILING_SPACE", value: "x " },
      { key: "ALL_WHITESPACE", value: "   " },
      { key: "BOTH_QUOTES", value: `mix "double" and 'single'` },
      { key: "CRLF", value: "a\r\nb" },
      { key: "TAB", value: "a\tb" },
      { key: "BACKSLASH_N_LITERAL", value: "a\\nb" },
      { key: "TRAILING_BACKSLASH", value: "a\\" },
      { key: "EQUALS_IN_VALUE", value: "a=b=c" },
      { key: "DOLLAR", value: "$NOT_INTERPOLATED" },
      { key: "EMPTY", value: "", description: "An empty value survives\nwith its comment" },
    ];

    expect(parseDotenv(serializeDotenv(awkward)).entries).toEqual(awkward);
  });
});
