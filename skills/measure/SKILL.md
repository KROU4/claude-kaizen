---
name: measure
description: Measure how the user works with Claude Code (sessions, tools, friction, context, costs, skills, MCP, habits) from local transcripts and show the digest, without changing anything. Use when the user asks for a report, statistics or insights about their Claude Code usage, or wants to compare before/after a change.
argument-hint: "[--days N] [--all]"
allowed-tools: Bash(node "*kaizen.mjs" *) Read
---

# Kaizen measure (read-only)

1. Kit root = `${CLAUDE_PLUGIN_ROOT}` or the clone path. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" measure --days <N or 30> --quiet` as one literal line, with no shell variable or alias (`--all` for everything still on disk).
2. `measure --quiet` prints nothing. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" paths` as one literal line, take `measureMd` from its JSON (it follows `KAIZEN_STATE_DIR` and `CLAUDE_CONFIG_DIR`; `~/.claude/kaizen` is only the default) and read that file with the Read tool. `<state>` below is `stateDir` from the same output. The digest's intro line says when it was generated: it must be from this run.
3. Answer in the language given by `locale.lang` in the digest (unless the user wrote in another language). Structure:
   - **Snapshot** (3 lines): sessions, projects, prompts, cost if reported, dominant model.
   - **Friction, ranked** (up to 6 bullets): the number, what it means in practice, one sentence on what would remove it.
   - **Context budget**: CLAUDE.md tokens, unused skills/plugins/MCP servers, peak prompt size.
   - **Habits**: hours, prompt length, repeated prompt openings (skill candidates).
   - **What is already good** (2–3 bullets) — people fix more when told what works.
4. If `<state>/applied/` contains earlier batches (`node "${CLAUDE_PLUGIN_ROOT}/scripts/kaizen.mjs" status`), compare against the previous digest when one exists (`<state>/measure.previous.md` is written by `measure` when a prior digest existed) and say which numbers moved.
5. End with: run `/kaizen:start` to turn this into applied changes.

Do not paste raw transcript text. Do not change any configuration in this skill.
