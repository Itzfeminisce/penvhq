---
"@penvhq/launcher": patch
"@penvhq/cli": patch
---

`upgrade` finishes in a workspace, `add` runs unattended when it has nothing to ask, and penv's own releases carry provenance

`penv upgrade` shelled `pnpm add` without `-w`, which a pnpm workspace root refuses, and then printed that same command as the remedy. The install plan now detects the workspace root, and no failure remediation repeats the command that just failed. It also moved only the root `package.json`: every workspace package declaring `@penvhq/penv` is now in the one consent diff, named line by line, because a package holding its own older copy is an older bridge running under the pin.

`penv add` refused every unattended run before discovering it had nothing to ask — an `@penvhq/*` add takes no trust decision, so the gate stopped a run that would have been silent. It now refuses only for the trust ceremony, whose one field is a sentence no flag can write, and takes `--yes` to say nobody is here to be asked. Its `penv.config.ts` offer is one question naming every environment it would repoint, not one question per environment.

penv's own packages shipped with no npm provenance attestation while the official trust tier rests on one: pnpm 11 publishes natively and reads no `npm_config_*`, so the release workflow's `NPM_CONFIG_PROVENANCE` reached nobody, and no published `package.json` carried the `repository` npm's provenance check requires. Both are fixed, the launcher's own publish states `--provenance` outright, and the release verifier warns loudly when the registry records no attestation.
