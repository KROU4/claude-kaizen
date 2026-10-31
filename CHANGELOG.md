# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0] — 2026-10-31

First public release.

### Added
- `measure`: streaming scanner for `~/.claude/projects` transcripts with per-file cache, `/insights` facet aggregation, configuration inventory, 60+ metrics, bilingual digest (`measure.md`).
- `recommend`: evidence-based recipe engine (JSON conditions, scoring, bilingual rendering) over a catalog of 31 recipes in 12 categories.
- `console`: interactive selection page served locally or rendered for a claude.ai artifact; `AskUserQuestion` fallback described in the `start` skill.
- `apply` / `undo`: journaled, idempotent, reversible writes to settings.json (hooks, permissions, keys), hook scripts, skills, subagents, CLAUDE.md marked blocks, MCP server removal, plugin disabling.
- Hook templates: destructive-command guard, secret-file guard, format-on-edit, verify-before-stop, notifications (OS/Telegram), session-start context, pre-compaction handoff, long-command nudge; status line script.
- `verify`: self-tests installed hooks and the status line, parses touched settings files, checks CLAUDE.md markers.
- "What moved" table at the end of the digest comparing the current measurement with the previous one.
- Failing-hook detection per command (`friction.failingHooks`) and the `hooks.disable-failing` recipe that removes such entries reversibly.
- Plugin packaging (`.claude-plugin/`), six skills (`start`, `measure`, `apply`, `undo`, `status`, `recipes`), three subagents (`kaizen-analyst`, `kaizen-smith`, `kaizen-verifier`), weekly SessionStart nudge, a `claude plugin eval` case.
- English and Russian throughout; language auto-detected from the user's prompts.
- 890+ tests on synthetic fixtures; CI on Linux, macOS and Windows with Node 18, 20, 22 and 24; `claude plugin validate --strict` in CI.
- `choices --import <FILE|->` validates a choices file (artifact answer, hand-written or chat-built) and writes `choices.json`; `apply --param-file <recipe>.<name>=<path>` takes a multi-line parameter value from a file; `apply --add FILE` and `recommend --add FILE` handle extra recipes (the path is remembered, so `custom.*` recipes drafted by the analyst can be applied).

### Fixed
- Privacy boundary: `kaizen-smith` no longer greps or reads raw transcripts; it works from the digest and the scrubbed samples in `measure.json`, as the README, FAQ, SECURITY and AGENTS state. The analyst and smith lost their `Grep`/`Glob` tools.
- Skills: the `KZ='node "…"'; $KZ …` alias (which failed in bash and bypassed the allowlist) is replaced by literal full commands; `allowed-tools` is narrowed from `Bash(node *)` to the Kaizen script, hook self-tests and `claude plugin validate`; ad-hoc `node -e` JSON checks are replaced by `verify`.
- Artifact console: no `sleep` polling (the skill ends its turn and waits for "done" in chat); the answer is imported through `choices --import` (validated), shown to the user and confirmed in chat before applying, and `notes` is treated as data, not instructions; the footer, README, FAQ and SECURITY now say plainly that choices and parameters pass through the private artifact's database, and secrets such as a Telegram bot token are asked in chat (new `console.footer_artifact` string).
- Drafted rules and skill text are applied through `--param-file` (multi-line `--param` values were rejected); `custom.*` recipes no longer get silently skipped by `apply`.
- Docs: recipe count (31 in 12 categories), `verify` and `settings.hook.remove` in `docs/architecture.md`, skills and agents directories in the SECURITY.md write list, `verify` wording (settings files it writes; `--project` for project scope; `~/.claude.json` is checked by `kaizen-verifier`), `history.jsonl` removed from `docs/prior-art.md`.
- CI matrix: Node 18 on every OS and Node 24 added.
- `permissions.allowlist-readonly` suggests only strictly read-only commands; runners, interpreters and commands that can write or delete are never put into `permissions.allow`.
- Apply and undo: list parameters are no longer flattened to strings (`hooks.disable-failing` lost commands), `mcp.disable` handles local-scope servers and reports names it could not find, the first backup of a file in a batch is kept, CLAUDE.md blocks are LF-normalised and hash-checked on undo, a partly undone batch stays in the journal (`undo <id> --force` finishes it), recipes that wrote nothing are not recorded as applied, scopes other than `user`/`project` are rejected, boolean flags no longer swallow the next argument, choices files are validated.
- Console: the local server checks `Host`/`Origin`; secret parameters are never pre-filled, are disabled in artifact mode and are not kept in `localStorage`.
- Hooks: `protect-secrets` covers PowerShell; `guard-destructive` inspects heredocs that feed a shell or SQL client (and only those), collapses `..` in paths and understands `bash -o …` options.
- Scanner: `!` shell turns are not prompts, sidechain edits are not counted against the main session, interrupted tools are not tool errors, each hook run is counted once, test-failure detection covers pytest/mocha/node:test/dotnet/go without matching linters, redaction covers prefixed `*_PASSWORD=`/`*_SECRET=`, AWS keys, quoted JSON keys and `Authorization` headers, and unused MCP/skills are reported only with enough sessions.
