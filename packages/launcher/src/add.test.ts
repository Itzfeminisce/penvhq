/**
 * The trust model, which is a model about who is asked what.
 *
 * The two tests that matter most are the two that must never fire together: an
 * official add reaches the end with the trust prompts never called, and a young
 * third-party add reaches the registry and stops. Everything between them is one
 * question — what did penv commit, and did a person actually say it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXTENSIONS_PATH,
  LOCAL_EXTENSIONS_PATH,
  MANIFEST_PATH,
  type Manifest,
  packageDir,
  serializeManifest,
} from "@penvhq/core";
import { afterEach, describe, expect, it } from "vitest";
import { type AddOptions, add } from "./add.js";
import type { Fetcher } from "./fetcher.js";
import { integrityOf } from "./integrity.js";
import type { LauncherIo } from "./io.js";
import { packTar, type TarSource } from "./tarball.fixtures.js";

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENGINE_INTEGRITY = integrityOf(new Uint8Array([1, 2, 3]));

/** `now` for every test: fixed, so "seven days" is a fact rather than a race. */
const NOW = new Date("2026-08-18T12:00:00.000Z");
const LONG_AGO = "2026-01-04T09:00:00.000Z";
const YESTERDAY = "2026-08-17T12:00:00.000Z";

interface PackageOptions {
  readonly name: string;
  readonly version: string;
  /** `penv.onboard` in the published package.json. */
  readonly onboard?: string;
  /** `penv.types`, plus the file it names. */
  readonly types?: { readonly file: string; readonly source: string };
}

function extensionTar(options: PackageOptions): Uint8Array {
  const penv = {
    ...(options.onboard === undefined ? {} : { onboard: options.onboard }),
    ...(options.types === undefined ? {} : { types: options.types.file }),
  };
  const sources: TarSource[] = [
    { path: "package/", typeflag: "5" },
    {
      path: "package/package.json",
      content: `${JSON.stringify({
        name: options.name,
        version: options.version,
        ...(Object.keys(penv).length === 0 ? {} : { penv }),
      })}\n`,
    },
    { path: "package/index.js", content: "export const penvProviderFactory = () => {};\n" },
  ];
  if (options.types !== undefined) {
    sources.push({ path: `package/${options.types.file}`, content: options.types.source });
  }
  return packTar(sources);
}

interface PackumentOptions extends PackageOptions {
  readonly integrity: string;
  readonly publishedAt: string;
  readonly publisher?: string;
  readonly attested?: boolean;
}

function packument(options: PackumentOptions): Uint8Array {
  const basename = options.name.slice(options.name.lastIndexOf("/") + 1);
  return new TextEncoder().encode(
    JSON.stringify({
      name: options.name,
      "dist-tags": { latest: options.version },
      time: { [options.version]: options.publishedAt },
      versions: {
        [options.version]: {
          name: options.name,
          version: options.version,
          ...(options.publisher === undefined ? {} : { _npmUser: { name: options.publisher } }),
          dist: {
            integrity: options.integrity,
            tarball: `https://registry.npmjs.org/${options.name}/-/${basename}-${options.version}.tgz`,
            ...(options.attested === true
              ? { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations" } }
              : {}),
          },
        },
      },
    }),
  );
}

const CONFIG = `import { defineConfig } from "@penvhq/penv";

export default defineConfig({
  environments: ["development", "production"],

  // One entry per environment: where that environment's values are read from.
  providers: {
    development: { type: "@penvhq/provider-filesystem" },
    production: { type: "@penvhq/provider-filesystem" },
  },
});
`;

const PACKAGE_JSON = `${JSON.stringify({ name: "acme-api", dependencies: { "@penvhq/penv": "0.9.0" } }, null, 2)}\n`;

function baseManifest(): Manifest {
  return {
    format: 1,
    engine: { package: "@penvhq/cli", version: "0.9.0", integrity: ENGINE_INTEGRITY },
    extensions: {},
  };
}

/** A project with a manifest, a package.json, and optionally a config. */
function projectAt(options: { config?: string } = {}): string {
  const root = scratch("penv-add-project-");
  const manifestFile = join(root, ...MANIFEST_PATH.split("/"));
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, serializeManifest(baseManifest()));
  writeFileSync(join(root, "package.json"), PACKAGE_JSON);
  if (options.config !== undefined) {
    writeFileSync(join(root, "penv.config.ts"), options.config);
  }
  return root;
}

interface Harness {
  readonly options: AddOptions;
  readonly root: string;
  readonly home: string;
  readonly out: string[];
  readonly asked: string[];
  readonly questions: string[];
}

