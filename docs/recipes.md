# Recipe catalog

Generated from `recipes/catalog.json` (31 recipes). Do not edit by hand; run `node scripts/kaizen.mjs docs`.

## permissions

### `permissions.allowlist-readonly` — Stop asking for read-only commands you run all the time

*Не спрашивать разрешение на read-only команды, которые вы запускаете постоянно*

- Impact: **high**, risk: low, scope: project / user
- Why: Every interactive permission prompt costs a context switch. Strictly read-only commands (git status, git diff, git log, ls, grep, ...) are safe to pre-approve; runners (npm run, make, npx, test runners), interpreters, shells and anything that writes or deletes are never included.
- Trigger: `{"all":[{"metric":"friction.permissionPrompts","gte":10},{"metric":"sessions.bypassShare","lt":0.8},{"metric":"tools.suggestedAllowRules.length","gte":3}]}`
- Actions: settings.append permissions.allow
- Inspired by: Anthropic /fewer-permission-prompts algorithm; everyinc claude-permissions-optimizer

### `permissions.deny-secrets` — Deny reads of .env files, keys and credentials

*Запретить чтение .env, ключей и учётных данных*

- Impact: **medium**, risk: low, scope: user / project
- Why: Secrets read into the context end up in transcripts on disk and in model inputs. Deny rules block the Read/Edit tools and common shell readers on those paths.
- Trigger: `{"not":{"metric":"context.denyRulesText","includes":".env"}}`
- Actions: settings.append permissions.deny
- Inspired by: dwarvesf/claude-guardrails deny set; Claude Code permissions docs

### `permissions.accept-edits` — Switch to acceptEdits mode: approve file edits automatically, keep asking for commands

*Режим acceptEdits: правки файлов без подтверждения, команды — по-прежнему с вопросом*

- Impact: **medium**, risk: medium, scope: user / project
- Why: You almost never reject an edit, yet each one prompts. acceptEdits auto-approves file edits and common filesystem commands while Bash still asks.
- Trigger: `{"all":[{"metric":"friction.permissionPrompts","gte":30},{"metric":"friction.userRejections","lte":5},{"metric":"sessions.bypassShare","lt":0.5},{"metric":"autonomy.defaultPermissionMode","in":["default","manual",null]}]}`
- Actions: settings.set permissions.defaultMode

## hooks

### `hooks.guard-destructive` — Guard against destructive commands (rm -rf /, git reset --hard, force-push to main)

*Защита от разрушительных команд (rm -rf /, git reset --hard, force-push в main)*

- Impact: **high**, risk: low, scope: user / project
- Why: A PreToolUse hook inspects every Bash command before it runs and denies (or asks about) the handful of patterns that destroy work. It allows rm -rf node_modules and force-with-lease on feature branches.
- Trigger: `{"all":[{"any":[{"metric":"quality.destructiveCommands","gte":3},{"metric":"quality.forcePushes","gte":1}]},{"metric":"context.hasGuardHook","falsy":true}]}`
- Actions: file → {kaizenHome}/hooks/guard-destructive.mjs; settings.hook PreToolUse
- Inspired by: yurukusa/cc-safe-setup, dwarvesf/claude-guardrails, this user's block-force-push hook

### `hooks.protect-secrets` — Block tools from opening secret files (.env, *.pem, ~/.ssh)

*Не давать инструментам открывать файлы с секретами (.env, *.pem, ~/.ssh)*

- Impact: **medium**, risk: low, scope: user / project
- Why: Deny rules cover Read/Edit; this hook also catches cat/type/Get-Content in Bash and PowerShell, and explains to Claude how to ask you for a single value instead.
- Trigger: `{"all":[{"not":{"metric":"context.hookCommandsText","includes":"protect-secrets"}},{"metric":"totals.sessions","gte":5}]}`
- Actions: file → {kaizenHome}/hooks/protect-secrets.mjs; settings.hook PreToolUse

### `hooks.format-on-edit` — Auto-format every file Claude edits ({languages.formatter})

*Автоформатирование каждого файла после правки ({languages.formatter})*

