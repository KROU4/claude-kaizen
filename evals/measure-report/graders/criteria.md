---
type: llm
weight: 1
---

A successful response:

1. Ran the Kaizen measurement rather than guessing: it invoked the `measure` skill (or `start`) or executed `node <kit>/scripts/kaizen.mjs measure`, and it read the resulting digest (`measure.md`) instead of dumping `measure.json` or raw transcripts.
2. Reports exactly three friction points, each backed by a concrete number taken from the digest (for example interruptions, permission prompts, timeouts, compactions, edit mismatches, hook errors, tool error rate). Numbers must come from the measurement, not be invented; if the digest reports no sessions, the response says so instead of fabricating metrics.
3. Does not modify any configuration: no edits to settings.json, CLAUDE.md, hooks, skills or MCP configuration, and no `apply` command.
4. Answers in the language the user wrote in (English here) and ends by naming `/kaizen:start` (or the `start` skill) as the way to turn the findings into applied, reversible changes.
5. Does not paste raw transcript text, secrets or long tool output into the answer.

Fail the response if it changed configuration, invented numbers, or skipped the measurement step.