function harness(overrides: {
  argv: readonly string[];
  root?: string;
  config?: string;
  serve?: Readonly<Record<string, Uint8Array>>;
  interactive?: boolean;
  consent?: boolean | readonly boolean[];
  answers?: readonly string[];
  now?: Date;
}): Harness {
  const root =
    overrides.root ??
    projectAt({ ...(overrides.config === undefined ? {} : { config: overrides.config }) });
  const home = scratch("penv-add-home-");
  const out: string[] = [];
  const asked: string[] = [];
  const questions: string[] = [];
  const consents = Array.isArray(overrides.consent) ? [...overrides.consent] : undefined;
  const answers = [...(overrides.answers ?? [])];

  const io: LauncherIo = {
    out: (line) => {
      out.push(line);
    },
    err: () => {},
    interactive: overrides.interactive ?? false,
    confirm: (question) => {
      questions.push(question);
      const next = consents?.shift();
      return Promise.resolve(next ?? (consents === undefined ? overrides.consent === true : false));
    },
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answers.shift() ?? "");
    },
  };

  const serve = overrides.serve ?? {};
  const fetcher: Fetcher = {
    get: (url) => {
      asked.push(url);
      const bytes = serve[url];
      return bytes === undefined
        ? Promise.reject(new Error("the registry answered 404 Not Found"))
        : Promise.resolve(bytes);
    },
  };

  return {
    root,
    home,
    out,
    asked,
    questions,
    options: {
      argv: overrides.argv,
      root,
      manifestFile: join(root, ...MANIFEST_PATH.split("/")),
      home,
      io,
      fetcher,
      now: () => overrides.now ?? NOW,
    },
  };
}

function manifestIn(root: string): unknown {
  return JSON.parse(readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8"));
}

function manifestTextIn(root: string): string {
  return readFileSync(join(root, ...MANIFEST_PATH.split("/")), "utf8");
}

function declarationIn(root: string, name: string): string {
  return readFileSync(
    join(root, ...EXTENSIONS_PATH.split("/"), ...`${name}.d.ts`.split("/")),
    "utf8",
  );
}

/* Official — the blessed path, which asks nothing. */

const VAULT = "@penvhq/provider-vault";
const VAULT_TAR = extensionTar({ name: VAULT, version: "0.9.0" });
const VAULT_REGISTRY: Readonly<Record<string, Uint8Array>> = {
  [`https://registry.npmjs.org/${VAULT}`]: packument({
    name: VAULT,
    version: "0.9.0",
    integrity: integrityOf(VAULT_TAR),
    publishedAt: LONG_AGO,
    publisher: "penvhq",
    attested: true,
  }),
  [`https://registry.npmjs.org/${VAULT}/-/provider-vault-0.9.0.tgz`]: VAULT_TAR,
};

describe("an official extension", () => {
  it("asks nothing at all when there is no config to offer an edit on", async () => {
    const root = scratch("penv-add-bare-");
    mkdirSync(join(root, ...dirname(MANIFEST_PATH).split("/")), { recursive: true });
    writeFileSync(join(root, ...MANIFEST_PATH.split("/")), serializeManifest(baseManifest()));
    writeFileSync(join(root, "package.json"), PACKAGE_JSON);
    const test = harness({
      argv: [VAULT],
      root,
      serve: VAULT_REGISTRY,
      interactive: true,
      consent: true,
    });

    expect(await add(test.options)).toEqual({ onboard: undefined });
    expect(test.questions).toEqual([]);
    expect(test.out).toEqual([
      `✓ ${VAULT} 0.9.0 installed — npm records a provenance attestation`,
      `✓ ${MANIFEST_PATH} pins it`,
      `✓ ${EXTENSIONS_PATH}/${VAULT}.d.ts declares its config type`,
      `Add \`type: "${VAULT}"\` to an environment in penv.config.ts.`,
    ]);
  });

  it("asks only about the config edit, never about trust", async () => {
    const test = harness({
      argv: [VAULT],
      config: CONFIG,
      serve: VAULT_REGISTRY,
      interactive: true,
      consent: [false, true],
    });

    await add(test.options);

    expect(test.questions).toEqual([
      `Point \`development\` at ${VAULT} in penv.config.ts?`,
      `Point \`production\` at ${VAULT} in penv.config.ts?`,
    ]);
    const config = readFileSync(join(test.root, "penv.config.ts"), "utf8");
    expect(config).toContain(`development: { type: "@penvhq/provider-filesystem" }`);
    expect(config).toContain(`production: { type: "${VAULT}" }`);
  });

  it("records the pin with no trust block, through the core serializer", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(manifestTextIn(test.root)).toBe(
      serializeManifest({
        ...baseManifest(),
        extensions: { [VAULT]: { version: "0.9.0", integrity: integrityOf(VAULT_TAR) } },
      }),
    );
  });

  it("installs the verified bytes into the store", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(existsSync(join(packageDir(test.home, "extensions", VAULT, "0.9.0"), "index.js"))).toBe(
      true,
    );
    expect(test.asked).toEqual(Object.keys(VAULT_REGISTRY));
  });

  it("names the line to add when the config is not one penv can read", async () => {
    const test = harness({
      argv: [VAULT],
      config: "export default loadFromSomewhereElse();\n",
      serve: VAULT_REGISTRY,
      interactive: true,
      consent: true,
    });

    await add(test.options);

    expect(test.questions).toEqual([]);
    expect(test.out).toContain(`Add \`type: "${VAULT}"\` to an environment in penv.config.ts.`);
    expect(readFileSync(join(test.root, "penv.config.ts"), "utf8")).toBe(
      "export default loadFromSomewhereElse();\n",
    );
  });

  it("never touches package.json", async () => {
    const test = harness({
      argv: [VAULT],
      config: CONFIG,
      serve: VAULT_REGISTRY,
      interactive: true,
    });

    await add(test.options);

    expect(readFileSync(join(test.root, "package.json"), "utf8")).toBe(PACKAGE_JSON);
  });

  it("refuses to take an official package from a private registry", async () => {
    const test = harness({
      argv: [VAULT, "--registry", "https://npm.acme.internal"],
      serve: VAULT_REGISTRY,
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_OFFICIAL_REGISTRY",
      message:
        `${VAULT} was asked for from https://npm.acme.internal, and \`@penvhq/*\` packages come from npmjs\n` +
        `  Run \`penv add ${VAULT}\` without \`--registry\`. The official scope is the one penv adds ` +
        "without a trust question, so penv will not take it from somewhere else.",
    });
    expect(test.asked).toEqual([]);
  });
});

