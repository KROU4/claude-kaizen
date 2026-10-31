---
name: undo
description: Revert changes Kaizen applied — the last batch, a specific batch id, or everything — restoring settings, removing installed hooks, rule blocks, skills and agents. Use when the user wants to roll back, disable or remove something Kaizen set up.
argument-hint: "[batch-id | --all]"
allowed-tools: Bash(node "*kaizen.mjs" *) Read
---

# Kaizen undo

1. Kit root = `${CLAUDE_PLUGIN_ROOT}` or the clone path. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" status` as one literal line (no shell variable or alias) and list the applied batches (id, date, recipe ids) in the user's language.
2. Decide the target: the batch the user named, `--last` (default) or `--all`. If the user names a single recipe inside a multi-recipe batch, explain that undo works per batch, and offer either the whole batch or a manual removal of that one item through a new batch (`apply` with the opposite setting is not available; manual edit is acceptable here and must be reported).
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" undo <id|--all> --dry-run` → show what will be reverted.
4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" undo <id|--all>`. Items reported as "kept: … modified since apply" were changed by the user after Kaizen wrote them; Kaizen leaves them alone — say which ones.
5. Confirm the result and remind that a restart of the Claude Code session may be needed for hook changes to take effect.