- Impact: **medium**, risk: low, scope: project / user
- Why: Formatting noise wastes review attention and lint-fix round trips. A PostToolUse hook runs the project's formatter on the edited file only when that formatter is already installed.
- Trigger: `{"all":[{"metric":"totals.filesEdited","gte":20},{"metric":"context.hasFormatterHook","falsy":true},{"not":{"metric":"languages.formatter","eq":"auto"}}]}`
- Actions: file → {kaizenHome}/hooks/format-on-edit.mjs; settings.hook PostToolUse

### `hooks.session-context` — Inject git state and the last handoff note at session start

*Подставлять состояние git и последнюю заметку-передачу в начале сессии*

- Impact: **medium**, risk: low, scope: user / project
- Why: Claude starts every session blind. A SessionStart hook adds branch, recent commits, uncommitted files and the handoff saved before the last compaction, so you stop re-explaining where you were.
- Trigger: `{"all":[{"metric":"totals.sessions","gte":10},{"any":[{"metric":"context.hasSessionStartHook","falsy":true},{"all":[{"metric":"context.hookEvents.SessionStart","lte":1},{"metric":"context.hookCommandsText","includes":"session-context."}]}]}]}`
- Actions: file → {kaizenHome}/hooks/session-context.mjs; settings.hook SessionStart

### `hooks.long-command-nudge` — Nudge Claude to background or time-limit commands that tend to hang

*Подталкивать Claude запускать в фоне или с таймаутом команды, которые зависают*

- Impact: **medium**, risk: low, scope: user / project
- Why: Dev servers, ssh, docker compose up without -d and tail -f block the tool for minutes until a timeout. The hook adds a one-line hint before such commands; it never changes or blocks them.
- Trigger: `{"all":[{"any":[{"metric":"tools.slowCommandsTotal","gte":20},{"metric":"friction.timeouts","gte":10}]},{"not":{"metric":"context.hookCommandsText","includes":"long-command-nudge"}}]}`
- Actions: file → {kaizenHome}/hooks/long-command-nudge.mjs; settings.hook PreToolUse

### `hooks.disable-failing` — Remove hooks that fail on nearly every run

*Убрать хуки, которые падают почти при каждом запуске*

- Impact: **high**, risk: medium, scope: user
- Why: A hook that exits with an error on every call adds latency and noise to every turn and is silently not doing what you installed it for. Kaizen removes the entry from settings.json (the script file stays; undo puts the entry back) so you can fix it calmly.
- Trigger: `{"metric":"friction.failingHookCommands.length","gte":1}`
- Actions: settings.hook.remove
- Inspired by: yurukusa/cc-safe-setup --verify (hook failure taxonomy)

## quality

### `hooks.verify-before-stop` — Refuse to finish a turn that changed code without running tests or lint

*Не завершать ход, если код изменён, а тесты или линтер не запускались*

- Impact: **high**, risk: medium, scope: project / user
- Why: A Stop hook inspects the current turn: source files changed but no test/lint/type-check command ran → Claude is sent back once to verify (or to say why it is not needed). Never blocks twice in a row.
- Trigger: `{"all":[{"metric":"quality.editsWithoutTestsShare","gte":0.3},{"metric":"quality.sessionsWithEdits","gte":5},{"not":{"metric":"context.hookCommandsText","includes":"verify-before-stop"}}]}`
- Actions: file → {kaizenHome}/hooks/verify-before-stop.mjs; settings.hook Stop
- Inspired by: oh-my-claudecode verification principle; Anthropic /verify skill

## workflow

### `hooks.notify` — Desktop (or Telegram) notification when Claude waits for you or finishes

*Уведомление на рабочий стол (или в Telegram), когда Claude ждёт вас или закончил*

- Impact: **medium**, risk: low, scope: user
- Why: Long turns mean you switch away; a notification brings you back the moment Claude needs a decision or is done, instead of minutes later.
- Trigger: `{"all":[{"any":[{"metric":"habits.responseGapMedianSec","gte":120},{"metric":"sessions.longSessions","gte":3}]},{"metric":"context.hasNotifyHook","falsy":true}]}`
- Actions: file → {kaizenHome}/hooks/notify.mjs; settings.hook Notification; settings.hook Stop

## context

### `hooks.precompact-handoff` — Save a handoff note before every compaction