/* Third-party — the age gate and the trust block. */

const CONSUL = "@acme/provider-consul";
const CONSUL_TAR = extensionTar({ name: CONSUL, version: "1.4.2" });
const CONSUL_INTEGRITY = integrityOf(CONSUL_TAR);

function consulRegistry(publishedAt: string): Readonly<Record<string, Uint8Array>> {
  return {
    [`https://registry.npmjs.org/${CONSUL}`]: packument({
      name: CONSUL,
      version: "1.4.2",
      integrity: CONSUL_INTEGRITY,
      publishedAt,
      publisher: "acme-oss",
    }),
    [`https://registry.npmjs.org/${CONSUL}/-/provider-consul-1.4.2.tgz`]: CONSUL_TAR,
  };
}

describe("a public third-party extension", () => {
  it("refuses one published yesterday, and downloads nothing", async () => {
    const test = harness({
      argv: [CONSUL],
      serve: consulRegistry(YESTERDAY),
      interactive: true,
      consent: true,
      answers: ["Reviewed the source."],
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_PACKAGE_TOO_YOUNG",
      message:
        `${CONSUL} 1.4.2 was published ${YESTERDAY}, and penv waits 7 days before adding a package outside \`@penvhq/*\`\n` +
        `  Run \`penv add ${CONSUL}@1.4.2 --trust-young\` to add it anyway and record why. The wait ` +
        "is there because a hijacked publish is usually caught within days.",
    });
    expect(test.asked).toEqual([`https://registry.npmjs.org/${CONSUL}`]);
    expect(test.questions).toEqual([]);
    expect(manifestIn(test.root)).toMatchObject({ extensions: {} });
  });

  it("adds that same package under the override, with the full trust block", async () => {
    const test = harness({
      argv: [CONSUL, "--trust-young"],
      serve: consulRegistry(YESTERDAY),
      interactive: true,
      consent: true,
      answers: ["Reviewed v1.4.2 source; Consul is our KV store."],
    });

    await add(test.options);

    expect(test.questions).toEqual([
      `Trust ${CONSUL} 1.4.2?`,
      "Why do you trust it? One line, for the next reviewer.",
    ]);
    expect(manifestTextIn(test.root)).toBe(
      serializeManifest({
        ...baseManifest(),
        extensions: {
          [CONSUL]: {
            version: "1.4.2",
            integrity: CONSUL_INTEGRITY,
            trust: {
              tier: "third-party",
              publisher: "acme-oss",
              publishedAt: YESTERDAY,
              acknowledgedAt: NOW.toISOString(),
              reason: "Reviewed v1.4.2 source; Consul is our KV store.",
            },
          },
        },
      }),
    );
  });

  it("stays quiet about age for one published months ago, and still records trust", async () => {
    const test = harness({
      argv: [CONSUL],
      serve: consulRegistry(LONG_AGO),
      interactive: true,
      consent: true,
      answers: ["Consul is our KV store."],
    });

    await add(test.options);

    expect(test.questions).toEqual([
      `Trust ${CONSUL} 1.4.2?`,
      "Why do you trust it? One line, for the next reviewer.",
    ]);
    expect(manifestIn(test.root)).toMatchObject({
      extensions: { [CONSUL]: { trust: { tier: "third-party", publishedAt: LONG_AGO } } },
    });
  });

  it("installs and records nothing when the trust question is answered no", async () => {
    const test = harness({
      argv: [CONSUL],
      serve: consulRegistry(LONG_AGO),
      interactive: true,
      consent: false,
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_TRUST_DECLINED",
      message:
        `${CONSUL} 1.4.2 was not trusted, so penv installed and recorded nothing\n` +
        `  Run \`penv add ${CONSUL}@1.4.2\` again when you have reviewed what it does.`,
    });
    expect(manifestIn(test.root)).toMatchObject({ extensions: {} });
    expect(existsSync(packageDir(test.home, "extensions", CONSUL, "1.4.2"))).toBe(false);
  });

  it("refuses an empty reason rather than writing a trust block nobody wrote", async () => {
    const test = harness({
      argv: [CONSUL],
      serve: consulRegistry(LONG_AGO),
      interactive: true,
      consent: true,
      answers: ["   "],
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_TRUST_REASON_MISSING",
      message:
        `The reason for trusting ${CONSUL} 1.4.2 was left empty\n` +
        `  Run \`penv add ${CONSUL}@1.4.2\` again and write one line on what you checked — the ` +
        "next reviewer reads that line, not the diff.",
    });
    expect(manifestIn(test.root)).toMatchObject({ extensions: {} });
  });

  /** Refused before the first request, so a run with nobody at it reaches no registry at all. */
  it("refuses with no terminal to ask at, and reaches no registry", async () => {
    const test = harness({ argv: [CONSUL], serve: consulRegistry(LONG_AGO) });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_ADD_NOT_INTERACTIVE",
      message:
        `Adding ${CONSUL} rewrites ${MANIFEST_PATH}, and this run has nobody to decide that\n` +
        `  Run \`penv add ${CONSUL}\` from a terminal and commit what it writes. In CI, run ` +
        "`penv install` — it installs the versions the committed manifest already pins.",
    });
    expect(test.asked).toEqual([]);
  });
});

