# Claude Code surfaces Kaizen writes to

Condensed from the official docs at code.claude.com/docs (fetched 2026-10-31). This is the contract the recipe templates, the `kaizen-smith` agent and the apply engine follow. When the docs and this file disagree, the docs win; open an issue.

## settings.json

Files, lowest to highest precedence: `~/.claude/settings.json` (user) → `.claude/settings.json` (project, committed) → `.claude/settings.local.json` (project local, git-excluded) → `--settings` → managed. Lists such as `permissions.allow` merge across files. Strict JSON, no comments. `CLAUDE_CONFIG_DIR` relocates `~/.claude`. `~/.claude.json` is the global config (account, user-scope MCP servers, trust) — Kaizen only ever reads it, except the `mcp.disable` action which moves one `mcpServers` entry into a backup and can restore it.

Keys Kaizen touches:

| Key | Shape | Notes |
|---|---|---|
| `permissions.allow` / `ask` / `deny` | `string[]` | Rule syntax `Tool` or `Tool(specifier)`: `Bash(npm run *)`, `Read(./.env)`, `Read(./secrets/**)`, `WebFetch(domain:example.com)`, `mcp__server__tool`, `Agent(Explore)`, `Skill(name)`. `deny` wins over `ask` over `allow`. Bash rules match the command as written and compound commands are split on `&&`, `||`, `;`, `|`. Never allowlist interpreters (`Bash(python3 *)`) or shells. |
| `permissions.defaultMode` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `bypassPermissions` | `auto` and `bypassPermissions` only take effect from user or managed settings. |
| `hooks` | `{ "<Event>": [ { "matcher": "...", "hooks": [ {handler} ] } ] }` | See below. Layers merge additively, so a duplicate hook in two files runs twice — Kaizen dedupes by command string before writing. |
| `statusLine` | `{ "type": "command", "command": "...", "padding": 0, "refreshInterval": 5 }` | Stdin JSON includes `model.display_name`, `context_window.used_percentage`, `cost.total_cost_usd`, `workspace.current_dir`, `rate_limits.five_hour/seven_day.used_percentage`, `prompt_cache`, `worktree`. |
| `language` | string, e.g. `"russian"` | Claude replies in this language. |
| `cleanupPeriodDays` | integer ≥ 1 (default 30) | Transcript retention; also bounds what `/insights` and Kaizen can see. |
| `alwaysThinkingEnabled`, `effortLevel`, `outputStyle`, `model` | | Read for the inventory only. |
| `enabledPlugins` | `{ "name@marketplace": bool }` | Disabling an unused plugin removes its skills/agents from every prompt. |
| `enabledMcpjsonServers` / `disabledMcpjsonServers` | `string[]` | Project `.mcp.json` servers. |
| `attribution` | `{ commit, pr, sessionUrl }` | Replaces deprecated `includeCoAuthoredBy`. Not written by Kaizen (value types unverified). |
| `autoMemoryEnabled`, `autoMemoryDirectory` | | Auto memory lives in `~/.claude/projects/<project>/memory/`. |

## Hooks

33 events. The ones Kaizen's recipes use:

| Event | Matcher | Can block (exit 2 / `decision: block`) | Useful JSON output |
|---|---|---|---|
| `PreToolUse` | tool name (`Bash`, `Edit\|Write`, regex) | yes | `hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"\|"deny"\|"ask", permissionDecisionReason, updatedInput, additionalContext }` |
| `PostToolUse` | tool name | no | `hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext }` |
| `Stop` | none | yes | top-level `{ decision: "block", reason }`; `stop_hook_active` in stdin is true when a Stop hook already blocked this turn — never block twice |
| `SessionStart` | `startup` \| `resume` \| `clear` \| `compact` | no | `hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }`, plain stdout also reaches Claude |
| `PreCompact` | `manual` \| `auto` | yes | stdin has `transcript_path`, `trigger` |
| `Notification` | `permission_prompt` \| `idle_prompt` \| … | no | stdin `message`, `title`, `notification_type` |
| `UserPromptSubmit` | none | yes | `additionalContext`; plain stdout reaches Claude |
| `PermissionRequest` | tool name | via decision | `hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow"\|"deny", updatedInput, message } }` |

Handler fields: `type` (`command` \| `http` \| `mcp_tool` \| `prompt` \| `agent`), `command` (+ optional `args` array = exec form, no shell quoting problems on Windows), `timeout` (seconds; default 600, 30 on `UserPromptSubmit`), `async` (background, cannot block), `statusMessage`, `if` (one permission rule, e.g. `"Bash(git push *)"`, evaluated on tool events only), `onFailure` (`continue` default \| `block`).

Common stdin fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; tool events add `tool_name`, `tool_input`, `tool_use_id`; `PostToolUse` adds `tool_response`, `duration_ms`.

Exit codes: `0` success (stdout may be one JSON object), `2` blocking error (stderr is the reason) on blockable events, anything else non-blocking error shown to the user. `systemMessage` in JSON output shows a warning-style line to the user on any event. `additionalContext`, `systemMessage` and stdout are capped at 10 000 characters.

