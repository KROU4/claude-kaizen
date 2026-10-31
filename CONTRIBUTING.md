# Contributing

Thanks for helping make Claude Code setups better for everyone. Kaizen is small on purpose: Node 18+, no dependencies, Markdown and JSON. Keep it that way.

## Ground rules

- **Zero dependencies.** No `npm install` for users, ever. Dev tooling that stays out of `dependencies` is fine.
- **Local only.** Nothing may send data anywhere unless the user explicitly configures it (the Telegram notification channel and the claude.ai artifact console are the only examples today; both are opt-in and documented in `SECURITY.md`).
- **Reversible.** Every write goes through `scripts/lib/apply.mjs` and gets a journal entry that `undo` can replay. A new action type needs a handler *and* an undo branch *and* a test.
- **Evidence first.** A recipe is recommended only when a metric says so. If you cannot name the metric, it is advice, not a recipe.
- **Bilingual.** `title`, `why`, `evidence` and parameter labels need `en` and `ru`. UI strings live in `locales/*.json`; `selfcheck` fails on missing keys.
- **No fake completion.** Do not leave TODOs, skipped tests or placeholder text in a PR.

## Workflow

```bash
node scripts/kaizen.mjs selfcheck    # catalog, locales, templates, manifests
npm test                   # unit and CLI tests on synthetic fixtures
claude plugin validate . --strict    # if you have Claude Code installed
node scripts/kaizen.mjs docs         # regenerate docs/recipes.md after catalog changes
```

Try your change against your own data: `node scripts/kaizen.mjs measure && node scripts/kaizen.mjs recommend`. Nothing is written until `apply`.

## Adding a recipe

1. Add an entry to `recipes/catalog.json` (see the `about` field for placeholders and the existing entries for shape). Pick `impact` honestly; set `risk: medium|high` for anything that changes behaviour the user might not expect.
2. If it installs a script, add it under `recipes/templates/hooks/` (self-contained, `--selftest`, `{{param}}` placeholders, never throws). If it adds rules, add a Markdown file under `recipes/templates/claude-md/`.
3. Make sure the metric it tests exists in `scripts/lib/metrics.mjs` and is documented in `METRIC_DOCS`.
4. Run the checks above and regenerate the docs.
5. In the PR, say which project or post inspired it (`source` field) and paste the rendered evidence line from your own measurement.

## Adding a metric

Add it in `metrics.mjs` (and the scanner in `transcripts.mjs` if it needs new raw signals), document it in `METRIC_DOCS`, render it in `digest.mjs` where useful, and cover it in `tests/metrics.test.mjs` with a fixture line that triggers it.

## Reporting bugs

Use the bug template and attach `node scripts/kaizen.mjs doctor` output. It contains versions, paths and counts only; review it before posting anyway.