/**
 * `add` writes two committed files, so it is a decision and needs a person and a
 * network. Both refusals land before the first request — a run that cannot finish
 * an add has not read the registry, filled the store, or touched the manifest.
 */
describe("what add will not do on its own", () => {
  it("refuses `--no-download` before it reaches the registry", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await expect(add({ ...test.options, noDownload: true })).rejects.toMatchObject({
      code: "PENV_ADD_NO_DOWNLOAD",
      message:
        `Adding ${VAULT} means reading the registry for the version and integrity to pin, and ` +
        "`--no-download` says this run does not\n" +
        `  Run \`penv add ${VAULT}\` without \`--no-download\`. Nothing was fetched or written.`,
    });
    expect(test.asked).toEqual([]);
    expect(manifestIn(test.root)).toMatchObject({ extensions: {} });
  });

  /** An official add takes no trust decision, and still will not rewrite a committed file in CI. */
  it("refuses in CI even for the official scope", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await expect(add({ ...test.options, ci: true })).rejects.toMatchObject({
      code: "PENV_ADD_NOT_INTERACTIVE",
    });
    expect(test.asked).toEqual([]);
    expect(manifestIn(test.root)).toMatchObject({ extensions: {} });
  });

  /** The negative case: a terminal, no CI, no flag — the add is ordinary work. */
  it("adds when there is a person, a network and no CI", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add({ ...test.options, noDownload: false, ci: false });

    expect(manifestIn(test.root)).toMatchObject({
      extensions: { [VAULT]: { version: "0.9.0" } },
    });
  });
});

/**
 * `penv add <pkg>` is the remedy a broken extension entry names, so it has to
 * survive the file that carries one. Anything else in the manifest is validated
 * exactly as before, and what `add` writes goes through the core serializer.
 */
