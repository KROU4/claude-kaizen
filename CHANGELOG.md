# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0] — 2026-10-31

First public release.

### Added
- `measure`: streaming scanner for `~/.claude/projects` transcripts with per-file cache, `/insights` facet aggregation, configuration inventory, 60+ metrics, bilingual digest (`measure.md`).
- `recommend`: evidence-based recipe engine (JSON conditions, scoring, bilingual rendering) over a catalog of 30 recipes in 10 categories.
- `console`: interactive selection page served locally or rendered for a claude.ai artifact; `AskUserQuestion` fallback described in the `start` skill.
- `apply` / `undo`: journaled, idempotent, reversible writes to settings.json (hooks, permissions, keys), hook scripts, skills, subagents, CLAUDE.md marked blocks, MCP server removal, plugin disabling.
- Hook templates: destructive-command guard, secret-file guard, format-on-edit, verify-before-stop, notifications (OS/Telegram), session-start context, pre-compaction handoff, long-command nudge; status line script.
- `verify`: self-tests installed hooks and the status line, parses touched settings files, checks CLAUDE.md markers.
- "What moved" table at the end of the digest comparing the current measurement with the previous one.
- Failing-hook detection per command (`friction.failingHooks`) and the `hooks.disable-failing` recipe that removes such entries reversibly.
- Plugin packaging (`.claude-plugin/`), six skills (`start`, `measure`, `apply`, `undo`, `status`, `recipes`), three subagents (`kaizen-analyst`, `kaizen-smith`, `kaizen-verifier`), weekly SessionStart nudge, a `claude plugin eval` case.
- English and Russian throughout; language auto-detected from the user's prompts.
- 450+ tests on synthetic fixtures; CI on Linux, macOS and Windows with Node 18–22; `claude plugin validate --strict` in CI.
