---
name: undo
description: Revert changes Kaizen applied — the last batch, a specific batch id, or everything — restoring settings, removing installed hooks, rule blocks, skills and agents. Use when the user wants to roll back, disable or remove something Kaizen set up.
argument-hint: "[batch-id | --all]"
allowed-tools: Bash(node *) Read
---

# Kaizen undo

1. `KZ='node "<kit root>/scripts/kaizen.mjs"'`. Run `$KZ status` and list the applied batches (id, date, recipe ids) in the user's language.
2. Decide the target: the batch the user named, `--last` (default) or `--all`. If the user names a single recipe inside a multi-recipe batch, explain that undo works per batch, and offer either the whole batch or a manual removal of that one item through a new batch (`$KZ apply` with the opposite setting is not available; manual edit is acceptable here and must be reported).
3. `$KZ undo <id|--all> --dry-run` → show what will be reverted.
4. `$KZ undo <id|--all>`. Items reported as "kept: … modified since apply" were changed by the user after Kaizen wrote them; Kaizen leaves them alone — say which ones.
5. Confirm the result and remind that a restart of the Claude Code session may be needed for hook changes to take effect.