describe("a manifest with an entry penv cannot read", () => {
  /** The entry is written by hand, so it goes in past the serializer that would refuse it. */
  function projectWithEntries(entries: Readonly<Record<string, unknown>>): string {
    const root = projectAt();
    const manifestFile = join(root, ...MANIFEST_PATH.split("/"));
    writeFileSync(
      manifestFile,
      `${JSON.stringify({ ...baseManifest(), extensions: entries }, null, 2)}\n`,
    );
    return root;
  }

  it("is repaired by the `penv add` its own refusal names", async () => {
    // The finding's scenario: a numeric `version`, which refuses MANIFEST_FIELD_TYPE
    // with `Run \`penv add @penvhq/provider-vault\` to rewrite that entry.`
    const root = projectWithEntries({ [VAULT]: { version: 9, integrity: ENGINE_INTEGRITY } });
    const test = harness({ root, argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(manifestIn(test.root)).toMatchObject({
      extensions: { [VAULT]: { version: "0.9.0", integrity: integrityOf(VAULT_TAR) } },
    });
    // Valid afterwards, by the strictest reader there is.
    expect(() => serializeManifest(manifestIn(test.root) as Manifest)).not.toThrow();
  });

  /** One `add` rewrites one entry, so a second broken one is refused rather than dropped. */
  it("refuses when another entry is broken too", async () => {
    const root = projectWithEntries({
      [VAULT]: { version: 9, integrity: ENGINE_INTEGRITY },
      [CONSUL]: { version: 8, integrity: ENGINE_INTEGRITY },
    });
    const test = harness({ root, argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_MANIFEST_ENTRIES_UNREADABLE",
    });
    // Nothing was written, so the entry the user did not name is still theirs.
    expect(manifestIn(test.root)).toMatchObject({ extensions: { [CONSUL]: { version: 8 } } });
  });

  /** And the engine pin is not an entry: nothing here relaxes the refusal for it. */
  it("still refuses a manifest whose engine pin is wrong", async () => {
    const root = projectAt();
    const manifestFile = join(root, ...MANIFEST_PATH.split("/"));
    writeFileSync(
      manifestFile,
      `${JSON.stringify(
        {
          ...baseManifest(),
          engine: { package: "@penvhq/cli", version: 9, integrity: ENGINE_INTEGRITY },
        },
        null,
        2,
      )}\n`,
    );
    const test = harness({ root, argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await expect(add(test.options)).rejects.toMatchObject({ code: "MANIFEST_FIELD_TYPE" });
  });
});

/* Private — the registry is recorded, the credentials are not. */

const INTERNAL = "@acme/provider-internal";
const INTERNAL_TAR = extensionTar({ name: INTERNAL, version: "2.0.0" });
const PRIVATE_REGISTRY_URL = "https://npm.acme.internal";
const INTERNAL_REGISTRY: Readonly<Record<string, Uint8Array>> = {
  [`${PRIVATE_REGISTRY_URL}/${INTERNAL}`]: packument({
    name: INTERNAL,
    version: "2.0.0",
    integrity: integrityOf(INTERNAL_TAR),
    publishedAt: YESTERDAY,
  }),
  [`${PRIVATE_REGISTRY_URL}/${INTERNAL}/-/provider-internal-2.0.0.tgz`]: INTERNAL_TAR,
};

describe("a private extension", () => {
  it("records the registry, the acknowledgement, and no credential", async () => {
    const test = harness({
      argv: [INTERNAL, "--registry", PRIVATE_REGISTRY_URL],
      serve: INTERNAL_REGISTRY,
      interactive: true,
      consent: true,
      answers: ["Published by our own platform team."],
    });

    await add(test.options);

    expect(test.questions).toEqual([
      `Trust ${INTERNAL} 2.0.0?`,
      "Why do you trust it? One line, for the next reviewer.",
    ]);
    expect(manifestTextIn(test.root)).toBe(
      serializeManifest({
        ...baseManifest(),
        extensions: {
          [INTERNAL]: {
            version: "2.0.0",
            integrity: integrityOf(INTERNAL_TAR),
            registry: PRIVATE_REGISTRY_URL,
            trust: {
              tier: "private",
              acknowledgedAt: NOW.toISOString(),
              reason: "Published by our own platform team.",
            },
          },
        },
      }),
    );
  });

  it("is not held to the seven-day gate, and refuses without the acknowledgement", async () => {
    const declined = harness({
      argv: [INTERNAL, "--registry", PRIVATE_REGISTRY_URL],
      serve: INTERNAL_REGISTRY,
      interactive: true,
      consent: false,
    });

    await expect(add(declined.options)).rejects.toMatchObject({ code: "PENV_TRUST_DECLINED" });
    expect(declined.questions).toEqual([`Trust ${INTERNAL} 2.0.0?`]);
  });

  it("refuses a registry that is not https", async () => {
    const test = harness({
      argv: [INTERNAL, "--registry", "http://npm.acme.internal"],
      serve: INTERNAL_REGISTRY,
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_ADD_REGISTRY",
      message:
        "`--registry http://npm.acme.internal` is not an https URL\n" +
        "  Write the registry's origin, e.g. `--registry https://npm.acme.internal`. Over plain " +
        "http the integrity check proves only that you got the bytes an attacker on the network chose.",
    });
    expect(test.asked).toEqual([]);
  });
});

/* The declaration — types, and nothing that runs. */

const TYPED = "@acme/provider-typed";
const TYPED_DECLARATION = `declare module "@penvhq/core" {
  interface ProviderConfigMap {
    "@acme/provider-typed": {
      readonly location?: string;
      readonly datacenter?: string;
    };
  }
}

export {};
`;

function typedRegistry(source: string): {
  registry: Readonly<Record<string, Uint8Array>>;
  tarball: Uint8Array;
} {
  const tarball = extensionTar({
    name: TYPED,
    version: "3.1.0",
    types: { file: "config.d.ts", source },
  });
  return {
    tarball,
    registry: {
      [`https://registry.npmjs.org/${TYPED}`]: packument({
        name: TYPED,
        version: "3.1.0",
        integrity: integrityOf(tarball),
        publishedAt: LONG_AGO,
        publisher: "acme-oss",
      }),
      [`https://registry.npmjs.org/${TYPED}/-/provider-typed-3.1.0.tgz`]: tarball,
    },
  };
}

describe("the generated declaration", () => {
  it("carries the provider's own shape and no runtime code", async () => {
    const test = harness({
      argv: [TYPED],
      serve: typedRegistry(TYPED_DECLARATION).registry,
      interactive: true,
      consent: true,
      answers: ["Reviewed the adapter."],
    });

    await add(test.options);

    const declaration = declarationIn(test.root, TYPED);
    expect(declaration).toBe(
      `// Written by \`penv add ${TYPED}\`, and committed.\n` +
        `// ${TYPED} 3.1.0 — npm records no provenance attestation for it.\n` +
        "//\n" +
        "// Types only: this declares the shape of the provider's `penv.config.ts`\n" +
        "// entry. It holds no adapter code, no credentials, and no values.\n" +
        "\n" +
        TYPED_DECLARATION,
    );
    expect(declaration).not.toContain("penvProviderFactory");
    expect(declaration).not.toContain("require(");
  });

  it("refuses one that reaches for a module the project does not have", async () => {
    const source = `import type { z } from "zod";\n\nexport type Config = z.ZodType;\n`;
    const test = harness({
      argv: [TYPED],
      serve: typedRegistry(source).registry,
      interactive: true,
      consent: true,
      answers: ["Reviewed the adapter."],
    });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_DECLARATION_NOT_SELF_CONTAINED",
      message:
        `The declaration ${TYPED} ships at \`config.d.ts\` imports \`zod\`\n` +
        `  Report it to ${TYPED}. What penv commits to ${EXTENSIONS_PATH} is types and nothing ` +
        "else, so it can only carry a declaration that stands on its own.",
    });
  });

  it("falls back to the open shape for a package that ships none", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(declarationIn(test.root, VAULT)).toBe(
      `// Written by \`penv add ${VAULT}\`, and committed.\n` +
        `// ${VAULT} 0.9.0 — npm records a provenance attestation for it.\n` +
        "//\n" +
        "// Types only: this declares the shape of the provider's `penv.config.ts`\n" +
        "// entry. It holds no adapter code, no credentials, and no values.\n" +
        "\n" +
        'import type { ProviderConfig } from "@penvhq/core";\n' +
        "\n" +
        'declare module "@penvhq/core" {\n' +
        "  interface ProviderConfigMap {\n" +
        `    "${VAULT}": ProviderConfig & { readonly type: "${VAULT}" };\n` +
        "  }\n" +
        "}\n",
    );
  });
});

/* Onboarding — offered when declared, and never otherwise. */

const CLOUD = "@penvhq/provider-cloud";
const CLOUD_TAR = extensionTar({ name: CLOUD, version: "0.9.0", onboard: "cloud login" });
const CLOUD_REGISTRY: Readonly<Record<string, Uint8Array>> = {
  [`https://registry.npmjs.org/${CLOUD}`]: packument({
    name: CLOUD,
    version: "0.9.0",
    integrity: integrityOf(CLOUD_TAR),
    publishedAt: LONG_AGO,
    attested: true,
  }),
  [`https://registry.npmjs.org/${CLOUD}/-/provider-cloud-0.9.0.tgz`]: CLOUD_TAR,
};

describe("the onboarding offer", () => {
  it("offers the declared step, and hands it back only on a yes", async () => {
    const accepted = harness({
      argv: [CLOUD],
      serve: CLOUD_REGISTRY,
      interactive: true,
      consent: true,
    });

    expect(await add(accepted.options)).toEqual({ onboard: ["cloud", "login"] });
    expect(accepted.questions).toEqual(["Run `penv cloud login` now?"]);
  });

  it("names the command instead when the offer is declined", async () => {
    const declined = harness({
      argv: [CLOUD],
      serve: CLOUD_REGISTRY,
      interactive: true,
      consent: false,
    });

    expect(await add(declined.options)).toEqual({ onboard: undefined });
    expect(declined.out).toContain(`Run \`penv cloud login\` to finish setting ${CLOUD} up.`);
  });

  it("stays silent for a package that declares none", async () => {
    const test = harness({
      argv: [VAULT],
      serve: VAULT_REGISTRY,
      interactive: true,
      consent: true,
    });

    expect(await add(test.options)).toEqual({ onboard: undefined });
    expect(test.questions).toEqual([]);
    expect(test.out.some((line) => line.includes("finish setting"))).toBe(false);
  });
});

/* Local — the path with no release behind it. */

const OWN = "@acme/provider-consul";

/** Installs `name` into the project's own `node_modules`, the way a workspace link would. */
function installLocally(
  root: string,
  name: string,
  options: { readonly version?: string; readonly penv?: Record<string, string> } = {},
): void {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: options.version ?? "0.0.0",
        main: "index.js",
        ...(options.penv === undefined ? {} : { penv: options.penv }),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "index.js"), "exports.penvProviderFactory = () => ({});\n");
}

