/**
 * penv's command line.
 *
 * The wiring here is deliberately thin: every command's real work is a plain
 * exported function that takes a `cwd` and returns a result, and citty only
 * parses arguments, calls it, and prints what it returned. That is what lets the
 * tests call the commands rather than spawn them.
 */

import { setKeychain } from "@penvhq/core";
import { runMain as cittyRunMain, defineCommand } from "citty";
import { cleanupCommand } from "./commands/cleanup.js";
import { doctorCommand } from "./commands/doctor.js";
import { decryptCommand, encryptCommand } from "./commands/encrypt.js";
import { fillCommand } from "./commands/fill.js";
import { generateCommand } from "./commands/generate.js";
import { getCommand } from "./commands/get.js";
import { importCommand } from "./commands/import.js";
import { initCommand } from "./commands/init.js";
import { keyCommand } from "./commands/key.js";
import { listCommand } from "./commands/list.js";
import { migrateCommand } from "./commands/migrate.js";
import { mvCommand } from "./commands/mv.js";
import { pullCommand } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { removeCommand } from "./commands/remove.js";
import { rotateCommand } from "./commands/rotate.js";
import { runCommand } from "./commands/run.js";
import { setCommand } from "./commands/set.js";
import { validateCommand } from "./commands/validate.js";
import { watchCommand } from "./commands/watch.js";
import { defaultKeychain } from "./keychain.js";

export const main = defineCommand({
  meta: {
    name: "penv",
    description: "Configuration that shares a data model with your production secret manager",
  },
  subCommands: {
    init: initCommand,
    import: importCommand,
    generate: generateCommand,
    get: getCommand,
    set: setCommand,
    fill: fillCommand,
    mv: mvCommand,
    pull: pullCommand,
    push: pushCommand,
    rotate: rotateCommand,
    run: runCommand,
    remove: removeCommand,
    list: listCommand,
    cleanup: cleanupCommand,
    migrate: migrateCommand,
    encrypt: encryptCommand,
    decrypt: decryptCommand,
    key: keyCommand,
    validate: validateCommand,
    doctor: doctorCommand,
    watch: watchCommand,
  },
});

export function runMain(): Promise<void> {
  // The CLI is where the keychain is read and written; core stays native-free and
  // the runtime never registers a binding. Idempotent, and the binding is lazy —
  // the native module loads only if a keychain key is actually touched.
  setKeychain(defaultKeychain);
  return cittyRunMain(main);
}

export type {
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  DoctorSeverity,
} from "./commands/doctor.js";
export { renderDoctor, runDoctor } from "./commands/doctor.js";
export type { ResealResult } from "./commands/encrypt.js";
export { runDecrypt, runEncrypt } from "./commands/encrypt.js";
export type { FillOptions, FillPrompt, FillResult } from "./commands/fill.js";
export { renderFill, runFill } from "./commands/fill.js";
export type { GenerateResult } from "./commands/generate.js";
export { generateDotenv, runGenerate } from "./commands/generate.js";
export type { GetExplanation } from "./commands/get.js";
export { runExplain, runGet } from "./commands/get.js";
export type { ImportReport } from "./commands/import.js";
export { importDotenv } from "./commands/import.js";
export type {
  AdoptionPlan,
  CutoverPlan,
  CutoverResult,
  InitResult,
  InitStep,
} from "./commands/init.js";
export {
  applyCutover,
  insertEnvAlias,
  planAdoption,
  planCutover,
  runInit,
} from "./commands/init.js";
export type { ListResult } from "./commands/list.js";
export { runList } from "./commands/list.js";
export type { MigrateMove, MigratePlan, MigrateResult, MigrateStatus } from "./commands/migrate.js";
export { applyMigrate, planMigrate, renderMigrate, runMigrate } from "./commands/migrate.js";
export type { MoveResult } from "./commands/mv.js";
export { renderMove, runMove } from "./commands/mv.js";
export type { PullOptions, PullResult } from "./commands/pull.js";
export { renderPull, runPull } from "./commands/pull.js";
export type { PushOptions, PushResult } from "./commands/push.js";
export { LAST_PUSHED_KEY, renderPush, runPush } from "./commands/push.js";
export type { RemoveResult } from "./commands/remove.js";
export { runRemove } from "./commands/remove.js";
export type { RotateOptions, RotatePhase, RotateResult } from "./commands/rotate.js";
export { renderRotate, runRotate } from "./commands/rotate.js";
export type { RunOptions, RunResult, RunSource } from "./commands/run.js";
export { runRun } from "./commands/run.js";
export type { SetResult } from "./commands/set.js";
export { runSet } from "./commands/set.js";
export type { EnvironmentCheck, ValidateIssue, ValidateResult } from "./commands/validate.js";
export { checkEnvironment, runValidate } from "./commands/validate.js";
export type { WatchHandle, WatchOptions } from "./commands/watch.js";
export { renderWatch, runWatch } from "./commands/watch.js";
export type { CleanupResult, Cutover, UndoResult } from "./cutover.js";
export { runCleanup, runUndo } from "./cutover.js";
