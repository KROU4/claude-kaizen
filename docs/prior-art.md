# Prior art

Research notes gathered on 2026-10-31 while designing Kaizen. Star counts are from that day. See the gap matrix at the end for how Kaizen positions itself.


Research date: 2026-10-31. Stars and "pushed" dates come from the GitHub API on that day (`gh search repos`, `gh api repos/...`). READMEs of ~60 repos were analysed; official behaviour was checked against code.claude.com docs (hooks, permissions, settings, skills, plugins), the `anthropics/claude-plugins-official` tree, and the local `~/.claude/usage-data` layout written by the built-in `/insights`.

Our kit: (1) read local data (`~/.claude/projects/*.jsonl`, `usage-data/facets`, settings, existing hooks/skills/agents), (2) short interactive dialog, (3) apply reversible config changes (hooks, skills, subagents, CLAUDE.md rules, permission allowlists, statusline, MCP cleanup) with markdown/JSON + Node only.

## 1. Transcript and usage analytics

| Repo | Stars | Pushed | What it does | Borrow | Gaps |
|---|---|---|---|---|---|
| ccusage/ccusage (ryoppippi) | 19,279 | 2026-10-31 | Daily/weekly/monthly/session token+cost reports from local JSONL of several agent CLIs; statusline mode | npx zero-install; multi-source discovery; offline pricing; statusline via hook | Pure accounting; changes nothing |
| Maciek-roboblog/Claude-Code-Usage-Monitor | 8,788 | 2026-07 | Live rate-limit monitor + usage warehouse | Provenance labels (`official` / `local_estimate` / `unknown`); machine-readable `--once --write-state` with exit codes | Python/uv; limits only |
| sirmalloc/ccstatusline | 13,478 | 2026-10-31 | TUI statusline builder; writes `statusLine` into settings.json | TUI that writes settings for you; config export/import; version-pinning advice | npx startup latency |
| Haleclipse/CCometixLine | 3,518 | 2026-10-24 | Rust statusline with configurator, `subagentStatusLine` | 30+ metrics incl. 5h/weekly pace; presets | Binary install |
| chiphuyen/sniffly | 1,277 | 2025-08 | Local dashboard: usage patterns, error breakdown, message-history analysis, shareable dashboard | Error taxonomy from tool results; share with privacy options; no telemetry | Python/uv; stale; read-only |
| daaain/claude-code-log | 1,253 | 2026-10 | JSONL -> HTML/MD/JSON + TUI archive | `--depth agent --compact` for feeding transcripts to an LLM; warns that the format drifts | Python; viewer |
| foyzulkarim/claude-lens | 253 | 2026-08 | Local-first dashboard: tokens, cost, cache performance | "Nothing leaves your machine"; observed-vs-estimated accuracy tiers | No actions |
| Anthropic `session-report` plugin | official | 2026 | Node `analyze-sessions.mjs` over JSONL -> HTML (tokens, cache breaks, subagents, skills, expensive prompts) | Parsing rules: dedupe `assistant` entries by `requestId` (else 3-10x overcount), skip `isMeta/isSidechain/isCompactSummary`, subagents in `<session>/subagents/*.jsonl` + `.meta.json`, dedupe by `uuid` on resume | 7-day window; no recommendations |

Also: simonw/claude-code-transcripts 1,726 (paginated HTML, gist publishing, Python), jhlee0409/claude-code-history-viewer 2,293 (offline viewer for 11 CLIs), raine/claude-history 531 (Rust fuzzy search), nilbuild/claude-run 673, ColeMurray/claude-code-otel 520 (OTel/Grafana; mirrors `tool_decision` metrics; prompt logging off by default), delexw/claude-code-trace 383 (viewer whose efficiency score sends redacted data to an external service), Brads3290/cclogviewer 85 (Go, stale), codestz/claude-hindsight 22 (single Rust binary), atomchung/ccstory 43 (narrative recap over ccusage), jonathanavis96/claude-code-friction-audit 0 (dependency-free "where sessions burn tokens", diffs two runs), Yaxuan42/ccmerge 0 (git-sync sessions so `/insights` sees all devices; pre-push secret scan), russellbrenner/claude-insights-extended 0 (planned Bun CLI over `usage-data/facets`; the only project targeting the facets cache, still a README).

