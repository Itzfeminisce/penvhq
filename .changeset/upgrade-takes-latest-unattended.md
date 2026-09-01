---
"@penvhq/launcher": minor
---

**`penv upgrade --yes` now takes `latest`, the same default it takes interactively.** Unattended, upgrade used to demand an explicit version as well as the flag, so `penv upgrade --yes` refused with a remedy that told you to name one — even though version resolution has always defaulted to `latest` when none is given, exactly as `penv add` does. The consent and the version were two separate questions collapsed into one gate.

`--yes` is the whole consent now: it says somebody meant to rewrite the two committed files, and the version stays optional there as it is at a terminal. Naming a version still pins that version. A pipeline that wants today's pin rather than today's `latest` runs `penv install`, which is what the refusal has always named and still does.
