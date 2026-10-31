---
name: recipes
description: Browse the Kaizen recipe catalog — every hook, rule, skill, subagent, permission and settings change Kaizen can apply, with the evidence that triggers each one. Use when the user asks what Kaizen can do, wants to see all options, or asks why a recipe was (not) recommended.
argument-hint: "[category | recipe-id]"
allowed-tools: Bash(node *) Read
---

# Kaizen recipes

1. `KZ='node "<kit root>/scripts/kaizen.mjs"'`; run `$KZ recommend --all --json` (needs a measurement; run `$KZ measure --quiet` first if it complains). Every recipe comes back with `matched: true|false`, its rendered evidence and its actions.
2. Present the catalog grouped by category in the user's language: id, title, impact, whether it matches the user's data right now, and the one-line evidence. Keep it scannable (a table or tight bullets). For a single id, show everything: why, evidence, exact actions, parameters, undo behaviour (`docs/recipes.md` in the kit has the full generated reference).
3. If the user asks why something was not recommended, explain the trigger (`when`) against their numbers from `~/.claude/kaizen/measure.md`.
4. Offer `/kaizen:apply <id>` for anything they want regardless of the trigger.
