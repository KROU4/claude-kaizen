# Claude Code surfaces Kaizen writes to

Condensed from the official docs at code.claude.com/docs (fetched 2026-10-31). This is the contract the recipe templates, the `kaizen-smith` agent and the apply engine follow. When the docs and this file disagree, the docs win; open an issue.

## settings.json

Files, lowest to highest precedence: `~/.claude/settings.json` (user) → `.claude/settings.json` (project, committed) → `.claude/settings.local.json` (project local, git-excluded) → `--settings` → managed. Lists such as `permissions.allow` merge across files. Strict JSON, no comments. `CLAUDE_CONFIG_DIR` relocates `~/.claude`. `~/.claude.json` is the global config (account, user-scope MCP servers, trust) — Kaizen only ever reads it, except the `mcp.disable` action which moves one `mcpServers` entry into a backup and can restore it. **With `CLAUDE_CONFIG_DIR` set the global config is `$CLAUDE_CONFIG_DIR/.claude.json`** (not the default profile's `~/.claude.json`); an old `<config dir>/.config.json` wins only when it is a regular file that is non-empty, or writable while `.claude.json` does not exist (an empty leftover or a directory of that name is ignored). The `projects` map is keyed with forward slashes on Windows (and compared case-insensitively there); `paths.mjs projectConfigKey()` finds the entry of a native path. `paths.mjs globalConfigPath()` is the single place that knows the file location; inventory and `apply` both use it.

Managed settings (read-only for Kaizen, never a write target, so not part of `settingsFiles()`): `managed-settings.json`, then every `managed-settings.d/*.json` in alphabetical order (later wins; hidden and non-`.json` files are ignored), in `C:\Program Files\ClaudeCode\` (Windows), `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux, WSL). Kaizen reads their hooks, deny rules, `defaultMode` and `enabledPlugins` as the top layer. `KAIZEN_MANAGED_SETTINGS_DIR` overrides the directory (tests).

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
| `enabledMcpjsonServers` / `disabledMcpjsonServers` / `enableAllProjectMcpServers` | `string[]` / `string[]` / bool | Project `.mcp.json` servers need approval: one is active only when enabled (listed in `enabledMcpjsonServers`, or `enableAllProjectMcpServers: true`) and not in `disabledMcpjsonServers`. The approval is also recorded per project in `~/.claude.json` (`projects[<dir>]`); Kaizen merges both. A disabled or not-yet-approved server is not loaded, so `context.mcp-unused` ignores it. A server of any scope switched off with `/mcp` is listed in `projects[<dir>].disabledMcpServers`; it is not connected in that project either (`inventory.mcp.disabledHere`), so it is ignored as well. |
| `attribution` | `{ commit, pr, sessionUrl }` | Replaces deprecated `includeCoAuthoredBy`. Not written by Kaizen (value types unverified). |
| `autoMemoryEnabled`, `autoMemoryDirectory` | | Auto memory lives in `~/.claude/projects/<project>/memory/`. |

MCP tool names are `mcp__<server>__<tool>`, where `<server>` is the configured name with every character outside `[a-zA-Z0-9_-]` replaced by `_` (`used.srv` → `used_srv`). Kaizen compares the normalised configured name with the transcript key exactly (no substring match) and keeps the configured name for actions. Servers a plugin provides appear as `plugin_<plugin>_<server>` and are not user-configured servers.

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

Loaded every session: `~/.claude/CLAUDE.md`, `./CLAUDE.md` or `./.claude/CLAUDE.md`, `./CLAUDE.local.md`, plus `@imports`. `AGENTS.md` and `.claude/AGENTS.md` are read **only when the project has none of `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`** (default `claude-md-or-agents-md`), or when a CLAUDE.md imports them (`@AGENTS.md`). The check looks at the project directory **and every ancestor directory** up to (not including) the filesystem root, so a monorepo root with a `CLAUDE.md` suppresses the AGENTS.md of a subpackage; `~/.claude/CLAUDE.md` (the user file) and `.claude/rules/` do not count for that check. Kaizen adds AGENTS.md to `claudeMdTokens` and to the rule hints only in those cases. Rules are found recursively (`.claude/rules/frontend/style.md` loads like a top-level rule). Rules with a non-empty `paths:` frontmatter are not counted in `claudeMdTokens` (reported as `conditionalFiles`). Path-scoped rules: `.claude/rules/*.md` (project) or `~/.claude/rules/*.md` (user) with frontmatter `paths: ["src/api/**/*.ts"]` load only when matching files are touched. Guidance: keep CLAUDE.md under ~200 lines; move conditional detail into rules or skills. Kaizen writes into a managed block:

