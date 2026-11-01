# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.7] — 2026-11-01

### Fixed
- `hooks.disable-failing` together with recipes that wire the same hook: undoing the batches in any order no longer loses a hook a live batch needs, and never leaves a hook that runs a deleted script; once every batch is undone the settings and hook scripts are back to where they started.
- A project upgraded through 0.1.5 that still runs the old shared-script `format-on-edit` / `verify-before-stop` hook next to the new one gets the old one removed (journaled, undoable) on the next apply.
- Failing hooks: a hook on an event whose runs cannot be estimated (Notification, PreCompact, SessionEnd, …) is offered for removal only when at least half of its recorded runs failed. Matchers are read as Claude Code reads them: `Edit, Write` and `Edit | Write` lists, unanchored regexes, legacy tool names (`Task` matches `Agent`, `KillShell` matches `TaskStop`, …) and the `Artifact` family.

### Known issues
- While a `hooks.disable-failing` batch is still in force, undoing in some orders a recipe applied after it can put the disabled hook back early, or leave a recipe applied after a second `disable-failing` batch without its hook until that batch is undone too. The final state after all undos is correct.

## [0.1.6] — 2026-11-01

### Fixed
- Failing hooks: Claude Code records a hook run only when the hook printed something or failed, so the recorded runs made almost any hook look like it fails every time. The run count is now estimated from the prompts, sessions and tool calls its matcher selects, only in the sessions (and, for project hooks, the project) where the hook left a record; when it cannot be estimated the rate is shown as unknown and the old absolute threshold applies. A mostly healthy hook is no longer offered for removal, an always-failing one still is.
- Cost: a relocated or forked copy of a session no longer adds its parent's cost again; the digest says the cost covers whole sessions and shows the part inside the window.
- Upgrading from 0.1.4: the old shared-script hook of `format-on-edit` / `verify-before-stop` is removed inside the new batch (undoing it puts the old hook back), instead of asking to undo the whole old batch with its other recipes.
- `settings.hook.remove` claims only removals in the settings files the run looked at, so undoing one project's batch restores its hooks; `plugins.disable` claims every layer where a live batch switched the plugin off; path comparisons for claims are case-insensitive on Windows.
- `apply --from-batch` re-applies the body of a `custom.*` recipe the batch used (stored in the journal), warns when an older journal has to fall back to the current draft, and leaves no temporary folder behind on errors.
- `undo --dry-run` reads the same settings cache as the simulation, so it matches the real run when a path is spelled with a different drive-letter case.

## [0.1.5] — 2026-11-01

### Added
- `kaizen paths` prints where Kaizen keeps its files for this run (the state directory and the files in it, as JSON). Skills and subagents read it instead of assuming `~/.claude/kaizen`.
- `apply --from-batch ID [--recipe a,b]` re-applies the recipes of a journaled batch with the scope and parameters that batch used (for example to drop one recipe of a batch: `undo <id>`, then `apply --from-batch <id> --recipe <the ones to keep>`).
- Measurement reads subagent transcripts, deduplicates forked sessions by uuid across files, counts PowerShell commands, and filters `--days` by the time of each line.

### Changed
- Failing hooks are judged by their failure rate: a hook is offered for removal when it fails in nearly every run, not when it has a handful of errors among thousands of runs.
- Project-specific hook scripts: a recipe meant for one project (`format-on-edit`, `verify-before-stop`) applied at project scope writes `<name>.<project key>.mjs`, so two projects keep their own formatter / mode. Every other hook (`guard-destructive`, `protect-secrets`, `session-context`, `precompact-handoff`, ...) keeps one shared script and command also at project scope, so the same hook installed at user and project scope is run once by Claude Code. The recommendation summary shows the real script name.
- `plugins.disable` switches a plugin off in every file that enables it: the user settings, and `settings.local.json` of the project when the project (or the local) settings enable it. The shared `.claude/settings.json` of the repository is never edited. Each change is journaled and `undo` restores it.

