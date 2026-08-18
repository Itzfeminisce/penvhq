/**
 * `penv migrate` — move a project's records under `.penv/state/records/`.
 *
 * penv reads one layout, so this is the one command that knows two. It is a
 * relocation and nothing else: records move byte for byte, keeping their names,
 * so the grammar, the cascade, the meta and the AAD that binds a ciphertext to
 * its address all mean afterwards exactly what they meant before.
 * `penv.schema.ts`, `penv.config.ts` and `.penv/env.ts` are the project's, and
 * are never touched.
 *
 * It previews before it moves, because the one thing a migration must not do is
 * surprise the person who ran it — and it refuses a half-migrated tree rather
 * than merging two, since which copy of a parameter is current is a question
 * only the user can answer.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  loadConfig,
  oldLayoutEntries,
  PENV_DIR,
  PenvError,
  RECORDS_PATH,
  recordsDir,
  renderStateGitignore,
  STATE_GITIGNORE_PATH,
} from "@penvhq/core";
import { defineCommand } from "citty";
import { out } from "../style.js";
import { CHECK, formatSteps, guard, prompt, type Step, tip, write } from "../ui.js";

/** The ignore file the old layout kept its boundary in, which this command replaces. */
const OLD_GITIGNORE = `${PENV_DIR}/.gitignore`;

/** One thing that moves, project-relative and POSIX. */
export interface MigrateMove {
  readonly from: string;
  readonly to: string;
}

export interface MigratePlan {
  readonly root: string;
  /** What moves, in the order it is reported. */
  readonly moves: readonly MigrateMove[];
  /** What penv writes that is not there yet — the tree root and the safety boundary. */
  readonly creates: readonly string[];
  /** What penv removes: the ignore file that described the old layout. */
  readonly removes: readonly string[];
}

/**
 * `previewed` is a plan nobody approved, so nothing was written; `current` is a
 * project that was already on the new layout, which is what a second run says.
 */
export type MigrateStatus = "migrated" | "current" | "previewed";

export interface MigrateResult extends MigratePlan {
  readonly status: MigrateStatus;
}

export interface MigrateOptions {
  readonly cwd: string;
  /** Approve the plan. Without it `migrate` previews and writes nothing. */
  readonly yes?: boolean;
}

/**
 * What a migration would do, without doing any of it.
 *
 * The move list is `oldLayoutEntries` — the same list every command's refusal is
 * keyed off — so the preview can never describe a different migration from the
 * one that runs.
 */
export function planMigrate(cwd: string): MigratePlan {
  const { config, file } = loadConfig(cwd);
  const root = dirname(file);
  const entries = oldLayoutEntries(root, config);
  const tree = recordsDir(root);

  // Only a name on both sides is a question penv cannot answer: two copies of one
  // record, and moving would pick a winner silently. Entries the tree does not
  // hold are simply the rest of the migration — an interruption between two
  // renames leaves exactly that, and refusing it wedged the project, since every
  // other command answers an old-layout tree by naming this one.
  const collisions = collidingEntries(entries, tree);
  if (collisions.length > 0) {
    throw new PenvError(
      "HALF_MIGRATED",
      `${describe(collisions)} in both \`${PENV_DIR}/\` and \`${RECORDS_PATH}/\`, and penv cannot tell which copy is current`,
      `Move what is left under \`${PENV_DIR}/\` into \`${RECORDS_PATH}/\` yourself, keeping the copy you want, then run \`penv validate\`.`,
    );
  }

  const creates: string[] = [];
  if (entries.length > 0 && !existsSync(tree)) {
    creates.push(`${RECORDS_PATH}/`);
  }
  if (
    readIfPresent(join(root, ...STATE_GITIGNORE_PATH.split("/"))) !== renderStateGitignore(config)
  ) {
    creates.push(STATE_GITIGNORE_PATH);
  }

  return {
    root,
    moves: entries.map((entry) => ({
      from: `${PENV_DIR}/${entry}`,
      to: `${RECORDS_PATH}/${entry}`,
    })),
    creates,
    removes: existsSync(join(root, ...OLD_GITIGNORE.split("/"))) ? [OLD_GITIGNORE] : [],
  };
}