*Сохранять заметку-передачу перед каждой компакцией*

- Impact: **high**, risk: low, scope: user / project
- Why: Compaction summaries lose file paths and the exact last instructions. A PreCompact hook writes the last prompts, edited files and commands to a note that the session-context hook re-injects after compaction.
- Trigger: `{"all":[{"metric":"friction.compactions","gte":3},{"metric":"context.hasPreCompactHook","falsy":true}]}`
- Actions: file → {kaizenHome}/hooks/precompact-handoff.mjs; settings.hook PreCompact; file → {kaizenHome}/hooks/session-context.mjs; settings.hook SessionStart
- Inspired by: coleam00/claude-memory-compiler PreCompact safety net

### `claude-md.diet` — Your CLAUDE.md is large: move conditional rules into path-scoped rule files

*CLAUDE.md разросся: вынести условные правила в файлы с привязкой к путям*

- Impact: **medium**, risk: low, scope: user
- Why: Everything in CLAUDE.md is paid for on every request. Rules that only matter for some files belong in .claude/rules/*.md with `paths:` frontmatter; procedures belong in skills loaded on demand.
- Trigger: `{"any":[{"metric":"context.claudeMdTokens","gte":3000},{"metric":"context.claudeMdLines","gte":200}]}`
- Actions: advice only (Claude discusses it with you)
- Inspired by: Anthropic memory docs (200-line guidance); Naorn/token-optimizer

### `skills.prune-unused` — Disable plugins whose skills you never use

*Отключить плагины, скиллы которых вы не используете*

- Impact: **medium**, risk: low, scope: user
- Why: Every installed skill's description is in the prompt of every request. Plugins with zero invocations in the window can be disabled (not uninstalled) and re-enabled in one command. A plugin counts as used when any of its skills or commands ran, one of its subagents was spawned or one of its MCP servers was called; a plugin that ships hooks is never offered, because disabling it would switch the hooks off too.
- Trigger: `{"all":[{"metric":"skills.unusedShare","gte":0.5},{"metric":"skills.installed","gte":20},{"metric":"skills.unusedPlugins.length","gte":1}]}`
- Actions: plugins.disable
- Inspired by: Anthropic /skill-doctor; rohitg00 skills-janitor

### `advice.context-pressure` — Sessions regularly hit the context ceiling

*Сессии регулярно упираются в потолок контекста*

- Impact: **medium**, risk: low, scope: user
- Why: Compaction loses detail and costs tokens. Delegating searches and test runs to subagents, using /clear between unrelated tasks and the handoff hook keep the main window small.
- Trigger: `{"any":[{"metric":"context.sessionsOver150k","gte":3},{"all":[{"metric":"friction.compactionShare","gte":0.2},{"metric":"friction.sessionsWithCompaction","gte":3},{"metric":"totals.sessions","gte":10}]}]}`
- Actions: advice only (Claude discusses it with you)

## claude-md

### `claude-md.language` — Always answer in your language (detected: {locale.lang})

*Всегда отвечать на вашем языке (определён: {locale.lang})*

- Impact: **high**, risk: low, scope: user
- Why: You write most prompts in a non-English language but no rule or setting says so, so replies drift to English after long turns. One rule plus the `language` setting fixes it everywhere.
- Trigger: `{"all":[{"metric":"locale.lang","eq":"ru"},{"any":[{"metric":"context.claudeMdHints.language","falsy":true},{"metric":"context.settingsLanguage","falsy":true}]}]}`
- Actions: settings.set language; claude-md.block

### `claude-md.read-before-edit` — Rule: re-read a file right before editing it

*Правило: перечитывать файл непосредственно перед правкой*

- Impact: **high**, risk: low, scope: user / project
- Why: Edit failures (old_string not found, file changed since read) cost a full round trip each. A short rule about re-reading after shell commands and preferring small edits removes most of them.
- Trigger: `{"all":[{"metric":"friction.editMismatches","gte":5},{"metric":"context.claudeMdHints.readBeforeEdit","falsy":true}]}`
- Actions: claude-md.block

### `claude-md.autonomy` — Rule: proceed with sensible defaults instead of asking

*Правило: действовать по разумному умолчанию, а не спрашивать*

- Impact: **medium**, risk: low, scope: user / project
- Why: You run Claude with permissions off most of the time, yet it still stops to ask questions. A rule that lists when a question is justified (secrets, destructive actions, contradictory requirements) keeps turns moving.
- Trigger: `{"all":[{"metric":"sessions.bypassShare","gte":0.6},{"metric":"autonomy.askPerSession","gte":0.3},{"metric":"context.claudeMdHints.autonomy","falsy":true}]}`
- Actions: claude-md.block

### `claude-md.verify-before-done` — Rule: run the project's checks before saying done

*Правило: прогонять проверки проекта перед словом «готово»*

- Impact: **medium**, risk: low, scope: user / project
- Why: Softer alternative to the Stop hook: a rule asking Claude to run tests/lint/build and show the output before declaring completion.
- Trigger: `{"all":[{"metric":"quality.editsWithoutTestsShare","gte":0.3},{"metric":"quality.sessionsWithEdits","gte":5},{"metric":"context.claudeMdHints.verification","falsy":true}]}`
- Actions: claude-md.block

### `claude-md.corrections` — Turn your repeated corrections into standing rules

*Превратить ваши повторяющиеся исправления в постоянные правила*

- Impact: **high**, risk: low, scope: user / project
- Why: Prompts that start with “no”, “don't”, “again”, «не надо», «опять» are rules you keep paying for. Claude drafts them from the samples below; you edit the text; it lands in a managed CLAUDE.md block.
- Trigger: `{"metric":"friction.corrections","gte":5}`
- Actions: claude-md.block
- Inspired by: BayramAnnakov/claude-reflect correction queue; bokan/claude-skill-self-improvement

## skills

### `skills.from-repeated-prompts` — Package your most repeated request as a skill

*Упаковать самый частый повторяющийся запрос в скилл*

- Impact: **high**, risk: low, scope: user / project
- Why: A request you type the same way again and again is a workflow. As a skill it gets a name, a checklist and arguments, and Claude can run it in one step with the steps you actually want.
- Trigger: `{"metric":"habits.repeatedStemsCount","gte":2}`
- Actions: skill
- Inspired by: claude-reflect v2 workflow→skill; Anthropic skill-creator

## agents

### `agents.code-reviewer` — Add a code-reviewer subagent and ask for a review before commits

*Добавить субагента code-reviewer и просить ревью перед коммитами*

- Impact: **medium**, risk: low, scope: user / project
- Why: Reviews in a separate context catch what the author context rationalises away, and keep the main conversation small. The agent reports findings by severity; it cannot edit files.
- Trigger: `{"all":[{"metric":"quality.commits","gte":10},{"metric":"delegation.share","lt":0.2},{"not":{"metric":"inventory.agentNames","includes":"code-reviewer"}}]}`
- Actions: agent; claude-md.block

### `agents.test-runner` — Add a cheap test-runner subagent so test output stays out of your main context

*Добавить дешёвого субагента test-runner, чтобы вывод тестов не засорял основной контекст*

- Impact: **medium**, risk: low, scope: user / project
- Why: Test logs are long and mostly irrelevant. A Haiku-class subagent runs the suite and returns only failures with file:line, saving the main context and tokens.
- Trigger: `{"all":[{"metric":"quality.testCommands","gte":20},{"not":{"metric":"inventory.agentNames","includes":"test-runner"}}]}`
- Actions: agent

## mcp

### `context.mcp-unused` — Remove MCP servers you never call ({mcp.unused})

*Убрать MCP-серверы, которые вы не вызываете ({mcp.unused})*

- Impact: **high**, risk: medium, scope: user
- Why: Each connected MCP server adds all of its tool schemas to every request (typically 1–15k tokens) and startup latency. Kaizen moves the server definition into a backup so one undo restores it.
- Trigger: `{"metric":"mcp.unusedCount","gte":1}`
- Actions: mcp.disable
- Inspired by: kgraph57/claude-code-doctor MCP bloat finding

## settings

### `settings.cleanup-period` — Keep transcripts for 90 days so trends stay measurable

*Хранить транскрипты 90 дней, чтобы тренды оставались измеримыми*

- Impact: **low**, risk: low, scope: user
- Why: Claude Code deletes transcripts after cleanupPeriodDays (30 by default). A longer window lets /insights and Kaizen compare before and after a change.
- Trigger: `{"all":[{"metric":"totals.sessions","gte":30},{"metric":"context.cleanupPeriodDays","falsy":true}]}`
- Actions: settings.set cleanupPeriodDays

## statusline

### `statusline.install` — Status line with model, context %, cost, branch and rate-limit pace

*Строка состояния: модель, контекст %, стоимость, ветка и темп лимитов*

- Impact: **medium**, risk: low, scope: user
- Why: You cannot manage context you cannot see. A zero-dependency Node status line shows how full the window is before compaction hits, what the session costs and how much of the 5-hour / weekly limit is used.
- Trigger: `{"metric":"context.statusLine","falsy":true}`
- Actions: file → {kaizenHome}/statusline.mjs; settings.set statusLine
- Inspired by: ccstatusline, CCometixLine, Anthropic /statusline

## advice

### `advice.hook-health` — Hooks are failing — find out which

*Хуки падают — выяснить какие*

- Impact: **high**, risk: low, scope: user
- Why: Failing hooks add latency and error noise to every tool call and often mean the behaviour you wanted is silently not happening. Kaizen removes a hook from your settings only when it fails in at least half of its runs (20+ errors). Failures that are rarer, or come from plugin or project hooks, or from hooks already removed, need a manual look: samples with stderr and the failure rate of each hook are in measure.md.
- Trigger: `{"all":[{"metric":"friction.hookNonBlockingErrors","gte":20},{"metric":"friction.failingHookCommands.length","lt":1}]}`
- Actions: advice only (Claude discusses it with you)
- Inspired by: yurukusa/cc-safe-setup --verify (hook failure taxonomy)

### `advice.slow-hooks` — Some hooks take seconds or hit their timeout

*Некоторые хуки работают по несколько секунд или упираются в таймаут*

- Impact: **medium**, risk: low, scope: user
- Why: Hooks run synchronously unless marked async. Anything averaging over ~1.5 s on Stop or PreToolUse is felt on every turn, and a hook killed by its timeout both delays the turn by the full limit and silently skips its check. Make it async, cache its work, raise a too-tight timeout, or drop it.
- Trigger: `{"any":[{"metric":"friction.slowHooks.length","gte":1},{"metric":"friction.hookTimeouts.length","gte":1}]}`
- Actions: advice only (Claude discusses it with you)

### `advice.subagent-models` — Route mechanical subagent work to cheaper models

*Отдавать механическую работу субагентов более дешёвым моделям*

- Impact: **medium**, risk: low, scope: user
- Why: Exploration, test running and formatting do not need the top model. Setting `model: haiku` or `sonnet` in those agents' frontmatter cuts cost and speeds them up without touching your main model.
- Trigger: `{"all":[{"metric":"delegation.spawns","gte":20},{"not":{"metric":"delegation.models","includes":"haiku"}}]}`
- Actions: advice only (Claude discusses it with you)

### `advice.plan-mode` — Start big tasks in plan mode

*Начинать большие задачи в режиме плана*

- Impact: **medium**, risk: low, scope: user
- Why: Long sessions that never plan tend to accumulate corrections and compactions. Shift+Tab into plan mode (or a deep-interview style skill) front-loads the thinking and shortens execution.
- Trigger: `{"all":[{"metric":"sessions.longSessions","gte":5},{"metric":"sessions.planShare","lt":0.05}]}`
- Actions: advice only (Claude discusses it with you)

### `advice.insights-friction` — What /insights says goes wrong most often

*Что по данным /insights ломается чаще всего*

- Impact: **medium**, risk: low, scope: user
- Why: The built-in /insights already labelled your sessions. Kaizen aggregates the friction types so Claude can propose concrete rules or skills for the top two.
- Trigger: `{"all":[{"metric":"insights.available","truthy":true},{"metric":"insights.frictionTotal","gte":10}]}`
- Actions: advice only (Claude discusses it with you)

## Metrics recipes can test

| Metric | Meaning |
|---|---|
| `totals.sessions` | Sessions in the window |
| `totals.userMessages` | Human-written prompts (slash commands and tool results excluded) |
| `totals.costUSD` | Sum of per-session cost as recorded by Claude Code (cost-state lines, counted once per session). It is the cost of whole sessions: a session that began before the window contributes all of it |
| `totals.costPartialSessions` | Sessions in costUSD that began before the window (their cost includes time outside it) |
| `totals.costInWindowUSD` | Part of costUSD that belongs to sessions entirely inside the window |
| `totals.cacheHitRate` | cache_read / (input + cache_read + cache_create) across assistant messages |
| `sessions.bypassShare` | Share of user turns in bypassPermissions or dontAsk mode |
| `sessions.longSessions` | Sessions with 40+ human prompts |
| `tools.errorRate` | tool_result is_error / tool_use |
| `tools.slowCommandsTotal` | Bash commands that took 30 s or longer |
| `tools.suggestedAllowRules` | Strictly read-only Bash verbs (git status/diff/log, ls, grep, ...; never runners or writers) run 3+ times, formatted as permission rules; rules already in an allow list are left out |
| `friction.interruptions` | User pressed Esc while Claude worked |
| `friction.compactions` | Context compactions (summaries injected into sessions) |
| `friction.permissionPrompts` | Permission decisions made interactively (not by mode, rule, hook or classifier) |
| `friction.userRejections` | Tool uses the user rejected |
| `friction.corrections` | Prompts that start like a correction ("no, ...", "don't", "нет, ...", "не надо") |
| `friction.editMismatches` | Edit tool failures (old_string not found, file changed since read) |
| `friction.userModifiedEdits` | Edits where the user had changed the file manually in between |
| `friction.timeouts` | Timed-out tool calls plus timeout-looking errors |
| `friction.hookNonBlockingErrors` | Hook runs that reported an error (non-blocking) |
| `friction.hookRuns` | Hook runs Claude Code recorded (a lower bound: a hook that succeeds without output leaves no record) |
| `friction.hookRunsEstimated` | Hook runs with every configured hook raised to the runs it had the chance to make (prompts, tool uses of its matcher, sessions) in the window; failure rates use only the sessions where that hook left a record |
| `friction.failingHookCommands` | Configured hook commands that failed 20+ times in the window and, when their runs can be counted, in at least half of them (when they cannot, in at least half of the runs that were recorded) |
| `friction.flakyConfiguredHooks` | Failing hooks that are configured in user, project or local settings but stay below the removal threshold of failingHookCommands (fewer than 20 errors, or under half of their runs) |
| `friction.slowHooks` | Hooks averaging 1.5 s+ or peaking at 10 s+ (completed runs only) |
| `friction.hookTimeouts` | Hooks that were killed for exceeding their timeout: count and the configured limit |
| `autonomy.askUserQuestions` | AskUserQuestion tool uses |
| `delegation.share` | Share of sessions that spawned subagents |
| `skills.unusedCount` | Installed skills never invoked in the window (0 when the window has fewer than 3 sessions) |
| `mcp.unusedCount` | Configured MCP servers with zero calls in the window (0 when the window has fewer than 3 sessions) |
| `context.peakTokensMax` | Largest prompt (input + cache) seen in one request |
| `context.claudeMdTokens` | Estimated tokens of all CLAUDE.md / rules files that load every session |
| `quality.editsWithoutTestsShare` | Share of sessions that edited files but never ran a test command |
| `quality.destructiveCommands` | rm -rf, git reset --hard, DROP TABLE and similar |
| `quality.forcePushes` | git push --force / -f / --force-with-lease |
| `habits.repeatedStemsCount` | Distinct prompt openings repeated 3+ times (skill candidates) |
| `habits.nightShare` | Share of prompts sent 23:00–06:00 |
| `languages.primary` | Most edited programming languages (by file extension) |
| `locale.lang` | Detected dialog language (ru when 30%+ of prompt text is Cyrillic) |
| `insights.frictionTotal` | Friction events counted by the built-in /insights facets, when present |
| `insights.dissatisfiedShare` | Share of /insights satisfaction labels that read dissatisfied/frustrated |

