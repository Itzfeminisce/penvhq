/**
 * Named errors. Every message names the parameter and environment, says what is
 * wrong, and says how to fix it. Never `Something went wrong`.
 *
 * A penv error also renders itself the way the CLI renders one. The CLI can
 * format what it catches, but the refusals thrown by the application's bridge
 * are caught by nobody — an app started without `penv run` prints them through
 * Node's default uncaught-exception handler, which prints `stack`. So `stack`
 * carries the refusal first and the remedy behind the same arrow every command
 * prints, and the frames below it are the caller's, not penv's.
 */

/** The remedy marker, one shape everywhere penv answers a question with a command. */
const REMEDY_ARROW = "→";

/** V8's frame-trimming hook. Absent on a runtime that has no such thing. */
type CaptureStackTrace = (target: object, below?: (...args: never[]) => unknown) => void;

/** Only the frames — the header V8 wrote is replaced by the refusal. */
function framesOf(stack: string | undefined): string[] {
  return (stack ?? "").split("\n").filter((line) => /^\s+at\s/.test(line));
}

/**
 * Puts the refusal at the top of `stack`, lazily so a subclass's own `name` and
 * fields are set by the time anything reads it.
 */
function renderRefusal(error: PenvError): void {
  const captured = error.stack;
  Object.defineProperty(error, "stack", {
    configurable: true,
    get: () => [error.toString(), ...framesOf(captured)].join("\n"),
    set(value: string) {
      Object.defineProperty(error, "stack", { value, writable: true, configurable: true });
    },
  });
}

export class PenvError extends Error {
  override readonly name: string = "PenvError";
  /** A stable, machine-readable discriminator. */
  readonly code: string;
  /** What the user should do about it. */
  readonly remedy: string | undefined;
  /** The message alone, without the remedy the constructor folds into it. */
  readonly summary: string;

  constructor(code: string, message: string, remedy?: string) {
    super(remedy ? `${message}\n  ${remedy}` : message);
    this.code = code;
    this.remedy = remedy;
    this.summary = message;
    renderRefusal(this);
  }

  /**
   * Drops every frame from `below` upward, so the stack shows where the
   * application called in rather than the path penv took inside itself. The
   * caller names its own entry point; nothing here guesses which files are
   * penv's.
   */
  hideFramesAbove(below: (...args: never[]) => unknown): this {
    const capture = (Error as { captureStackTrace?: CaptureStackTrace }).captureStackTrace;
    if (capture !== undefined) {
      capture(this, below);
      renderRefusal(this);
    }
    return this;
  }

  /** The refusal as every penv command prints it: the message, then the remedy. */
  override toString(): string {
    const head = `${this.name}: ${this.summary}`;
    return this.remedy === undefined ? head : `${head}\n  ${REMEDY_ARROW} ${this.remedy}`;
  }
}

/** A filename does not fit the grammar. */
export class FilenameGrammarError extends PenvError {
  override readonly name = "FilenameGrammarError";
  readonly filename: string;

  constructor(filename: string, problem: string, remedy: string) {
    super("FILENAME_GRAMMAR", `Invalid parameter filename ${filename}: ${problem}`, remedy);
    this.filename = filename;
  }
}

/** A parameter or environment name collides with a reserved token. */
export class ReservedTokenError extends PenvError {
  override readonly name = "ReservedTokenError";
  readonly token: string;

  constructor(subject: "parameter" | "environment", token: string, where: string) {
    super(
      "RESERVED_TOKEN",
      `The ${subject} name \`${token}\` in ${where} is a reserved token`,
      `Filenames are split on \`.\`, so \`${token}\` cannot be a ${subject} name. Rename it.`,
    );
    this.token = token;
  }
}

/** Two parameters map to the same generated variable. Never last-write-wins. */
export class NameCollisionError extends PenvError {
  override readonly name = "NameCollisionError";
  readonly variable: string;
  readonly parameters: readonly string[];

  constructor(variable: string, parameters: readonly string[]) {
    super(
      "NAME_COLLISION",
      `Parameters ${parameters.map((p) => `\`${p}\``).join(" and ")} both map to \`${variable}\``,
      `Set a distinct name for one of them in the \`names\` block of penv.config.ts.`,
    );
    this.variable = variable;
    this.parameters = parameters;
  }
}