function readIfPresent(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/**
 * The names the move would land on top of, sorted.
 *
 * Folded to lower case, because on a case-insensitive filesystem `DB` and `db`
 * are one name and the rename would overwrite rather than collide.
 */
function collidingEntries(entries: readonly string[], tree: string): string[] {
  let held: string[];
  try {
    held = readdirSync(tree);
  } catch {
    return [];
  }
  const taken = new Set(held.map((name) => name.toLowerCase()));
  return entries.filter((entry) => taken.has(entry.toLowerCase())).sort();
}

function describe(names: readonly string[]): string {
  return names.length === 1
    ? `\`${names[0]}\` is`
    : `${names.map((name) => `\`${name}\``).join(", ")} are`;
}

/** True when a plan would change nothing at all. */
export function isNoop(plan: MigratePlan): boolean {
  return plan.moves.length === 0 && plan.creates.length === 0 && plan.removes.length === 0;
}

/**
 * Performs a plan. Separate from {@link planMigrate} so what runs is the plan the
 * user approved, not a second reading of the disk between the question and the
 * answer.
 */
export function applyMigrate(plan: MigratePlan): MigrateResult {
  if (isNoop(plan)) {
    return { ...plan, status: "current" };
  }

  const { config } = loadConfig(plan.root);
  if (plan.moves.length > 0) {
    mkdirSync(recordsDir(plan.root), { recursive: true });
    for (const move of plan.moves) {
      renameSync(join(plan.root, ...move.from.split("/")), join(plan.root, ...move.to.split("/")));
    }
  }

  // The new boundary is written before the old one goes, so the records this
  // command just moved are never unignored for an instant. The old one still has
  // to go: left in place it would keep ignoring `.penv/env.ts`, which the new
  // layout commits.
  if (plan.creates.includes(STATE_GITIGNORE_PATH)) {
    const ignore = join(plan.root, ...STATE_GITIGNORE_PATH.split("/"));
    mkdirSync(dirname(ignore), { recursive: true });
    writeFileSync(ignore, renderStateGitignore(config), "utf8");
  }

  for (const removed of plan.removes) {
    rmSync(join(plan.root, ...removed.split("/")), { force: true });
  }

  return { ...plan, status: "migrated" };
}

/** Plans, and applies only when the move was approved. */
export function runMigrate(options: MigrateOptions): MigrateResult {
  const plan = planMigrate(options.cwd);
  if (isNoop(plan)) {
    return { ...plan, status: "current" };
  }
  return options.yes === true ? applyMigrate(plan) : { ...plan, status: "previewed" };
}

export function renderMigrate(result: MigrateResult): string[] {
  if (result.status === "current") {
    return [`${out.green(CHECK)} Already on ${RECORDS_PATH}/ — nothing to migrate.`];
  }

  const done = result.status === "migrated";
  const glyph = done ? CHECK : "→";
  const steps: Step[] = [
    ...result.moves.map((move) => ({
      glyph,
      text: `${done ? "Moved" : "Move"} ${move.from}`,
      note: `to ${move.to}`,
    })),
    ...result.creates.map((created) => ({ glyph, text: `${done ? "Wrote" : "Write"} ${created}` })),
    ...result.removes.map((removed) => ({
      glyph,
      text: `${done ? "Removed" : "Remove"} ${removed}`,
      note: `replaced by ${STATE_GITIGNORE_PATH}`,
    })),
  ];

  return [
    ...formatSteps(steps),
    "",
    ...(done
      ? [
          `${out.green(CHECK)} ${out.bold("Migrated.")} Commit the move, then:`,
          tip(out.cyan("penv validate")),
        ]
      : [
          "Your schema, config and loader are untouched, and every record keeps its name.",
          tip(out.cyan("penv migrate --yes")),
        ]),
  ];
}

/** The question, asked only against a real terminal — anything else has nobody to ask. */
async function approveOnTty(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt("Move them", "y/N"));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: `Move a project written under an earlier layout to ${RECORDS_PATH}/`,
  },
  args: {
    yes: { type: "boolean", description: "Apply the previewed move without asking" },
  },
  run({ args }) {
    return guard(async () => {
      const plan = planMigrate(process.cwd());
      if (isNoop(plan)) {
        write(renderMigrate({ ...plan, status: "current" }));
        return;
      }

      write(renderMigrate({ ...plan, status: "previewed" }));
      const approved =
        args.yes === true || (process.stdin.isTTY === true && (await approveOnTty()));
      if (!approved) {
        return;
      }
      write(["", ...renderMigrate(applyMigrate(plan))]);
    });
  },
});
