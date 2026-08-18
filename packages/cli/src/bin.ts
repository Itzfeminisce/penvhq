#!/usr/bin/env node
/**
 * The engine's executable, which is what the launcher spawns.
 *
 * It is named `penv-engine` rather than `penv`: the global `penv` belongs to the
 * launcher, and a project's engine is reached through it, never instead of it.
 */

import { runMain } from "./index.js";

void runMain();
