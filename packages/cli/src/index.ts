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
import { doctorCommand } from "./commands/doctor.js";
import { decryptCommand, encryptCommand } from "./commands/encrypt.js";
import { generateCommand } from "./commands/generate.js";
import { getCommand } from "./commands/get.js";
import { importCommand } from "./commands/import.js";
import { initCommand } from "./commands/init.js";
import { keyCommand } from "./commands/key.js";
import { listCommand } from "./commands/list.js";
import { mvCommand } from "./commands/mv.js";
import { pushCommand } from "./commands/push.js";
import { removeCommand } from "./commands/remove.js";
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
    mv: mvCommand,
    push: pushCommand,
    remove: removeCommand,
    list: listCommand,
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
export type { GenerateResult } from "./commands/generate.js";
export { generateDotenv, runGenerate } from "./commands/generate.js";
export type { GetExplanation } from "./commands/get.js";
export { runExplain, runGet } from "./commands/get.js";
export type { ImportReport } from "./commands/import.js";
export { importDotenv } from "./commands/import.js";
export type { InitResult, InitStep } from "./commands/init.js";
export { insertEnvAlias, runInit } from "./commands/init.js";
export type { ListResult } from "./commands/list.js";
export { runList } from "./commands/list.js";
export type { MoveResult } from "./commands/mv.js";
export { renderMove, runMove } from "./commands/mv.js";
export type { PushOptions, PushResult } from "./commands/push.js";
export { LAST_PUSHED_KEY, renderPush, runPush } from "./commands/push.js";
export type { RemoveResult } from "./commands/remove.js";
export { runRemove } from "./commands/remove.js";
export type { SetResult } from "./commands/set.js";
export { runSet } from "./commands/set.js";
export type { ValidateIssue, ValidateResult } from "./commands/validate.js";
export { runValidate } from "./commands/validate.js";
export type { WatchHandle, WatchOptions } from "./commands/watch.js";
export { renderWatch, runWatch } from "./commands/watch.js";