Variables: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` (changes on plugin update — never store state there), `${CLAUDE_PLUGIN_DATA}` (persistent per plugin). Kaizen installs hook scripts into `~/.claude/kaizen/hooks/` and references them by absolute path with the absolute Node binary, so they keep working when the plugin updates or when the kit was used without installing it.

## Skills

`<dir>/skills/<name>/SKILL.md`; user skills in `~/.claude/skills`, project skills in `.claude/skills`, plugin skills invoked as `/<plugin>:<name>`. Frontmatter (lowercase, hyphenated):

```yaml
---
name: verify
description: What it does and when to use it (the model matches on this)
argument-hint: "[what to verify]"
disable-model-invocation: false   # true = only the user can invoke
user-invocable: true              # false = hidden from the / menu
allowed-tools: Bash(git status *) Read   # pre-approved for the invoking turn; space-separated; `*` may sit mid-pattern; never pre-approve a whole interpreter (`Bash(node *)`) - Kaizen's skills allow only `Bash(node "*kaizen.mjs" *)`, the hook self-tests and `claude plugin validate`. A Bash rule is matched against the literal command text (quotes are not stripped), `*` matches any text including spaces, and a trailing ` *` also matches the bare command; the skills write `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" <sub> ...`, so the rule carries the quote on both sides of the script path (the earlier `Bash(node *kaizen.mjs *)` needs `kaizen.mjs` followed by a space and never matched the quoted form)
context: fork                     # optional: run in a subagent
agent: general-purpose            # subagent type when forked
model: sonnet                     # optional
paths: ["src/**/*.ts"]           # optional: auto-load only for matching files
---
```

`$ARGUMENTS`, `$0`/`$1`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}` (plugin skills). `` !`command` `` runs before the skill is read and inlines its output. Keep `SKILL.md` under 500 lines; put detail in sibling files. A skill folder is live-reloaded; new top-level directories need `/reload-skills`.

## Subagents

`~/.claude/agents/<name>.md` or `.claude/agents/<name>.md` (camelCase keys):

```yaml
---
name: test-runner
description: Runs the project's tests and reports only failures. Use proactively after edits.
tools: Bash, Read, Grep, Glob
disallowedTools: Write, Edit
model: haiku          # sonnet | opus | haiku | inherit | full model id
maxTurns: 30
memory: project       # optional persistent notes dir
omitClaudeMd: true    # skip CLAUDE.md to save context
color: cyan
---
System prompt body.
```

Subagents never get `AskUserQuestion`, `EnterPlanMode`/`ExitPlanMode`. Plugin agents ignore `hooks`, `mcpServers`, `permissionMode`. Combined agent descriptions over 15 000 tokens trigger a startup warning.

## CLAUDE.md and rules

Loaded every session: `~/.claude/CLAUDE.md`, `./CLAUDE.md` or `./.claude/CLAUDE.md`, `./CLAUDE.local.md`, plus `@imports`. Path-scoped rules: `.claude/rules/*.md` (project) or `~/.claude/rules/*.md` (user) with frontmatter `paths: ["src/api/**/*.ts"]` load only when matching files are touched. Guidance: keep CLAUDE.md under ~200 lines; move conditional detail into rules or skills. Kaizen writes into a managed block:

```markdown
<!-- kaizen:start read-before-edit -->
...rule text...
<!-- kaizen:end read-before-edit -->
```

so `undo` removes exactly that block.

## Plugins and marketplaces

Plugin root: `.claude-plugin/plugin.json` (only `name` required; kebab-case; names starting with `claude-`, `anthropic-`, `cc-plugin-` are rejected), `skills/`, `agents/`, `hooks/hooks.json` (`{"hooks": {...}}` wrapper), `.mcp.json`, `scripts/`. A `CLAUDE.md` at the plugin root is not loaded. Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner {name}`, `plugins[] {name, source: "./path" | {source: "github", repo}}`. Install: `claude plugin marketplace add owner/repo`, then `claude plugin install name@marketplace` (or `/plugin …` in a session). `claude plugin validate <path> [--strict]` checks manifests, skills and agents. `claude --plugin-dir ./path` loads a plugin for one session. Plugin skills are `/<plugin>:<skill>`; hooks in `hooks/hooks.json` may use `${CLAUDE_PLUGIN_ROOT}`.

## Local data Kaizen reads

| Path | Content | Kaizen use |
|---|---|---|
| `~/.claude/projects/<cwd-with-non-alnum-as-dash>/<session>.jsonl` | Full transcript: `user`, `assistant`, `system`, `attachment`, `cost-state`, … lines | Everything in `measure.json`. Assistant lines are deduplicated by `requestId`, repeated lines (resume/fork) by `uuid`; `isSidechain` lines are subagent traffic. |
| `~/.claude/projects/<p>/<session>/subagents/*.jsonl` | Subagent transcripts | Skipped; mirrored as sidechain lines. |
| `~/.claude/usage-data/facets/*.json`, `session-meta/*.json` | Written by the built-in `/insights`: outcome, satisfaction, friction types, tool error categories | Aggregated when present. |
| `~/.claude/history.jsonl` | Typed prompts with project and timestamp | Not needed; transcripts already contain prompts. |
| `~/.claude/settings.json`, `.claude/settings*.json`, `~/.claude.json`, `.mcp.json` | Configuration | Inventory. `env` values are masked. |
| `~/.claude/skills`, `agents`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` | Installed extensions | Unused skill / plugin detection. |

Retention: `cleanupPeriodDays` (default 30) deletes older transcripts at startup, so a 30-day window is the realistic default.
