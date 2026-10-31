---
name: start
description: Run the full Kaizen cycle for this user — measure how they use Claude Code from local transcripts, show recommendations in an interactive console (artifact, browser or terminal), apply the ones they pick, verify, and explain how to undo. Use when the user asks to optimize, tune, review or improve their Claude Code setup, workflow, hooks, skills or permissions, or says "/insights but fix it".
argument-hint: "[--days N] [--ui artifact|browser|terminal] [--project]"
allowed-tools: Bash(node *) Read Write Agent AskUserQuestion Artifact ArtifactData
---

# Kaizen: measure → choose → apply → verify

You are running the Kaizen improvement cycle. Everything below runs locally; nothing is uploaded. Deterministic work happens in `scripts/kaizen.mjs`; you do the judgement and the conversation.

## 0. Resolve paths and language

- Kit root: `${CLAUDE_PLUGIN_ROOT}` when Kaizen is installed as a plugin. In agent-kit mode (the user pointed you at a clone of github.com/KROU4/claude-kaizen) use that clone's path. Define the command once: `KZ='node "<kit root>/scripts/kaizen.mjs"'`. State dir: `~/.claude/kaizen/` (or `$CLAUDE_CONFIG_DIR/kaizen`).
- Arguments: `--days N` (default 30), `--ui artifact|browser|terminal` (default: auto), `--project` (also apply project-scoped recipes to the current directory).
- Speak the user's language. After step 1, `locale.lang` in the digest tells you what they write in (`ru` → answer in Russian, including all explanations and the summary). If the user writes to you in another language, follow the user.
- Never paste raw transcript content into the chat. The digest is already secret-scrubbed; keep it that way.

## 1. Measure

Run `$KZ measure --days <N> --quiet` (first run scans every transcript; 1 GB takes ~10 s; later runs use a cache). If it fails because Node is missing, say so and stop: Kaizen needs Node 18+.

Read `~/.claude/kaizen/measure.md` with the Read tool (never `cat` the JSON into the chat). Tell the user in 5–8 lines what stands out: sessions and projects, the two or three biggest friction signals with their numbers, what is already configured well. Numbers only from the digest, no guessing.

## 2. Recommend

Run `$KZ recommend --json` and read the result (it is also saved to `~/.claude/kaizen/recommendations.json`). Each item has `id`, `impact`, `risk`, `title`, `evidence`, `actionsSummary`, `params`, `kind` (`recipe` applies changes; `advice` is for discussion).

When the digest shows ≥ 20 sessions, also run the qualitative pass: spawn the `kaizen-analyst` subagent (Agent tool, `subagent_type: "kaizen:kaizen-analyst"` when installed as a plugin, otherwise `kaizen-analyst`) with this brief: the path of `measure.md`, the user's language, and the instruction to write `~/.claude/kaizen/extra-recipes.json`. When it returns, run `$KZ recommend --add ~/.claude/kaizen/extra-recipes.json --json` so its drafted rules and skills appear with pre-filled parameters. If the analyst fails, continue without it.

If there are zero recommendations, say so, summarize what the data shows and stop.

## 3. Let the user choose

Pick the UI (unless `--ui` says otherwise):

**A. Artifact console** — when the `Artifact` tool exists in this session (Claude desktop app Code tab, claude.ai).
1. `$KZ console --mode render --transport artifact --out ~/.claude/kaizen/console.html`
2. Publish that file with the Artifact tool: `capabilities: {"db": {}}`, title "Kaizen console", icon "sliders". Give the user the link and one sentence: tick what you want, adjust parameters, press Apply.
3. Poll for the answer: `ArtifactData` action `get`, collection `kaizen`, doc_id `choices`, on that artifact's URL. Wait ~20 s between polls (`Bash: sleep 20`), up to 20 minutes. When the document exists, write its `data` object (the choices: `version`, `selected`, `discuss`, `notes`) to `~/.claude/kaizen/choices.json` with the Write tool, then delete the document (`ArtifactData` action `delete` with the returned `version` as `if_version`) so a later run starts clean.
4. If polling times out, ask in chat whether to continue in the terminal (option B/C).

**B. Browser console** — when there is no Artifact tool but a desktop browser is likely (not SSH, `DISPLAY`/Windows/macOS present).
Run `$KZ console` in the background (`run_in_background: true`). Its first stdout line is JSON with `url`; relay the URL to the user. The command exits when they press Apply (it writes `~/.claude/kaizen/choices.json`) or after 30 minutes. Wait for the task to finish before continuing.

**C. Terminal** — otherwise, or when the user prefers chat.
Use `AskUserQuestion` with `multiSelect: true`: at most 4 options per question, high-impact items first, 2–3 questions maximum; put the evidence in each option's description. Then write `~/.claude/kaizen/choices.json` yourself:
```json
{ "version": 1, "selected": [{ "id": "<recipe id>", "scope": "user", "params": {} }], "discuss": ["<advice id>"], "notes": "" }
```
If `AskUserQuestion` is unavailable or returns empty answers, list the recommendations as a numbered list and ask the user to reply with numbers.

Whatever the UI, honour `notes`: if the user typed constraints (e.g. "no hooks slower than 5 s", "tests are `make check`"), adjust parameters or drop recipes accordingly before applying, and say what you changed.

## 4. Apply

1. `$KZ apply --dry-run` — show the planned writes in ≤ 12 lines (files, settings keys, hooks). The console was the user's approval; do not ask again unless a recipe has `risk: high` or `notes` changed the plan.
2. `$KZ apply` (add `--project <dir>` when project-scoped recipes were chosen). Report what was written and skipped, in the user's language.
3. For every id in `discuss` (advice), give the concrete next step in 2–4 lines each, using the numbers and samples from the digest (for example, name the failing hook and offer to fix or remove it now). Offer to do it in this session.
4. For `claude-md.corrections` and `skills.from-repeated-prompts`, if the parameters came back empty, spawn `kaizen-smith` to draft the content from the digest samples, show the draft, let the user edit it in chat, then apply with `$KZ apply --recipe <id> --param <id>.<param>=<value>` (or write the file yourself and journal it with the same command).

## 5. Verify

Spawn `kaizen-verifier` (or do it inline when only one or two recipes were applied): run `--selftest` on every hook script in `~/.claude/kaizen/hooks/`, parse every touched `settings.json`, confirm CLAUDE.md blocks have both markers, and run `claude plugin validate <skills dir>` when a skill was created. Report failures with the exact fix; apply the fix if it is in Kaizen's own files.

## 6. Close

In the user's language, in ≤ 10 lines: what changed (grouped by category), what to expect on the next session, `/kaizen:undo` reverts the last batch, Kaizen will remind them to re-measure in a week (SessionStart nudge; `~/.claude/kaizen/config.json` → `{"nudge": false}` turns it off), and that `/kaizen:measure` after a week shows whether friction actually dropped.

## Rules

- Read the digest; do not reimplement the analysis by reading transcripts yourself.
- Never edit `settings.json`, `CLAUDE.md` or `~/.claude.json` by hand — always through `$KZ apply`, so `undo` works.
- Never commit, push or touch the user's repositories; Kaizen configures Claude Code, not projects.
- If `measure` finds zero transcripts, explain how transcripts work (they live in `~/.claude/projects`, kept for `cleanupPeriodDays`) and stop.