### Fixed
- Upgrading from 0.1.4: applying `format-on-edit` / `verify-before-stop` again in a project that already has the old shared-script hook now says which old batch to `undo`, instead of silently leaving two hooks.
- `undo` of a hook that stays because another batch still needs it prints the shared message, not "remove … hook".
- `apply --recipe` for a recipe that is not in the recommendations (`hooks.verify-before-stop`, `hooks.format-on-edit`) uses the recipe's own default scope (project) instead of forcing `user`.
- Re-applying a recipe (same script, a status line, a setting, a rules block, permissions) records that it relies on what the earlier batch wrote, so undoing the earlier batch no longer removes a script, setting or block the newer batch still needs. A script a 0.1.4 batch shares with another project's hook is kept on undo.
- `apply --dry-run` with several recipes and `undo --all --dry-run` simulate each step, so they print exactly what the real run does.
- The local console moves an old `choices.json` aside and exits with an error on timeout, so a stale selection is never applied.
- Measurement: SubagentStop runs and their failures are matched; decisions accepted by a saved permission rule are not counted as permission prompts and do not hide slow commands; scheduled-task and other non-human turns are not prompts; a correction needs an earlier answer; PowerShell deletes are recognised in command position only; PowerShell verbs no longer produce `Bash(...)` allow rules; `Invoke-Pester` counts as a test run.
- Docs: deleting the state folder removes the installed hook scripts and the undo journal, so run `undo --all` first; undo guidance for a run with several batches; skills and agents no longer assume `~/.claude/kaizen`.

## [0.1.4] — 2026-11-01

### Fixed
- Undo of shared hook scripts (`session-context` / `precompact-handoff`, or one recipe applied several times with different parameters):
  - each batch now keeps the content it wrote (`applied/<batch>/contents/`), so undoing the newest writer puts back the previous writer's version in any undo order, with no `--force`;
  - the script and its SessionStart hook are removed only when no live batch uses them;
  - a user edit is detected against the hash Kaizen itself wrote, so it is never deleted silently;
  - a user's own hook in a shared matcher group is kept while the Kaizen hook is removed;
  - `undo --all --dry-run` reports exactly what the real run does.
- `long-command-nudge`: the bodies of here-strings and heredocs (commit messages, file content) and the blocks of `Start-Job` and of `Start-Process` without `-Wait` are not read as commands. `Start-Process … -Wait`, `Wait-Job` and `Receive-Job -Wait` on a long job now get the nudge. `npx.cmd` and `pnpm.cmd exec` are recognised.
- A user-scope MCP server switched off with `/mcp` in one project is still offered for removal when it is unused everywhere; the result no longer depends on the folder `measure` ran in.
- `recommend --top N --add FILE` warns about `paramDefaults` of recipes cut off by `--top`.
- A custom recipe drafted again by `kaizen-analyst` is offered again only when its content changed (a digest is stored with the batch), and an applied catalog recipe stays applied even if the extra file lists its id.
- `kaizen-verifier` matches created skills and agents on Windows paths too. The apply and start skills always pass `--add ~/.claude/kaizen/extra-recipes.json` when custom recipes are in play.

## [0.1.3] — 2026-11-01

