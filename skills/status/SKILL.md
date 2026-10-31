---
name: status
description: Show Kaizen's state — when the last measurement ran, how many recommendations are open, which batches were applied or undone, and whether the weekly nudge is on. Use when the user asks what Kaizen changed, what is pending, or whether it is time to re-measure.
allowed-tools: Bash(node *) Read
---

# Kaizen status

1. `KZ='node "<kit root>/scripts/kaizen.mjs"'`; run `$KZ status` and `$KZ doctor` (both print JSON, nothing sensitive).
2. Report in the user's language, ≤ 12 lines: last measurement date and window; open recommendations (count, high-impact count); applied batches with their recipes and dates; undone batches; nudge setting; environment facts that matter (Node version, Claude Code version, transcripts found).
3. Suggest the next action: `/kaizen:start` if the measurement is older than a week or recommendations are open; `/kaizen:measure` to see whether friction changed after the last batch.
