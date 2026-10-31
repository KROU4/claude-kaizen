---
name: apply
description: Apply one or more Kaizen recipes by id (or the saved choices.json) with a dry run first, then verify. Use when the user names recipes to apply, says "apply the hook/rule/permissions recipe", or wants to re-apply after editing choices.
argument-hint: "<recipe-id[,recipe-id]> [--scope user|project] [--param id.name=value] | choices.json"
allowed-tools: Bash(node *) Read
---

# Kaizen apply

1. `KZ='node "<kit root>/scripts/kaizen.mjs"'`. If `~/.claude/kaizen/recommendations.json` is missing or older than a day, run `$KZ measure --quiet` and `$KZ recommend --json` first.
2. Map the user's words to recipe ids (`$KZ recommend --all --json` lists every recipe with its id and whether its conditions currently match). Prefer matching recipes; if the user insists on a non-matching one, apply it anyway and say the evidence did not call for it.
3. `$KZ apply --recipe <ids> --dry-run [--scope …] [--param id.name=value]` → show the plan in ≤ 10 lines in the user's language.
4. `$KZ apply --recipe <ids> …` (same flags). Report written vs skipped items. Skips with "file exists and was not created by Kaizen" need the user's `--force` decision — ask once.
5. Verify: for hook recipes run `node ~/.claude/kaizen/hooks/<name>.mjs --selftest`; for settings changes run `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <settings file>`.
6. Say that `/kaizen:undo` reverts this batch (its id is printed by `apply`).

Never edit settings.json, CLAUDE.md or ~/.claude.json by hand; only through `$KZ apply`.
