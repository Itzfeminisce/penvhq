#!/usr/bin/env node
/**
 * The `penv` bin entry — `npx penv import .env`.
 *
 * The command tree lives in `@penvhq/cli` and is bundled into this file at publish
 * time, so the CLI's dependencies land in the tarball rather than in a consuming
 * application's dependency graph. Nothing here imports `./index.js`: the runtime
 * surface and the command line are separate entries on purpose.
 */

import { runMain } from "@penvhq/cli";

void runMain();
