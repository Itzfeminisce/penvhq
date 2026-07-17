#!/usr/bin/env node
/**
 * The `penv` bin entry for the scoped `@penvhq/cli` package.
 *
 * Mirrors `packages/penv/src/cli.ts`, but ships from `@penvhq/cli` so the command
 * is installable from the `@penvhq` scope. The unscoped `penv` name is taken on
 * npm by an unrelated package, so the umbrella `penv` package stays unpublished
 * and the CLI is delivered here instead. Unlike the umbrella, `@penvhq/cli` does
 * not bundle its workspace deps — they resolve from this package's own deps.
 */
import { runMain } from "./index.js";

void runMain();
