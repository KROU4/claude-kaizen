# Security

## What Kaizen touches

Kaizen reads your local Claude Code data (`~/.claude/projects/**/*.jsonl`, `~/.claude/usage-data`, settings files, `~/.claude.json`) and writes to `~/.claude/settings.json`, `.claude/settings.json`, `CLAUDE.md`, `~/.claude/kaizen/` and, for one recipe, `~/.claude.json` (removing an MCP server definition, with a backup in the journal). It never makes network requests except the optional Telegram notification hook, which only runs if you provide a bot token and chat id.

## Threat model we design for

- **Secrets in transcripts.** Transcripts contain whatever your tools printed. Kaizen's digest keeps counts plus short snippets of *your own prompts*, scrubbed by `scripts/lib/redact.mjs`. Tool output and assistant text are never retained. Report any secret pattern that slips through.
- **Hooks run as you.** Every hook script Kaizen installs is in `recipes/templates/hooks/`, is self-contained, never shells out with user-controlled strings unquoted, and exits 0 on internal errors so it cannot block you by accident. Read them before applying; they are short.
- **Config corruption.** Every write goes through an atomic rename with a backup copy in `~/.claude/kaizen/applied/<batch>/backups/`. `undo` restores.
- **Supply chain.** No dependencies. The plugin is installed from this repository's `main` branch; pin a tag if you prefer (`/plugin install kaizen@claude-kaizen` after `claude plugin marketplace add KROU4/claude-kaizen` uses the marketplace's `main`).

## Reporting

Open a private security advisory on GitHub (Security → Report a vulnerability) or an issue without the exploit details. Please include the Kaizen version (`node scripts/kaizen.mjs --version`) and your OS. Expect an answer within a week.
