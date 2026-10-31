---
name: undo
description: Revert changes Kaizen applied — the last batch, a specific batch id, or everything — restoring settings, removing installed hooks, rule blocks, skills and agents. Use when the user wants to roll back, disable or remove something Kaizen set up.
argument-hint: "[batch-id | --all]"
allowed-tools: Bash(node "*kaizen.mjs" *) Read
---

# Kaizen undo

1. Kit root = `${CLAUDE_PLUGIN_ROOT}` or the clone path. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" status` as one literal line (no shell variable or alias) and list the applied batches (id, date, recipe ids) in the user's language.
2. Decide the target: the batch the user named, `--last` (default) or `--all`. If the user names a single recipe inside a multi-recipe batch, explain that undo works per batch and offer only the whole batch: undo it, then re-apply the recipes the user wants to keep with `apply --recipe <ids>`. Never edit `settings.json`, `CLAUDE.md` or `~/.claude.json` by hand to remove one item: only `apply` and `undo` write there, and a hand edit would make a later `undo` of that batch report "kept: … modified since apply".
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" undo <id|--all> --dry-run` → show what will be reverted. A dry run changes nothing: its last line says "Dry run: nothing reverted. N change(s) … would be reverted", so do not tell the user the undo has happened yet.
4. `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" undo <id|--all>`. Items reported as "kept: … modified since apply" were changed by the user after Kaizen wrote them; Kaizen leaves them alone — say which ones. The batch then stays in the journal as partly undone: running `undo <id>` again retries only the kept items, and `undo <id> --force` reverts them anyway after saving their current state under `applied/<id>/undo/backups/`. Offer `--force` only after the user has looked at what they would lose.
5. Confirm the result and remind that a restart of the Claude Code session may be needed for hook changes to take effect.
