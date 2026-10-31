// Reads the artifacts Claude Code's built-in /insights command leaves behind
// (~/.claude/usage-data/facets/*.json and session-meta/*.json) when present.
// Facets are LLM-written per-session assessments: friction types, outcome,
// satisfaction. Kaizen aggregates them but never depends on them.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from './paths.mjs';
import { redact, snippet } from './redact.mjs';

function inc(map, key, by = 1) {
  if (key === undefined || key === null || key === '') return;
  map[key] = (map[key] || 0) + by;
}

function addCounts(target, counts) {
  if (!counts || typeof counts !== 'object') return;
  for (const [k, v] of Object.entries(counts)) inc(target, k, typeof v === 'number' ? v : 1);
}

export function readInsights(usageDataDir, { sinceMs = 0 } = {}) {
  const facetsDir = path.join(usageDataDir, 'facets');
  const metaDir = path.join(usageDataDir, 'session-meta');
  const result = {
    available: fs.existsSync(facetsDir) || fs.existsSync(metaDir),
    facets: 0,
    sessionMeta: 0,
    lastReport: null,
    outcome: {},
    satisfaction: {},
    helpfulness: {},
    sessionType: {},
    friction: {},
    primarySuccess: {},
    goalCategories: {},
    frictionSamples: [],
    meta: {
      sessions: 0,
      durationMin: 0,
      userMessages: 0,
      assistantMessages: 0,
      interruptions: 0,
      toolErrors: 0,
      toolErrorCategories: {},
      bashWouldPrompt: 0,
      destructiveCommands: 0,
      gitCommits: 0,
      gitPushes: 0,
      usesTaskAgent: 0,
      usesMcp: 0,
      usesWebSearch: 0,
      languages: {},
      responseTimes: [],
    },
  };
  if (!result.available) return result;

  // report-*.html timestamps tell when /insights last ran
  try {
    const reports = fs
      .readdirSync(usageDataDir)
      .filter((f) => /^report-\d{4}-\d{2}-\d{2}.*\.html$/.test(f))
      .sort();
    if (reports.length) result.lastReport = reports[reports.length - 1].match(/\d{4}-\d{2}-\d{2}/)[0];
  } catch {
    /* ignore */
  }

  const metaBySession = new Map(); // sessions inside the window
  const allMetaIds = new Set(); // every session that has a meta file, in or out of the window
  if (fs.existsSync(metaDir)) {
    for (const f of fs.readdirSync(metaDir)) {
      if (!f.endsWith('.json')) continue;
      const m = readJsonSafe(path.join(metaDir, f));
      if (!m) continue;
      const id = m.session_id || f.replace(/\.json$/, '');
      allMetaIds.add(id);
      const start = m.start_time ? Date.parse(m.start_time) : NaN;
      if (!Number.isNaN(start) && start < sinceMs) continue;
      metaBySession.set(id, m);
      result.sessionMeta++;
      const M = result.meta;
      M.sessions++;
      M.durationMin += m.duration_minutes || 0;
      M.userMessages += m.user_message_count || 0;
      M.assistantMessages += m.assistant_message_count || 0;
      M.interruptions += m.user_interruptions || 0;
      M.toolErrors += m.tool_errors || 0;
      addCounts(M.toolErrorCategories, m.tool_error_categories);
      M.bashWouldPrompt += m.bash_would_prompt_count || 0;
      M.destructiveCommands += m.destructive_command_count || 0;
      M.gitCommits += m.git_commits || 0;
      M.gitPushes += m.git_pushes || 0;
      if (m.uses_task_agent) M.usesTaskAgent++;
      if (m.uses_mcp) M.usesMcp++;
      if (m.uses_web_search) M.usesWebSearch++;
      addCounts(M.languages, m.languages);
      if (Array.isArray(m.user_response_times) && M.responseTimes.length < 2000) {
        for (const t of m.user_response_times) if (typeof t === 'number') M.responseTimes.push(t);
      }
    }
  }

  if (fs.existsSync(facetsDir)) {
    for (const f of fs.readdirSync(facetsDir)) {
      if (!f.endsWith('.json')) continue;
      const fx = readJsonSafe(path.join(facetsDir, f));
      if (!fx) continue;
      const sid = fx.session_id || f.replace(/\.json$/, '');
      const meta = metaBySession.get(sid);
      // a facet whose session-meta exists but fell outside the window is old; one with no meta at all is kept
      if (sinceMs && !meta && allMetaIds.has(sid)) continue;
      result.facets++;
      inc(result.outcome, fx.outcome);
      inc(result.helpfulness, fx.claude_helpfulness);
      inc(result.sessionType, fx.session_type);
      inc(result.primarySuccess, fx.primary_success);
      addCounts(result.satisfaction, fx.user_satisfaction_counts);
      addCounts(result.friction, fx.friction_counts);
      addCounts(result.goalCategories, fx.goal_categories);
      if (fx.friction_detail && result.frictionSamples.length < 25) {
        const kinds = Object.keys(fx.friction_counts || {});
        result.frictionSamples.push({ kinds, detail: snippet(redact(fx.friction_detail), 240) });
      }
    }
  }
  result.goalCategories = Object.fromEntries(
    Object.entries(result.goalCategories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40),
  );
  return result;
}