## 2. Self-improvement, reflection, memory

| Repo | Stars | Pushed | What it does | Borrow | Gaps |
|---|---|---|---|---|---|
| thedotmack/claude-mem | 107,487 | 2026-10-31 | Hooks capture tool observations -> summaries -> injected next session; MCP search | Hook capture pipeline; `npx claude-mem install --ide <host>` multi-host installer | Hosted "CMEM Pro" memory is the default (local observer opt-in); chromadb/SDK weight; per-session injection cost |
| BayramAnnakov/claude-reflect | 1,908 | 2026-10-03 | Hook queues your corrections; `/reflect` writes bullets into a marked CLAUDE.md section; v2 discovers workflow patterns -> skills; AGENTS.md sync | Correction detection + queue; human review before write; marked managed section; confidence levels; routes fixes into the skill that caused them | Python 3; corrections only; restart needed |
| rebelytics/one-skill-to-rule-them-all | 3,659 | 2026-10-28 | `task-observer` meta-skill logs observations about other skills, proposes improvements | Observation log -> proposal -> user decides; proven on 1,900 observations | Needs a CLAUDE.md line to load; no transcript analysis |
| coleam00/claude-memory-compiler | 1,313 | 2026-04 | SessionEnd/PreCompact hooks spawn Agent SDK background extraction -> daily logs -> compiled articles | Extraction outside the main context; PreCompact safety net; index file instead of RAG | Python/uv + SDK cost per session |
| parcadei/Continuous-Claude-v3 | 3,948 | 2026-01 | 30 hooks, 109 skills, 32 agents, ledgers, setup wizard | Wizard with prerequisite checks | Docker + Python + uv + remote DB; stale |
| severity1/claude-code-auto-memory | 158 | 2026-04 | Silent PostToolUse + Stop hook -> isolated agent updates CLAUDE.md; `/auto-memory:init` wizard | Zero-output PostToolUse hook; isolated agent protects context; auto-managed sections | Python; CLAUDE.md only |
| haddock-development/claude-reflect-system | 384 | 2026-01 | Corrections -> skill files with confidence; timestamped `.backups/` | Backup before every change; three confidence tiers | Python; skills only |
| bokan/claude-skill-self-improvement | 12 | 2026-01 | Reads `.jsonl`, parallel agents find friction, cross-references CLAUDE.md/skills, writes suggestions | Closest to "insights -> CLAUDE.md fixes"; friction ranked by frequency; review file, not auto-apply | No apply step; subagent cost |
| imadAttar/kaizen | 6 | 2026-06 | `/kaizen:coach` analyses how you work, suggests which skills/hooks/rules to add | "One skill, add only what usage justifies"; scoring | Tiny; shallow analytics |

Also: GWUDCAP/cc-sessions 1,540 (interactive "kickstart" onboarding, Python+Node parity, stale), AnandChowdhary/continuous-claude 1,388 (`--knowledge-file CLAUDE.md` across loop iterations), adelaidasofia/claude-performance 3 (weekly cron appends rules to `~/.claude/CLAUDE.md` unreviewed), vatevstoil/claude-self-learning-os 4 (scheduled Python, zero LLM calls, suggestion queue), obra/claude-memory-extractor 120 ($0.50-2.00 per conversation when an LLM re-reads transcripts), OthmanAdi/planning-with-files 27,790 (every-turn hook), CVaranese/agent-habits 0 (~450-token SessionStart injection, per-project `habits.json`).

## 3. Config generators, optimizers, setup wizards