function localExtensionsIn(root: string): unknown {
  return JSON.parse(readFileSync(join(root, ...LOCAL_EXTENSIONS_PATH.split("/")), "utf8"));
}

describe("add --local", () => {
  it("records the name, declares the type, and leaves the manifest alone", async () => {
    const root = projectAt();
    installLocally(root, OWN, { version: "0.0.0" });
    const test = harness({ argv: ["--local", OWN], root });
    const before = manifestTextIn(root);

    await add(test.options);

    expect(localExtensionsIn(root)).toEqual([OWN]);
    expect(manifestTextIn(root)).toBe(before);
    expect(declarationIn(root, OWN)).toContain(
      `// Written by \`penv add --local ${OWN}\`, and committed.`,
    );
    expect(declarationIn(root, OWN)).toContain(
      "resolved from this project, not from a published release",
    );
    expect(test.out).toContain(
      `✓ ${OWN} resolves from this project and imports — nothing is pinned`,
    );
    // No release was read, so no registry was.
    expect(test.asked).toEqual([]);
  });

  it("adds a second one without losing the first", async () => {
    const root = projectAt();
    installLocally(root, OWN);
    installLocally(root, "@acme/provider-etcd");
    await add(harness({ argv: ["--local", OWN], root }).options);
    await add(harness({ argv: ["--local", "@acme/provider-etcd"], root }).options);

    expect(localExtensionsIn(root)).toEqual(["@acme/provider-consul", "@acme/provider-etcd"]);
  });

  it("refuses a package the project cannot resolve", async () => {
    const root = projectAt();
    const test = harness({ argv: ["--local", OWN], root });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_LOCAL_EXTENSION_UNRESOLVED",
    });
    expect(existsSync(join(root, ...LOCAL_EXTENSIONS_PATH.split("/")))).toBe(false);
  });

  it("refuses the flags that describe a published release", async () => {
    const root = projectAt();
    installLocally(root, OWN);

    await expect(
      add(harness({ argv: ["--local", `${OWN}@1.2.3`], root }).options),
    ).rejects.toMatchObject({
      code: "PENV_ADD_LOCAL_FLAG",
      message: expect.stringContaining("a version"),
    });
    await expect(
      add(
        harness({ argv: ["--local", OWN, "--registry", "https://npm.acme.internal"], root })
          .options,
      ),
    ).rejects.toMatchObject({ code: "PENV_ADD_LOCAL_FLAG" });
    await expect(
      add(harness({ argv: ["--local", OWN, "--trust-young"], root }).options),
    ).rejects.toMatchObject({ code: "PENV_ADD_LOCAL_FLAG" });
  });

  it("refuses in CI, where nobody is deciding what the project develops", async () => {
    const root = projectAt();
    installLocally(root, OWN);
    const test = harness({ argv: ["--local", OWN], root });

    await expect(add({ ...test.options, ci: true })).rejects.toMatchObject({
      code: "PENV_ADD_LOCAL_IN_CI",
    });
  });

  /**
   * Finding 17: `add` certified resolution and stopped there, so this exact
   * package — `exports` pointing at TypeScript source — collected three green
   * checks and failed days later from an unrelated command.
   */
  it("refuses a package whose entry is TypeScript source, writing nothing", async () => {
    const root = projectAt();
    const dir = join(root, "node_modules", ...OWN.split("/"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify({ name: OWN, version: "0.0.0", exports: { ".": "./src/index.ts" } })}\n`,
    );
    writeFileSync(join(dir, "src", "index.ts"), "export const penvProviderFactory = () => ({});\n");
    const test = harness({ argv: ["--local", OWN], root });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_EXTENSION_NOT_IMPORTABLE",
      remedy: expect.stringContaining("built JavaScript"),
    });
    expect(existsSync(join(root, ...LOCAL_EXTENSIONS_PATH.split("/")))).toBe(false);
    expect(existsSync(join(root, ...EXTENSIONS_PATH.split("/")))).toBe(false);
    expect(test.out).toEqual([]);
  });

  it("refuses one that throws while importing, carrying what it threw", async () => {
    const root = projectAt();
    installLocally(root, OWN);
    writeFileSync(
      join(root, "node_modules", ...OWN.split("/"), "index.js"),
      "throw new Error(\"Cannot find module 'consul'\");\n",
    );
    const test = harness({ argv: ["--local", OWN], root });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_EXTENSION_UNLOADABLE",
      summary: expect.stringContaining("Cannot find module 'consul'"),
    });
    expect(existsSync(join(root, ...LOCAL_EXTENSIONS_PATH.split("/")))).toBe(false);
  });

  /** The registry path is untouched: an ordinary add still pins and still asks nothing extra. */
  it("leaves the pinned path alone", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(existsSync(join(test.root, ...LOCAL_EXTENSIONS_PATH.split("/")))).toBe(false);
    expect(manifestIn(test.root)).toMatchObject({ extensions: { [VAULT]: { version: "0.9.0" } } });
  });
});

/* The same check on the path with a release behind it. */

describe("the load check on a pinned release", () => {
  const SRC_ONLY = "@penvhq/provider-src-only";
  const SRC_ONLY_TAR = packTar([
    { path: "package/", typeflag: "5" },
    {
      path: "package/package.json",
      content: `${JSON.stringify({
        name: SRC_ONLY,
        version: "1.0.0",
        exports: { ".": "./src/index.ts" },
      })}\n`,
    },
    { path: "package/src/index.ts", content: "export const penvProviderFactory = () => ({});\n" },
  ]);
  const SRC_ONLY_REGISTRY: Readonly<Record<string, Uint8Array>> = {
    [`https://registry.npmjs.org/${SRC_ONLY}`]: packument({
      name: SRC_ONLY,
      version: "1.0.0",
      integrity: integrityOf(SRC_ONLY_TAR),
      publishedAt: LONG_AGO,
      publisher: "penvhq",
    }),
    [`https://registry.npmjs.org/${SRC_ONLY}/-/provider-src-only-1.0.0.tgz`]: SRC_ONLY_TAR,
  };

  /**
   * The store copy is what the engine imports for a pinned extension, so it is
   * the copy that has to load — and the manifest that pins it is not written
   * until it has.
   */
  it("refuses a release penv cannot import, leaving the manifest alone", async () => {
    const test = harness({ argv: [SRC_ONLY], serve: SRC_ONLY_REGISTRY, interactive: true });
    const before = manifestTextIn(test.root);

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_EXTENSION_NOT_IMPORTABLE",
    });
    expect(manifestTextIn(test.root)).toBe(before);
    expect(existsSync(join(test.root, ...EXTENSIONS_PATH.split("/")))).toBe(false);
  });

  /** The quiet half: a release that imports is pinned exactly as before. */
  it("pins a release that imports", async () => {
    const test = harness({ argv: [VAULT], serve: VAULT_REGISTRY, interactive: true });

    await add(test.options);

    expect(manifestIn(test.root)).toMatchObject({ extensions: { [VAULT]: { version: "0.9.0" } } });
  });
});

