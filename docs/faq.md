# FAQ

**Does anything leave my machine?**
No. Kaizen reads local files and writes local files. There is no telemetry and no network call, with one opt-in exception: the notification recipe can post to a Telegram bot if you give it a token and chat id. In the Claude desktop app the console is a published artifact, so your *recommendations* (titles, evidence numbers, parameters) are stored with that private artifact; transcripts never are.

**What does the model see?**
Only `~/.claude/kaizen/measure.md`: counts, histograms and short secret-scrubbed snippets of your own prompts. The `start` skill forbids reading transcripts directly.

**Why Node and not Python?**
Claude Code users already have Node, and most prior tools that chose Python/uv stayed niche. Zero dependencies also means nothing to audit beyond this repository.

**How accurate is the cost figure?**
It is the sum of what Claude Code itself records per session (`cost-state` lines), labelled "reported". Sessions without that record are not estimated. Treat it as a lower bound.

**Why are my permission prompts counted differently from what I remember?**
Kaizen counts decisions whose source starts with `user_` (you answered a prompt). Decisions made by a mode, a rule, a hook or the auto-mode classifier are counted separately as auto-accepts.

**I run Claude Code over SSH with no browser. Does the console work?**
The `start` skill falls back to multiple-choice questions in the terminal (`AskUserQuestion`), or a numbered list if that is unavailable. From a shell you can also write `choices.json` by hand and run `apply`.

**How does undo decide what to keep?**
Every write is journaled with what was there before. Undo restores settings keys, removes exactly the list items and hook entries it added, removes its marked CLAUDE.md block, and deletes files only when their content hash still matches what Kaizen wrote. Anything you edited afterwards is left in place and reported as "kept".

**Can I use it in a team repository?**
Yes: choose `project` scope in the console for recipes that belong in `.claude/settings.json` and `.claude/skills` of the repository (allowlist, formatter hook, verify-before-stop, test-runner agent). User-scoped recipes stay in `~/.claude`.

**Does it conflict with `/insights` or `/fewer-permission-prompts`?**
No. Kaizen reads the facets `/insights` leaves behind and reuses the allowlist idea with a scope choice and an interpreter blocklist. Run them in any order.

**It recommended removing an MCP server I need.**
"Unused" means zero calls in the measurement window. Untick it in the console, or `undo` after the fact: the server definition is restored from the journal.

**Where is everything?**
`~/.claude/kaizen/`: `measure.json`, `measure.md`, `recommendations.json`, `choices.json`, `hooks/` (installed scripts), `applied/<batch>/` (manifests and backups), `cache/`. Delete the folder to start over; installed hooks keep working until you `undo` them.

**How do I turn off the weekly reminder?**
`~/.claude/kaizen/config.json` → `{"nudge": false}`. The reminder is a single line at session start and runs in a few milliseconds.
