# Kaizen — instructions for AI agents

You are reading this because a user asked you to review and improve their Claude Code setup using this kit, without installing it as a plugin. Follow these steps exactly; do not improvise an analysis of your own.

## 1. Get the kit

```bash
git clone --depth 1 https://github.com/KROU4/claude-kaizen "$TMPDIR/claude-kaizen"   # any temp folder works
node --version                                                                    # must be 18 or newer
```

Set `KIT` to the clone path. Everything below is `node "$KIT/scripts/kaizen.mjs" <command>`.

## 2. Run the cycle

Open `skills/start/SKILL.md` in the clone and follow it step by step. It is written for exactly this situation: resolve paths, measure, recommend, let the user choose, apply, verify, close. Where it says `${CLAUDE_PLUGIN_ROOT}`, use `$KIT`. Where it refers to subagents `kaizen-analyst`, `kaizen-smith`, `kaizen-verifier`, their definitions are in `agents/*.md`; if your runtime cannot load them as subagents, read the file and perform the role yourself in a focused way.

The short version:

1. `measure --quiet` → read `~/.claude/kaizen/measure.md` (never dump `measure.json`).
2. `recommend --json`.
3. Show choices: artifact console if you have an Artifact tool, else `console` (browser), else multiple-choice questions.
4. `apply --dry-run`, then `apply`.
5. Verify hooks with `node ~/.claude/kaizen/hooks/<name>.mjs --selftest`.
6. Explain `undo --last`.

## 3. Rules

- Speak the user's language (`locale.lang` in the digest). Russian prompts → Russian answers.
- Never edit `settings.json`, `CLAUDE.md` or `~/.claude.json` by hand. Only `apply` writes, so `undo` works.
- Never read the user's transcripts under `~/.claude/projects` directly; the digest is the boundary. Never paste prompt text or tool output into the chat.
- Never touch the user's repositories, commit or push. Kaizen configures Claude Code, nothing else.
- If anything in the kit fails, show the exact error and the command; do not work around it by editing configuration manually.

## 4. For contributors (agents working on this repository)

- Run `node scripts/kaizen.mjs selfcheck` and `node --test tests/` before committing. CI also runs `claude plugin validate . --strict`.
- Recipes live in `recipes/catalog.json`; every text field needs `en` and `ru`; every action must be undoable by `scripts/lib/apply.mjs` (add a handler and an undo branch together). Regenerate `docs/recipes.md` with `node scripts/kaizen.mjs docs`.
- Hook templates in `recipes/templates/hooks/` are self-contained Node scripts with a `--selftest` mode and `{{param}}` placeholders. Keep them under ~220 lines and never let them throw.
- Fixtures under `tests/fixtures/` are synthetic. Do not add real transcripts, paths, names or tokens.
- The exact Claude Code formats we write to are summarised in `docs/reference/claude-code-formats.md`; check the official docs when in doubt and update that file.