| Repo | Stars | Pushed | What it does | Borrow | Gaps |
|---|---|---|---|---|---|
| davila7/claude-code-templates | 33,017 | 2026-10-31 | npx catalog of agents/commands/settings/hooks/MCPs; analytics dashboard; health check | Catalog with `--yes` flags; web UI; `--health-check` | Catalog-driven, not usage-driven; README ads; Python + Node |
| UfoMiao/zcf | 6,079 | 2026-10-29 | One config -> writes each tool's settings using the tool's own commands | `zcf plan` prints every command and a diff of every file before `apply -y`; `zcf ui` browser editor; `claude mcp add-json` | Multi-tool scope; no analytics |
| trailofbits/claude-code-config | 2,145 | 2026-08 | Opinionated defaults; `/trailofbits:config` walks through components | Idempotent configurator that detects what is installed and self-installs | Security-firm specific |
| OriNachum/claude-code-guide | 122 | 2026-06 | Plugin: `/guide:onboard`, `/guide:visualize-setup`, game-mode hooks | Onboarding packaged as plugin skills; setup dashboard | No data analysis |
| kgraph57/claude-code-doctor | 4 | 2026-07 | Read-only audit: context tax, dead permissions (804 entries, 77 to missing paths), MCP bloat, zombie automations; A-E grades; diff mode | Finding categories; "change nothing before I approve" prompt; before/after diff | Python; no fix |
| Naorn/token-optimizer | 0 | 2026-03 | Audits CLAUDE.md/MEMORY.md/MCP/skills per-message cost; HTML dashboard | ~800-token CLAUDE.md target; move workflows into skills | AGPL; symlink install |

Also: SuperClaude-Org/SuperClaude_Framework 23,919 (pip; `superclaude mcp` interactive install; heavy instruction injection), Yeachan-Heo/oh-my-claudecode 40,456 (HUD statusline, `.omc/` state dir, native `better-sqlite3`), ruvnet/claude-flow 80,403 (`npx ruflo init wizard`; warns "mods run with your account permissions, read the code"), garrytan/gstack 138,450 (all-Markdown skills, team-mode `required` hook), disler/claude-code-hooks-mastery 3,970 (payload reference for every hook event; uv scripts), centminmod/my-claude-code-setup 2,704 (CLAUDE.md migration prompt), luongnv89/claude-howto 46,260 (`/self-assessment` quizzes), Mishit18/claude-code-doctor 1 (npx CLAUDE.md lint, `.claudeignore` generator, "ML engines" marketing), yhyuk/claude-code-doctor 1 (HTML grades citing official 200-line guidance), marchoag/Claude-Code-Setup-Wizard-MD 70 (12-question markdown wizard). Lists: hesreallyhim/awesome-claude-code 56,977; ComposioHQ/awesome-claude-skills 78,425; VoltAgent/awesome-claude-code-subagents 26,232; rohitg00/awesome-claude-code-toolkit 2,797 (its `skills-janitor` dedupes skills, zero deps). BMAD-METHOD 54,819, github/spec-kit 144,230 and buildermethods/agent-os 5,565 are process frameworks, not usage-driven config.

## 4. Permission-prompt reducers and safety

| Tool | Stars | Pushed | What it does | Borrow | Gaps |
|---|---|---|---|---|---|
| Anthropic `/fewer-permission-prompts` (built-in) | - | 2026 | Scans 50 recent sessions, groups Bash/MCP calls by command + first subcommand, keeps read-only ones, drops already auto-allowed (`cat`, `git status`), blocks interpreter/shell wildcards, ranks by frequency (>=3), proposes top 20, writes `permissions.allow` to project `.claude/settings.json` | The algorithm; explains what was skipped and why | Project scope only; no deny rules; no hook guards |
| Anthropic auto mode | - | 2026 | Classifier approves/blocks each call; prompts again after 3 consecutive / 20 total blocks | Pair with `permissions.deny` for secrets | Admin-enabled; not a config fix |
| everyinc/compound-engineering-plugin `claude-permissions-optimizer` | 25,797 | 2026-10-31 | Evidence-based safe-command allowlisting | Refuses destructive commands by design | Skill only |
| dwarvesf/claude-guardrails | 40 | 2026-10 | 21/40 deny rules, PreToolUse hooks, secret scanners, privacy env flags | Merge into settings.json with backup, idempotent; lite/full; "known tradeoffs" | Shell; no analysis |
| yurukusa/cc-safe-setup | 9 | 2026-10 | Interactive selector over 914 example hooks; `--verify` fires each hook; "four ways your guards stop running" manual | Verification mode; hook failure taxonomy | Overwhelming catalog |