/** A required parameter is absent for the target environment. */
export class MissingParameterError extends PenvError {
  override readonly name = "MissingParameterError";
  readonly parameter: string;
  readonly environment: string;

  constructor(parameter: string, environment: string) {
    super(
      "MISSING_PARAMETER",
      `Missing required parameter ${parameter} for environment ${environment}`,
      `Set it with \`penv set ${parameter} --env ${environment}\`.`,
    );
    this.parameter = parameter;
    this.environment = environment;
  }
}

/** What a {@link ValidationError} subclass says instead of the general wording. */
export interface ValidationWording {
  readonly message: string;
  readonly remedy: string;
}

/** The loaded configuration does not satisfy the schema. */
export class ValidationError extends PenvError {
  override readonly name: string = "ValidationError";
  readonly environment: string;
  readonly issues: readonly { readonly parameter: string; readonly message: string }[];

  constructor(
    environment: string,
    issues: readonly { readonly parameter: string; readonly message: string }[],
    wording?: ValidationWording,
  ) {
    const lines = issues.map((i) => `  ${i.parameter}: ${i.message}`).join("\n");
    super(
      "VALIDATION_FAILED",
      wording?.message ??
        `Configuration for environment ${environment} does not match the schema:\n${lines}`,
      wording?.remedy ??
        `Fix the values above, or adjust the schema in .penv/env.ts if the shape is wrong.`,
    );
    this.environment = environment;
    this.issues = issues;
  }
}

/**
 * An adopted application started outside `penv run`.
 *
 * The schema failed on a parameter with no value, and nothing had prepared this
 * process's environment — so the answer is not "fix your values" but "start it
 * the way an adopted app starts". It stays a {@link ValidationError}, carrying
 * the same issues and the same code: it is that failure, told to the one reader
 * whose remedy is a different command.
 *
 * Sealed copy (friction item 10) — the highest-traffic refusal penv has, so it
 * is written here and asserted verbatim rather than improvised at the call site.
 */
export class DirectStartError extends ValidationError {
  override readonly name = "DirectStartError";
  /** The first required parameter with no value — what the reader came to find out. */
  readonly parameter: string;
  /** The command as penv can best restate it, which is what goes after `--`. */
  readonly command: string;

  constructor(
    environment: string,
    issues: readonly { readonly parameter: string; readonly message: string }[],
    parameter: string,
    command: string,
  ) {
    super(environment, issues, {
      message:
        `Missing required parameter ${parameter} for environment ${environment}, ` +
        "and this process was not started by `penv run`",
      remedy: `Start it with \`penv run -- ${command}\`.`,
    });
    this.parameter = parameter;
    this.command = command;
  }
}

/**
 * An environment a platform delivered, missing the map that says which variable
 * each parameter arrived in.
 *
 * `penv run` writes `PENV_ENV` and `PENV_DELIVERY` together, one line apart. A
 * process carrying the first without the second was assembled by hand — a
 * managed platform's environment store, typically — and penv is reading the
 * default generated name because it has nothing else to read. Where an
 * `override` bent that name, the value is sitting in the environment under the
 * other one, and "missing" points nowhere near the cause.
 *
 * So this refusal names the variable penv actually read, which is the fact the
 * reader cannot see from the outside.
 */
export class DeliveryContractMissingError extends ValidationError {
  override readonly name = "DeliveryContractMissingError";
  readonly parameter: string;
  /** The variable penv read, which is the default name when there is no contract. */
  readonly variable: string;

  constructor(
    environment: string,
    issues: readonly { readonly parameter: string; readonly message: string }[],
    parameter: string,
    variable: string,
  ) {
    super(environment, issues, {
      message:
        `Missing required parameter ${parameter} for environment ${environment}: penv read ` +
        `${variable}, and this process carries PENV_ENV without the PENV_DELIVERY map that ` +
        "goes with it",
      remedy:
        "Set PENV_DELIVERY beside the values — it is the parameter-to-variable map `penv run` " +
        `writes, and an \`override\` in penv.config.ts is what makes ${variable} unguessable ` +
        `without it. Capture it with \`penv run --env ${environment} -- node -e ` +
        '"console.log(process.env.PENV_DELIVERY)"`.',
    });
    this.parameter = parameter;
    this.variable = variable;
  }
}