### Fixed
- Apply and undo: `session-context` and `precompact-handoff` share one hook script and one SessionStart matcher across batches. Applying the second recipe keeps the first one's parameters, and undoing either batch, in any order, leaves the script and the matcher alternatives the other batch still uses.
- `format-on-edit`: Python files get `ruff format` only (no `ruff check --fix`, which could change code); `dotnet format` gets an `--include` path relative to the project or solution and runs in its folder; `timeoutSec` is capped below the hook's own timeout.
- `session-context` shows non-ASCII file names in `git status` as they are, not as octal escapes.
- `long-command-nudge` works for the PowerShell tool too: long `Start-Sleep`, endless `while ($true)` loops, `Get-Content -Wait`, `ping -t`, watch modes.
- `kaizen-verifier` validates created skills and subagents with `claude plugin validate --strict` in a temporary plugin folder (the CLI cannot validate a single skill or `agents/` folder) and checks removals (`settings.hook.remove`, `plugins.disable`, local-scope `mcp.disable`).
- `kaizen-analyst` drafts rules and skills as `custom.*` recipes in `extra-recipes.json`, so drafted rules replace the `corrections` block instead of duplicating it and drafted skills are offered even when catalog thresholds are not met.
- Inventory: `.claude.json` project keys match Windows paths written in any form, plugins installed at local scope for another project are ignored, failing hooks from managed settings or plugins are reported but not offered for removal, servers turned off with `/mcp` are not "unused", hooks declared in `plugin.json` count, a non-empty `.config.json` wins over `.claude.json`, nested rule folders and ancestor `CLAUDE.md` files are counted.
- `recommend --add` warns about `paramDefaults` for recipes that were not recommended instead of dropping them silently.

## [0.1.2] — 2026-11-01

### Fixed
- Console: a secret parameter (Telegram bot token) was dropped from the submission whenever its recipe was not the first one selected.
- MCP servers whose names contain characters Claude Code rewrites in tool names (dots, spaces) were reported unused and preselected for removal; names are now compared the way Claude Code builds them.
- With `CLAUDE_CONFIG_DIR` set, the global `.claude.json` is read and written in the right place.
- Inventory: hooks shipped by enabled plugins count as installed (no duplicate hook suggestions), disabled plugins are ignored, managed settings are read, `AGENTS.md` and path-scoped rules are counted only when Claude Code would load them, dangling symlinks, BOM files and YAML block scalars no longer break `measure`.
- Recipes: `session-context` and `precompact-handoff` share one SessionStart matcher cleanly; `format-on-edit` supports dotnet format, rubocop, php-cs-fixer, swiftformat, ktlint, google-java-format, terraform fmt and shfmt; `skills.prune-unused` and ratio-based recipes fire only on real data; `.mcp.json` servers that are not enabled are not "unused".
- Metrics: test runs made by subagents count; waiting for a permission answer is not a slow command; documentation-only edits are not "edits without tests"; the slow-command total is no longer capped.
- `undo --dry-run` says what would be reverted instead of "Reverted"; the undo and start skills no longer suggest hand edits and explain how to undo several batches.

## [0.1.1] — 2026-11-01

### Added
- Hooks killed by their timeout are reported on their own (digest section, `friction.hookTimeouts`, the `advice.slow-hooks` recipe); cancelled runs no longer distort hook duration averages.
- The UI language chosen in `measure`/`recommend` is remembered by every later command (console, apply, undo, verify, status).
- `npx github:KROU4/claude-kaizen#<tag> <command>` documented as a zero-install way to run the CLI.

### Fixed
- Hook keys and failing-hook commands shown in the digest are secret-scrubbed; short status-message labels are kept whole instead of their first word.
- `guard-destructive`: SQL `DROP`/`TRUNCATE` in a heredoc is blocked when it feeds an interpreter or a framework DB shell (`python -`, `node`, `manage.py dbshell`, `rails dbconsole`), but not when it is only written to a file; SQL clients are matched by command name, not by paths such as `prisma/migrations/…`.
- `apply`: unknown recipe ids no longer create an empty batch, `--param`/`--param-file` typos are errors listing the valid names, user errors print one localized line instead of a stack trace (`KAIZEN_DEBUG=1` shows it), apply/undo plans are localized.
- `verify` finds Kaizen hooks whatever the state directory is called and reports missing hook or status-line scripts.
- `undo --force` after a partial undo always backs up the current files first (one backup folder per undo run).
- Console: localized page title, `lang` attribute and select option labels; secret parameters are never kept in `localStorage`.
- `deny-secrets` evidence no longer contradicts itself when deny rules already exist.

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