Also: sydches/agentnanny 4 (expiring session-scoped auto-approval profiles via hooks), anthropics/sandbox-runtime 6,896 (OS-level FS/network sandbox), textcortex/claude-code-sandbox 323 and numtide/claudebox 59 (Docker "responsible YOLO"), yuuichieguchi/claude-remote-approver 73 (approve from phone via ntfy), acedergren/agentic-tools 25, dylancaponi/claude-code-permissions 22 (no README). No repo named `cc-safe-yolo` exists; the nearest is `cc-safe-setup`.

## 5. Interactive UIs that talk back to Claude Code

- `AskUserQuestion` is the only in-session multiple-choice primitive. The official `plugin-dev` plugin documents the wizard pattern: list the tool in `allowed-tools`, run a first-run wizard, persist answers to `.claude/<plugin>.local.md` so later runs skip it. Known defects: issues #12672/#29530 (empty answers inside skills), #12605 (hooks cannot answer it). A numbered-menu text fallback is mandatory.
- JoJoJotarou/AskUserQuestionPlus 37: MCP server serving a web form styled like AskUserQuestion.
- Config TUIs that write settings: ccstatusline, CCometixLine, jsubroto/claude-code-statusline 13 (pick fields -> writes `~/.claude/statusline.py` plus the `statusLine` key), `zcf ui`, claude-code-templates web catalog.
- Reports as UI: `/insights` writes `report.html` plus a text twin; kgraph57 builds HTML dashboards and share cards; `receipts` exports CSV. Nobody uses claude.ai artifacts or a local HTTP form to feed choices back into Claude Code.

## 6. Anthropic official surface

`/insights` (observed locally, 193 sessions): lightweight scan -> cache (`usage-data/session-meta/<id>.json`: tool_counts, tool_errors, tool_error_categories, user_interruptions, user_response_times, bash_would_prompt_count, destructive_command_count, uses_mcp, lines_added/removed) -> facets via Opus (`facets/<id>.json`: underlying_goal, goal_categories, outcome, user_satisfaction_counts, claude_helpfulness, session_type, friction_counts, friction_detail, primary_success, brief_summary) -> aggregation -> parallel insight generation. Max 200 sessions. Output `usage-data/report.html`, dated copies, `report-latest.txt`. Sections: What You Work On; How You Use Claude Code; Impressive Things You Did; Where Things Go Wrong; Existing CC Features to Try; Suggested CLAUDE.md Additions; New Ways to Use Claude Code; On the Horizon. It suggests, never writes.

Other built-ins: `/fewer-permission-prompts`, `/statusline` (generates the script and `statusLine` entry), `/skill-doctor`, `claude plugin details <name>` (component inventory and projected token cost), `claude plugin eval`. Hook events now number ~35 (Setup, SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, Stop, SubagentStart/Stop, PreCompact/PostCompact, SessionEnd, ConfigChange, InstructionsLoaded, PreModelSwitch, ...). Settings precedence: managed > `--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`; Bash rules split compound commands on `&&`, `||`, `;`, `|`, newlines.

`anthropics/claude-plugins-official` (45,536 stars) overlapping plugins: `claude-code-setup` (read-only codebase scan recommending 1-2 automations per category: MCP, skills, hooks, subagents, commands), `hookify` (conversation pattern or instruction -> `.claude/hookify.*.local.md` regex rule, live without restart), `claude-md-management` (`claude-md-improver` audit + `/revise-claude-md` session learnings), `session-report`, `receipts`, `security-guidance`, `skill-creator`, `plugin-dev`. `anthropics/skills` (185,794) ships `skill-creator`; `anthropics/claude-code` keeps only a README in `plugins/`.

## 7. Feature gap matrix

