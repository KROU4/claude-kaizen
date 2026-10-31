# Security

## What Kaizen touches

Kaizen reads your local Claude Code data (`~/.claude/projects/**/*.jsonl`, `~/.claude/usage-data`, settings files, `~/.claude.json`) and writes to:

- `~/.claude/settings.json` and, for project scope, `.claude/settings.json` (hooks, permissions, keys);
- `CLAUDE.md` (marked blocks);
- `~/.claude/skills/<name>/SKILL.md` and `~/.claude/agents/<name>.md` (user scope) or `<project>/.claude/skills/` and `<project>/.claude/agents/` (project scope), which Claude Code loads into every session;
- `~/.claude/kaizen/` (state, digest, journal, backups, installed hook and status line scripts);
- for one recipe, `~/.claude.json` (removing an MCP server definition, with a backup in the journal).

Every write is journaled and reversible with `undo`; `apply --dry-run` prints each target first. Kaizen makes no network requests, with two opt-in exceptions: the Telegram notification hook, which only runs if you provide a bot token and chat id, and the artifact console described below.

**Artifact console (Claude desktop app only).** The console can be published as a private claude.ai artifact. In that mode the recommendations (titles, evidence text, parameter defaults) are part of the published page, and what you tick, the parameters you type and your note are written to the artifact's database until Claude reads them and deletes the document. Do not share the artifact link, and never type secrets into it: Claude asks for a Telegram bot token in chat instead. Anyone with write access to a shared artifact can write to that database, so Claude shows you the selection and gets your confirmation in chat before applying anything that came back from an artifact. The local browser console and the terminal flow never leave your machine.

## Threat model we design for

- **Secrets in transcripts.** Transcripts contain whatever your tools printed. Kaizen's digest keeps counts plus short snippets of *your own prompts*, scrubbed by `scripts/lib/redact.mjs`. Tool output and assistant text are never retained. The digest (and the scrubbed samples in `measure.json`) is the only transcript-derived data any model or subagent is told to use; none of them reads transcripts directly. Report any secret pattern that slips through.
- **Hooks run as you.** Every hook script Kaizen installs is in `recipes/templates/hooks/`, is self-contained, never shells out with user-controlled strings unquoted, and exits 0 on internal errors so it cannot block you by accident. Read them before applying; they are short.
- **Config corruption.** Every write goes through an atomic rename with a backup copy in `~/.claude/kaizen/applied/<batch>/backups/`. `undo` restores.
- **Supply chain.** No dependencies. The plugin is installed from this repository's `main` branch; pin a tag if you prefer (`/plugin install kaizen@claude-kaizen` after `claude plugin marketplace add KROU4/claude-kaizen` uses the marketplace's `main`).

## Reporting

Open a private security advisory on GitHub (Security → Report a vulnerability) or an issue without the exploit details. Please include the Kaizen version (`node scripts/kaizen.mjs --version`) and your OS. Expect an answer within a week.