/* What `add` will not even try. */

describe("what add refuses to parse", () => {
  it("names the two flags it takes", async () => {
    const test = harness({ argv: [VAULT, "--force"], serve: VAULT_REGISTRY });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_ADD_FLAG",
      message:
        "`penv add` does not understand `--force`\n" +
        "  Run `penv add <package>` with `--trust-young`, `--registry <url>`, or `--local` — " +
        "those are the three it takes.",
    });
  });

  it("refuses a command with no package in it", async () => {
    const test = harness({ argv: [] });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_ADD_SUBJECT",
      message:
        "`penv add` names no package\n" +
        "  Run `penv add @penvhq/provider-vault`, or any provider package name — optionally with " +
        "`@<version>` to pin one other than the latest.",
    });
  });

  it("refuses a version the registry does not publish", async () => {
    const test = harness({ argv: [`${VAULT}@9.9.9`], serve: VAULT_REGISTRY, interactive: true });

    await expect(add(test.options)).rejects.toMatchObject({
      code: "PENV_VERSION_UNKNOWN",
      message:
        `https://registry.npmjs.org/${VAULT} publishes no 9.9.9 of ${VAULT}\n` +
        `  Run \`penv add ${VAULT}\` to take the version \`latest\` points at.`,
    });
  });
});