Y = yes, P = partial, N = no. "Anthropic" = `/insights` + `/fewer-permission-prompts` + official plugins; "doctor" = kgraph57/claude-code-doctor.

| Capability | Anthropic | claude-reflect | claude-mem | cc-templates | ccusage | sniffly | doctor | cc-safe-setup | Ours |
|---|---|---|---|---|---|---|---|---|---|
| Parses `~/.claude/projects` JSONL | Y | N | N | Y | Y | Y | P | N | Y |
| Reuses `/insights` facets + session-meta | Y | N | N | N | N | N | N | N | Y |
| Token/cost accounting | P | N | N | Y | Y | Y | P | N | P |
| Friction/error pattern analysis | Y | P | N | N | N | Y | N | N | Y |
| Corrections -> CLAUDE.md rules | P | Y | P | N | N | N | N | N | Y |
| Recommends hooks from evidence | P | N | N | P | N | N | P | Y | Y |
| Writes hooks into settings.json | P | P | Y | Y | N | N | N | Y | Y |
| Permission allowlist generation | Y | N | N | P | N | N | P | N | Y |
| Deny rules / safety guards | P | N | N | P | N | N | N | Y | Y |
| MCP context-cost audit + cleanup | P | N | N | N | N | N | Y | N | Y |
| Generates skills/subagents | P | P | N | Y | N | N | N | N | Y |
| Statusline setup | Y | N | N | P | P | N | N | N | Y |
| Interactive choice dialog | P | P | N | Y | N | N | N | Y | Y |
| Dry-run diff + backup + rollback | N | P | N | N | N | N | P | P | Y |
| Node/markdown only, no Python | Y | N | N | P | Y | N | N | Y | Y |
| Fully local by default | P | Y | N | Y | Y | Y | Y | Y | Y |
| Verifies hooks actually fire | N | N | N | N | N | N | N | Y | Y |
| Measures before/after | N | N | N | N | N | N | Y | N | Y |

Reading: the analysis side is crowded (Anthropic, sniffly, ccusage, doctor); the writing side is a set of single-surface writers (reflect -> CLAUDE.md, cc-safe-setup -> hooks, fewer-permission-prompts -> allowlist, ccstatusline -> statusline). Nobody connects evidence to a reviewed, reversible, multi-surface apply step.

## 8. Fifteen most valuable ideas (ranked)

