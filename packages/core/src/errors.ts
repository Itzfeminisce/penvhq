/**
 * Named errors. Every message names the parameter and environment, says what is
 * wrong, and says how to fix it. Never `Something went wrong`.
 */

export class PenvError extends Error {
  override readonly name: string = "PenvError";
  /** A stable, machine-readable discriminator. */
  readonly code: string;
  /** What the user should do about it. */
  readonly remedy: string | undefined;

  constructor(code: string, message: string, remedy?: string) {
    super(remedy ? `${message}\n  ${remedy}` : message);
    this.code = code;
    this.remedy = remedy;
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

/** The loaded configuration does not satisfy the schema. */
export class ValidationError extends PenvError {
  override readonly name = "ValidationError";
  readonly environment: string;
  readonly issues: readonly { readonly parameter: string; readonly message: string }[];

  constructor(
    environment: string,
    issues: readonly { readonly parameter: string; readonly message: string }[],
  ) {
    const lines = issues.map((i) => `  ${i.parameter}: ${i.message}`).join("\n");
    super(
      "VALIDATION_FAILED",
      `Configuration for environment ${environment} does not match the schema:\n${lines}`,
      `Fix the values above, or adjust the schema in .penv/env.ts if the shape is wrong.`,
    );
    this.environment = environment;
    this.issues = issues;
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

/** penv.config.ts is absent or unreadable. */
export class ConfigError extends PenvError {
  override readonly name = "ConfigError";

  constructor(message: string, remedy: string) {
    super("CONFIG", message, remedy);
  }
}
