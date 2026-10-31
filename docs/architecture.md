# Architecture

Kaizen splits the work between deterministic code and the model on purpose: everything that can be computed is computed once by Node; the model reads a short digest and makes judgement calls.

```
~/.claude/projects/**/*.jsonl ─┐
~/.claude/usage-data (facets) ─┼─► scripts/lib/transcripts.mjs ─► per-session summaries (cached)
settings / skills / agents /   │   scripts/lib/insights.mjs
plugins / MCP config ──────────┘   scripts/lib/inventory.mjs
                                        │
                                        ▼
                               scripts/lib/metrics.mjs ─► measure.json  ─► digest.mjs ─► measure.md
                                        │
                                        ▼
                         recipes/catalog.json + scripts/lib/recipes.mjs ─► recommendations.json
                                        │
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
            artifact console     local web console    AskUserQuestion
            (claude.ai db)       (127.0.0.1, POST)    (terminal)
                     └──────────────────┼──────────────────┘
                                        ▼
                                   choices.json
                                        │
                                        ▼
                        scripts/lib/apply.mjs ─► settings.json, hooks, CLAUDE.md, skills, agents, ~/.claude.json
                                        │            └─► ~/.claude/kaizen/applied/<batch>/manifest.json + backups
                                        ▼
                                  undo (same manifest, reversed)
```

## Modules

| File | Responsibility |
|---|---|
| `scripts/kaizen.mjs` | CLI entry; subcommands `measure`, `recommend` (`--add FILE` merges extra recipes and remembers the path), `console`, `choices` (`--import FILE\|-` validates a choices file and writes `choices.json`), `apply` (`--param`, `--param-file recipe.name=path`, `--add FILE`), `undo`, `status`, `verify`, `doctor`, `selfcheck`, `docs`, `nudge`. |
| `scripts/lib/transcripts.mjs` | Streams one JSONL file at a time; dedupes assistant lines by `requestId` and repeated lines by `uuid`; classifies tool errors; extracts prompt stems, corrections, hook health, permission decisions, durations. Per-file cache keyed by size + mtime + schema version. |
| `scripts/lib/insights.mjs` | Aggregates `/insights` facets and session-meta when present. |
| `scripts/lib/inventory.mjs` | Settings (user/project/local), hooks, permissions, skills, agents, plugins, MCP servers, CLAUDE.md files with topic hints. Masks `env` values. |
| `scripts/lib/metrics.mjs` | Combines everything into `measure.json`; `METRIC_DOCS` documents every metric recipes may test. |
| `scripts/lib/digest.mjs` | Renders `measure.md` (localized headings, counts, scrubbed samples). |
| `scripts/lib/recipes.mjs` | Loads the catalog, evaluates JSON conditions, renders bilingual text, scores and ranks, validates the catalog. |
| `scripts/lib/console.mjs` | Builds the console data, renders `console/index.html`, serves it locally or writes it for publishing. |
| `scripts/lib/apply.mjs` | Action handlers (`settings.hook`, `settings.hook.remove`, `settings.set`, `settings.append`, `file`, `skill`, `agent`, `claude-md.block`, `mcp.disable`, `plugins.disable`), journal, backups, undo. |
| `scripts/lib/i18n.mjs`, `redact.mjs`, `paths.mjs`, `platform.mjs`, `jsonl.mjs` | Utilities. |

## Data contract

`measure.json` is the only contract between the scanner and everything else. Its top-level sections: `env`, `locale`, `totals`, `sessions`, `tools`, `friction`, `autonomy`, `delegation`, `skills`, `mcp`, `context`, `quality`, `habits`, `languages`, `insights`, `inventory`, `models`. Recipe conditions and evidence templates address it with dotted paths (`friction.timeouts`, `habits.repeatedStems.0.stem`, `mcp.unused.length`).

`choices.json`: `{version, submittedAt, lang, selected: [{id, scope, params}], discuss: [id], notes}`. Whatever the UI (local server, artifact database, chat questions), it reaches `choices.json` through the same validation (`choices --import` or the local server), so ids, scopes and parameters are checked before `apply` reads them.

Extra recipes: the analyst may draft `custom.*` recipes into `extra-recipes.json`. `recommend --add FILE` merges and validates them and stores the path in the state dir; `apply` reloads that file (or `--add FILE`), so a custom recipe the user ticked is applied like a catalog one. Multi-line parameter values (drafted rules, a whole SKILL.md) are passed with `apply --param-file recipe.name=path`.

`applied/<batch>/manifest.json`: `{id, at, projectDir, recipes: [{id, scope, params, actions: [journal entries]}], undone}`. Journal entries carry what `undo` needs: previous values, added items, file hashes, removed server definitions.

## Performance

A 1.4 GB history (174 transcripts) measures in ~10 s cold and ~1 s warm on a laptop. Memory stays flat: one line in memory at a time, bounded maps per session, caches on disk.

## Where the model is involved

- `kaizen-analyst` turns correction samples and repeated prompts into rules and skill drafts (optional, ≥ 20 sessions).
- `kaizen-smith` drafts the text parameters (rules, a skill body) of recipes the user picked, from the digest samples only.
- `kaizen-verifier` checks the applied batch beyond what `verify` covers (`verify` is deterministic: it self-tests hooks and the status line and parses the settings files it writes; `~/.claude.json`, skills and agents are the verifier's job).
- The `start` skill orchestrates and talks to the user in their language.

None of them reads transcripts: the digest (`measure.md` plus the scrubbed samples in `measure.json`) is the boundary. No model call is required to measure, apply or verify; all three work from a plain shell. The only data that leaves the machine is the optional artifact console: its page and the user's choices live in a private claude.ai artifact until Claude reads them.