1. Reuse the `/insights` caches first: `session-meta` already has tool errors, interruptions, `bash_would_prompt_count`, `destructive_command_count`; `facets` has friction per session. Parse JSONL only for sessions without facets, with the `session-report` rules (dedupe by `requestId`/`uuid`, skip meta/sidechain, read `subagents/`).
2. Generalize `/fewer-permission-prompts`: frequency-ranked read-only allowlist plus deny suggestions for secret paths and destructive commands (claude-guardrails), official compound-command and wildcard semantics, user-chosen scope (user/project/local).
3. Plan -> diff -> apply -> undo for every write (zcf `plan`, guardrails merge-with-backup, reflect-system `.backups/`); one `undo` restores the last transaction; CLAUDE.md edits live in a marked managed section (claude-reflect).
4. Selection via `AskUserQuestion` with answers persisted in `.claude/<kit>.local.md` (plugin-dev) and a numbered-list fallback for the known empty-answer bugs.
5. Correction-capture hook -> queue -> review (claude-reflect) in Node, merged with bokan's cross-session "friction ranked by frequency" so rules come from live corrections and history.
6. Evidence-based hook recommender: hookify-style rule creation, cc-safe-setup catalog for guards, kaizen's "only what usage justifies", claude-code-setup's cap of 1-2 per category.
7. Context-tax audit: CLAUDE.md against ~800 tokens / 200 lines (token-optimizer, yhyuk), MCP cost via `claude plugin details` and invocation counts from transcripts (unclog, mcp-token-tracker: one tool ~663 tokens, Playwright's 22 tools ~14.3K), every-turn hooks, unused skills. Offer "disable" before "delete".
8. Hook verification: fire each installed hook with a synthetic payload (`cc-safe-setup --verify`), detect the "guards never run" modes, flag conflicting PreToolUse Bash rewriters (claude-token-saver's conflict table; this user's RTK hook is a live case).
9. Statusline: delegate to `/statusline` or write a tiny Node script into `statusLine` (jsubroto pattern) with usage pace (ccusage, CCometixLine) and `subagentStatusLine`.
10. Provenance labels on every number (Usage-Monitor `official/local_estimate`, claude-lens observed/estimated) so the dialog never overstates savings.
11. Progressive disclosure: one entry skill, scripts and references loaded on demand (kaizen, token-optimizer); SessionStart injection none or under ~450 tokens (agent-habits).
12. Heavy analysis in a background/isolated agent returning summaries (claude-code-auto-memory, memory-compiler); deterministic Node stats first, model calls only on aggregates.
13. Skill/subagent synthesis from recurring workflows (claude-reflect v2, task-observer log) following `skill-creator` conventions, deduped against installed skills.
14. Self-contained HTML + text report (insights `report.html` + `report-latest.txt`, session-report template, share cards, receipts CSV) with a before/after diff of two runs (doctor diff mode, friction-audit).
15. Idempotent re-runs that detect what is installed (trailofbits `/config`), respect managed settings, and ship Windows-safe hooks (PowerShell examples are in the official hooks docs; statusline issue #23994 shows Windows is where things break).

## 9. Ten mistakes to avoid

1. Python/uv or native dependencies (sniffly, Usage-Monitor, claude-reflect, oh-my-claudecode's `better-sqlite3`, Continuous-Claude's Docker). Node >= 18 + markdown/JSON only.
2. Data leaving the machine by default (claude-mem's hosted default, claude-code-trace's external scoring, claude-session-viewer's xAI key). Local-only, explicit per-feature opt-in.
3. Unreviewed automatic edits to global config (claude-performance appending to `~/.claude/CLAUDE.md` from cron, unclog deleting MCP servers from `~/.claude.json`). Diff, approve, back up.
4. Context tax from the kit itself: every-turn hooks injecting text, 30-hook frameworks, 100+ agent catalogs. Measure and show the kit's own per-message cost.
5. Secrets exposure: `history.jsonl` has `pastedContents`, session-meta has `first_prompt`, transcripts hold tool output. Never copy excerpts into CLAUDE.md, reports or bundles without redaction (ccmerge secret scan, guardrails scanner, superpowers' scrubbed bundle).
6. Dangerous allowlist rules: `Bash(python3 *)`, interpreters, `Bash(git * main)` (matches `git -c core.fsmonitor=<script>`), rules that ignore compound-command splitting. Reuse the official semantics and the fewer-permission-prompts blocklist.
7. Non-idempotent installers that clobber `settings.json` or duplicate hooks on re-run; merge, detect existing entries, keep a transaction log.
8. Assuming hooks and dialogs work: silent non-execution (cc-safe-setup manual), statusline never invoked on Windows, AskUserQuestion empty answers. Verify after install, keep fallbacks.
9. Burning tokens on analysis: Opus facets over 200 sessions, $0.50-2.00 per conversation when an LLM re-reads transcripts. Reuse caches, compute deterministically, summarise before any model call.
10. Fragile parsing and inflated claims: JSONL format drifts (claude-code-log and session-report both warn); star counts and "ML engines" are noise. Parse defensively with fixtures; keep every reported claim measurable.

## Sources

GitHub API via `gh` (2026-10-31) for all stars; code.claude.com docs (hooks, permissions, settings, skills, plugins, statusline); anthropics/claude-plugins-official READMEs; blog.vincentqiao.com/en/posts/claude-code-insights; wmedia.es/en/tips/claude-code-fewer-permission-prompts; skills.sh claude-permissions-optimizer; chatwithgpt.substack.com "The Self-Improving Loop"; developersdigest.tech "Self-Improving Skills"; claude.com/blog/auto-mode; claudeissues.com #12672, #29530, #12605; anthropics/claude-code issue #23994; local `~/.claude/usage-data` schema (keys only).
