---
name: Recipe proposal
about: Propose a new recipe (hook, skill, agent, rule or setting) that Kaizen should be able to recommend and apply
title: "recipe: <short name>"
labels: recipe
---

## What friction does it remove?

<!-- Describe the repeated pain in a Claude Code session, e.g. "I always have to tell Claude to run the tests before it says done". -->

## Evidence Kaizen could detect

<!-- Which signal in the local data would trigger this recipe? Examples: a repeated user prompt stem, a tool error category, a permission prompt pattern, a hook timeout, a configured-but-unused MCP server. -->

## What the recipe applies

- Category: hook / skill / agent / claude-md / permissions / settings / mcp / statusline
- Scope: user (~/.claude) / project (.claude)
- Files or settings it writes:

## Reversibility

<!-- Kaizen must be able to undo every recipe. Explain how (file removal, settings key removal, marker block removal). -->

## Prior art

<!-- Links to repos, docs or posts where this idea exists already. -->
