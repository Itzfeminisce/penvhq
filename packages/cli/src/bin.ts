#!/usr/bin/env node
/**
 * The engine's executable, which is what the launcher spawns.
 *
 * It is named `penv-engine` rather than `penv`: the global `penv` belongs to the
 * launcher, and a project's engine is reached through it, never instead of it.
 *
 * This file is built as one self-contained CommonJS bundle, because an engine
 * installed from an npm tarball into `$PENV_HOME` has no `node_modules` beside
 * it. jiti is registered from here rather than resolved by core for that reason:
 * a static import is what lets the bundler carry it.
 */

import { setJitiApi } from "@penvhq/core";
import { createJiti } from "jiti";
import { runMain } from "./index.js";

setJitiApi({ createJiti });
void runMain();