/**
 * Nothing is materialised for this environment — a teammate's first run after a
 * clone, before their first `penv pull`.
 *
 * Sealed copy (friction item 10). It names no parameter deliberately: nothing at
 * all resolved, so there is no single one to name, and the whole tree is what the
 * one next command fills.
 */
export class MissingMaterializationError extends PenvError {
  override readonly name = "MissingMaterializationError";
  readonly environment: string;

  constructor(environment: string) {
    super("NO_MATERIALIZED_VALUES", `No materialized values for ${environment}`, "Run: penv pull");
    this.environment = environment;
  }
}

/**
 * A declared environment name that cannot be written into a filename.
 *
 * Distinct from `UnknownEnvironmentError`, which says a name was never declared.
 * This one *was* declared, and is still unusable — so the remedy is to rename it,
 * not to add it.
 */
export class IllegalEnvironmentNameError extends PenvError {
  override readonly name = "IllegalEnvironmentNameError";
  readonly environment: string;

  constructor(environment: string) {
    super(
      "ENVIRONMENT_NAME_ILLEGAL",
      `The environment \`${environment}\` in penv.config.ts cannot be part of a filename`,
      "An environment name becomes a dot segment verbatim, and filenames are split on `.`, so " +
        "the name must be letters, digits, `_` or `-` — no dots. If you are naming it after a " +
        "dotenv file, use the environment inside that name: `.env.development.local` is the " +
        "`development` environment's personal override, so declare `development`.",
    );
    this.environment = environment;
  }
}

/** A filename segment looks like an environment but was never declared. */
export class UnknownEnvironmentError extends PenvError {
  override readonly name = "UnknownEnvironmentError";
  readonly environment: string;

  constructor(environment: string, declared: readonly string[]) {
    super(
      "UNKNOWN_ENVIRONMENT",
      `Environment ${environment} is not declared in penv.config.ts`,
      `Declared environments are ${declared.map((e) => `\`${e}\``).join(", ")}. ` +
        `Add \`${environment}\` to the \`environments\` list, or use a declared one.`,
    );
    this.environment = environment;
  }
}

/**
 * A code module is sitting in the parameter tree where a value file was expected.
 *
 * Distinct from `UnknownEnvironmentError`: the segment that failed is not a
 * mistyped environment but a source-file extension (`.ts`, `.js`, …), so reading
 * `schema.ts` back as "environment `ts` is not declared" is technically true and
 * humanly useless. The remedy is to move the code out of the tree or declare it
 * as `schemaFile`, never to add an environment.
 */
export class StrayCodeFileError extends PenvError {
  override readonly name = "StrayCodeFileError";
  readonly filename: string;
  readonly extension: string;

  constructor(filename: string, extension: string) {
    super(
      "STRAY_CODE_FILE",
      `${filename} looks like a code module, not a value file`,
      `Value files are named \`<key>.<environment>\`, but \`.${extension}\` is a source-file ` +
        "extension. Move the code out of the records tree, or declare it as `schemaFile` in " +
        "penv.config.ts.",
    );
    this.filename = filename;
    this.extension = extension;
  }
}

/**
 * The project still keeps its records directly under `.penv/`.
 *
 * penv reads one layout, so this is the whole of what an unmigrated project
 * hears — every command refuses the same way, naming the one command that
 * converts it. A second search path would be an engine with two truths about
 * where a project's values live.
 */
export class OldLayoutError extends PenvError {
  override readonly name = "OldLayoutError";

  constructor() {
    super(
      "OLD_LAYOUT",
      "This project keeps its records directly under `.penv/`, and penv reads `.penv/state/records/`",
      "Run `penv migrate` — it previews the move first, and leaves penv.schema.ts, " +
        "penv.config.ts and .penv/env.ts byte-identical.",
    );
  }
}

/** penv.config.ts is absent or unreadable. */
export class ConfigError extends PenvError {
  override readonly name = "ConfigError";

  constructor(message: string, remedy: string) {
    super("CONFIG", message, remedy);
  }
}