```markdown
<!-- kaizen:start read-before-edit -->
...rule text...
<!-- kaizen:end read-before-edit -->
```

so `undo` removes exactly that block.

## Plugins and marketplaces

Plugin root: `.claude-plugin/plugin.json` (only `name` required; kebab-case; names starting with `claude-`, `anthropic-`, `cc-plugin-` are rejected), `skills/`, `agents/`, `hooks/hooks.json` (`{"hooks": {...}}` wrapper; the manifest's `hooks` may also be an inline object or a path / array of paths relative to the plugin), `.mcp.json`, `scripts/`. A `CLAUDE.md` at the plugin root is not loaded. Marketplace: `.claude-plugin/marketplace.json` with `name`, `owner {name}`, `plugins[] {name, source: "./path" | {source: "github", repo}}`. Install: `claude plugin marketplace add owner/repo`, then `claude plugin install name@marketplace` (or `/plugin …` in a session). `claude plugin validate <path> [--strict]` checks manifests, skills and agents. `claude --plugin-dir ./path` loads a plugin for one session. Plugin skills are `/<plugin>:<skill>`; hooks in `hooks/hooks.json` may use `${CLAUDE_PLUGIN_ROOT}`.

## Local data Kaizen reads

| Path | Content | Kaizen use |
|---|---|---|
| `~/.claude/projects/<cwd-with-non-alnum-as-dash>/<session>.jsonl` | Full transcript: `user`, `assistant`, `system`, `attachment`, `cost-state`, … lines | Everything in `measure.json`. Assistant lines are deduplicated by `requestId`, repeated lines (resume/fork) by `uuid`; `isSidechain` lines are subagent traffic. |
| `~/.claude/projects/<p>/<session>/subagents/*.jsonl` | Subagent transcripts | Skipped; mirrored as sidechain lines. |
| `~/.claude/usage-data/facets/*.json`, `session-meta/*.json` | Written by the built-in `/insights`: outcome, satisfaction, friction types, tool error categories | Aggregated when present. |
| `~/.claude/history.jsonl` | Typed prompts with project and timestamp | Not needed; transcripts already contain prompts. |
| `~/.claude/settings.json`, `.claude/settings*.json`, `~/.claude.json`, `.mcp.json` | Configuration | Inventory. `env` values are masked. |
| `~/.claude/skills`, `agents`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` | Installed extensions | Unused skill / plugin detection. A plugin with `enabledPlugins: false` (effective value over user, project, local, managed) contributes no skills, agents or hooks. The installed entry is chosen as Claude Code does: `local` scope for this `projectPath`, then `project`, then `user` (an entry without a scope is a legacy user install). A plugin installed only at `local`/`project` scope for **other** projects is not installed here and is left out of the inventory. Enabled plugins' hooks (`hooks/hooks.json` and the `hooks` of `.claude-plugin/plugin.json`, an inline object or file paths that stay inside the plugin) count toward `hasSessionStartHook`, `hasPreCompactHook`, `hasNotifyHook`, `hasGuardHook`, `hasFormatterHook` with scope `plugin:<name>`, but are never offered for removal (nor are failing hooks of managed settings: `settings.hook.remove` edits only user, project and local settings; they stay in `friction.failingHooks` with `source`); Kaizen's own plugin is skipped. |

Frontmatter (skills, agents, rules) is read after stripping a leading BOM; block scalars (`description: >-` / `|`), continuation lines and block lists are joined.

Retention: `cleanupPeriodDays` (default 30) deletes older transcripts at startup, so a 30-day window is the realistic default.
