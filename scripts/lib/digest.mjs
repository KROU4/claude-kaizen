// Renders measure.json into measure.md: a compact digest that an LLM (or a
// human) can read in one pass. Headings are localized; numbers are not prose.
import { translator } from './i18n.mjs';

function table(rows, header) {
  const lines = [];
  if (header) {
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
  }
  for (const r of rows) lines.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return lines.join('\n');
}

function kv(obj, limit = 12) {
  return Object.entries(obj || {})
    .slice(0, limit)
    .map(([k, v]) => `${k} ${typeof v === 'number' ? v : JSON.stringify(v)}`)
    .join(', ');
}

function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

function hourBar(hours) {
  const max = Math.max(1, ...hours);
  const blocks = ' ▁▂▃▄▅▆▇█';
  return hours.map((v) => blocks[Math.min(8, Math.round((v / max) * 8))]).join('');
}

/** Metrics compared between two measurements: [path, label key, lowerIsBetter, format]. */
export const DELTA_METRICS = [
  ['totals.sessions', 'digest.sessions', null, 'int'],
  ['totals.userMessages', 'digest.prompts', null, 'int'],
  ['friction.interruptionsPerSession', 'f.interruptions', true, 'num'],
  ['friction.permissionPrompts', 'f.permission_prompts', true, 'int'],
  ['friction.compactionShare', 'm.compaction_share', true, 'pct'],
  ['friction.correctionsPerSession', 'f.corrections', true, 'num'],
  ['friction.editMismatches', 'f.edit_mismatches', true, 'int'],
  ['friction.timeouts', 'f.timeouts', true, 'int'],
  ['friction.hookNonBlockingErrors', 'f.hook_errors', true, 'int'],
  ['tools.errorRate', 'm.tool_error_rate', true, 'pct'],
  ['autonomy.askPerSession', 'a.ask_user', true, 'num'],
  ['quality.editsWithoutTestsShare', 'q.edits_without_tests', true, 'pct'],
  ['context.claudeMdTokens', 'c.claude_md', true, 'int'],
  ['mcp.unusedCount', 'x.mcp_unused', true, 'int'],
  ['skills.unusedCount', 'x.skills_unused', true, 'int'],
  ['totals.costUSD', 'm.cost', true, 'usd'],
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function fmtDelta(v, kind) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (kind === 'pct') return pct(v);
  if (kind === 'usd') return `$${v.toFixed(2)}`;
  if (kind === 'num') return String(Math.round(v * 100) / 100);
  return String(Math.round(v));
}

/** Compare two measurements; returns rows {label, before, now, change, better} for metrics that exist in both. */
export function compareMeasures(prev, cur, t) {
  const rows = [];
  for (const [p, labelKey, lowerIsBetter, kind] of DELTA_METRICS) {
    const a = getPath(prev, p);
    const b = getPath(cur, p);
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const diff = b - a;
    const relative = a !== 0 ? diff / Math.abs(a) : b !== 0 ? 1 : 0;
    let better = null;
    if (lowerIsBetter !== null && Math.abs(relative) >= 0.05) better = lowerIsBetter ? diff < 0 : diff > 0;
    rows.push({ path: p, label: t(labelKey), before: fmtDelta(a, kind), now: fmtDelta(b, kind), change: `${diff > 0 ? '+' : ''}${fmtDelta(diff, kind)}`, better, relative });
  }
  return rows;
}

export function renderDigest(m, lang = m.locale?.lang || 'en', previous = null) {
  const t = translator(lang);
  const L = [];
  const T = m.totals;
  L.push(`# ${t('digest.title')}`);
  L.push('');
  L.push(
    t('digest.intro', {
      days: m.windowDays,
      sessions: T.sessions,
      projects: T.projects,
      prompts: T.userMessages,
      days_active: T.activeDays,
      generated: m.generatedAt.slice(0, 16).replace('T', ' '),
    }),
  );
  L.push('');
  L.push(`${t('digest.locale')}: **${m.locale.lang}** (${t('digest.cyrillic')} ${pct(m.locale.cyrillicShare)}). ${t('digest.env')}: ${m.env.platform.platform}, node ${m.env.platform.node}, Claude Code ${m.env.claudeVersion || '?'}.`);
  L.push('');

  // ---- snapshot
  L.push(`## ${t('digest.snapshot')}`);
  L.push('');
  const cost = T.costSessions ? `$${T.costUSD} (${T.costSessions}/${T.sessions} ${t('digest.sessions_with_cost')})` : t('digest.na');
  L.push(
    table(
      [
        [t('m.sessions_per_active_day'), m.sessions.perActiveDay, t('m.median_prompts'), m.sessions.medianUserMessages],
        [t('m.long_sessions'), m.sessions.longSessions, t('m.one_shot_sessions'), m.sessions.oneShotSessions],
        [t('m.tool_uses'), T.toolUses, t('m.tool_error_rate'), pct(m.tools.errorRate)],
        [t('m.cost'), cost, t('m.cache_hit_rate'), pct(T.cacheHitRate)],
        [t('m.lines_added'), T.linesAdded, t('m.lines_removed'), T.linesRemoved],
        [t('m.bypass_share'), pct(m.sessions.bypassShare), t('m.plan_share'), pct(m.sessions.planShare)],
        [t('m.delegation_share'), pct(m.delegation.share), t('m.subagent_spawns'), m.delegation.spawns],
        [t('m.compaction_share'), pct(m.friction.compactionShare), t('m.peak_context'), `${Math.round(m.context.peakTokensMax / 1000)}k`],
      ],
      [t('digest.metric'), t('digest.value'), t('digest.metric'), t('digest.value')],
    ),
  );
  L.push('');

  // ---- friction
  const F = m.friction;
  L.push(`## ${t('digest.friction')}`);
  L.push('');
  L.push(
    table(
      [
        [t('f.interruptions'), F.interruptions, t('f.per_session'), F.interruptionsPerSession],
        [t('f.permission_prompts'), F.permissionPrompts, t('f.auto_accepts'), F.permissionAutoAccepts],
        [t('f.rejections'), F.userRejections, t('f.corrections'), `${F.corrections} (${F.correctionsPerSession}/${t('digest.session')})`],
        [t('f.compactions'), F.compactions, t('f.sessions_with_compaction'), F.sessionsWithCompaction],
        [t('f.timeouts'), F.timeouts, t('f.slow_commands'), F.slowCommands],
        [t('f.edit_mismatches'), F.editMismatches, t('f.user_modified_edits'), F.userModifiedEdits],
        [t('f.not_found'), F.notFound, t('f.missing_dependency'), F.missingDependency],
        [t('f.test_failures'), F.testFailures, t('f.tool_errors'), F.toolErrors],
        [t('f.hook_runs'), F.hookRuns, t('f.hook_errors'), `${F.hookErrors} / ${F.hookNonBlockingErrors} ${t('f.non_blocking')}`],
      ],
      [t('digest.metric'), t('digest.value'), t('digest.metric'), t('digest.value')],
    ),
  );
  if (Object.keys(m.tools.errorClasses).length) {
    L.push('');
    L.push(`${t('f.error_classes')}: ${kv(m.tools.errorClasses, 12)}`);
  }
  if (F.slowHooks.length) {
    L.push('');
    L.push(`${t('f.slow_hooks')}:`);
    for (const h of F.slowHooks) L.push(`- \`${h.hook}\`: ${h.runs} ${t('digest.runs')}, ${t('digest.avg')} ${h.avgMs} ${t('digest.unit_ms')}, ${t('digest.max')} ${h.maxMs} ${t('digest.unit_ms')}`);
  }
  if ((F.hookTimeouts || []).length) {
    L.push('');
    L.push(`${t('f.hook_timeouts')}:`);
    for (const h of F.hookTimeouts) L.push(`- \`${h.hook}\`: ${t('f.timed_out', { n: h.timeouts, limit: h.limitMs ? `${h.limitMs / 1000} ${t('digest.unit_s')}` : '?' })}`);
  }
  if (F.hookErrorSamples.length) {
    L.push('');
    L.push(`${t('f.hook_error_samples')}:`);
    for (const e of F.hookErrorSamples.slice(0, 5)) L.push(`- ${Object.entries(e).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
  }
  if (F.correctionSamples.length) {
    L.push('');
    L.push(`${t('f.correction_samples')}:`);
    for (const c of F.correctionSamples.slice(0, 12)) L.push(`- ${c}`);
  }
  L.push('');

  // ---- tools
  L.push(`## ${t('digest.tools')}`);
  L.push('');
  L.push(`${t('tl.top_tools')}: ${kv(m.tools.byName, 15)}`);
  L.push('');
  L.push(`${t('tl.top_errors')}: ${kv(m.tools.errorsByName, 10)}`);
  L.push('');
  L.push(`${t('tl.bash_verbs')}: ${kv(m.tools.bashVerbs, 20)}`);
  if (m.tools.powershellVerbs && Object.keys(m.tools.powershellVerbs).length) L.push(`${t('tl.bash_verbs')} (PowerShell): ${kv(m.tools.powershellVerbs, 20)}`);
  if (m.tools.slowBashCommands.length) {
    L.push('');
    L.push(`${t('tl.slow_commands')} (≥30 ${t('digest.unit_s')}):`);
    for (const c of m.tools.slowBashCommands.slice(0, 10)) L.push(`- \`${c.verb}\`: ${c.count}×, ${t('digest.avg')} ${c.avgSec} ${t('digest.unit_s')}, ${t('digest.max')} ${c.maxSec} ${t('digest.unit_s')}`);
  }
  if (m.tools.repeatedBashCommands.length) {
    L.push('');
    L.push(`${t('tl.repeated_commands')}:`);
    for (const c of m.tools.repeatedBashCommands.slice(0, 12)) L.push(`- ${c.count}× \`${c.command}\``);
  }
  if (m.tools.suggestedAllowRules.length) {
    L.push('');
    L.push(`${t('tl.suggested_allow')}: ${m.tools.suggestedAllowRules.slice(0, 15).map((r) => `\`${r.rule}\` (${r.count})`).join(', ')}`);
  }
  L.push('');

  // ---- autonomy & delegation
  L.push(`## ${t('digest.autonomy')}`);
  L.push('');
  L.push(`${t('a.permission_modes')}: ${kv(m.sessions.byPermissionMode)}. ${t('a.default_mode')}: ${m.autonomy.defaultPermissionMode}.`);
  L.push(`${t('a.ask_user')}: ${m.autonomy.askUserQuestions} (${m.autonomy.askPerSession}/${t('digest.session')}); ${t('a.plan_mode')}: ${m.autonomy.planModeUses}; ${t('a.todo')}: ${m.autonomy.sessionsWithTodo}/${T.sessions} ${t('digest.sessions')}.`);
  L.push(`${t('a.subagents')}: ${kv(m.delegation.byType, 12) || t('digest.none')}; ${t('a.subagent_models')}: ${kv(m.delegation.models) || t('digest.none')}.`);
  L.push(`${t('a.web')}: ${m.delegation.webSearches} WebSearch, ${m.delegation.webFetches} WebFetch. ${t('a.entrypoints')}: ${kv(m.sessions.byEntrypoint)}.`);
  L.push('');

  // ---- skills / mcp / plugins
  L.push(`## ${t('digest.extensions')}`);
  L.push('');
  L.push(`${t('x.skills_used')}: ${kv(m.skills.used, 15) || t('digest.none')}`);
  L.push(`${t('x.slash_used')}: ${kv(m.skills.slashCommands, 15) || t('digest.none')}`);
  L.push(`${t('x.skills_installed')}: ${m.skills.installed} (${kv(m.skills.installedBySource)}); ${t('x.skills_unused')}: ${m.skills.unusedCount} (${pct(m.skills.unusedShare)}); ${t('x.legacy_commands')}: ${m.skills.legacyCommands}.`);
  if (m.skills.unused.length) L.push(`${t('x.unused_list')}: ${m.skills.unused.slice(0, 25).join(', ')}${m.skills.unused.length > 25 ? ', …' : ''}`);
  L.push('');
  L.push(`${t('x.mcp_used')}: ${Object.entries(m.mcp.used).map(([k, v]) => `${k} ${v.calls} (${v.distinctTools} ${t('x.tools')})`).join(', ') || t('digest.none')}`);
  L.push(`${t('x.mcp_configured')}: user ${m.mcp.configured.user.join(', ') || '—'}; project ${m.mcp.configured.project.join(', ') || '—'}; local ${m.mcp.configured.local.join(', ') || '—'}.`);
  if (m.mcp.unused.length) L.push(`${t('x.mcp_unused')}: **${m.mcp.unused.join(', ')}**`);
  L.push(`${t('x.plugins')}: ${m.inventory.plugins.map((p) => `${p.name}@${p.marketplace}`).join(', ') || t('digest.none')}`);
  L.push('');

  // ---- context & config
  L.push(`## ${t('digest.context')}`);
  L.push('');
  L.push(`${t('c.claude_md')}: ${m.context.claudeMdTokens} ${t('c.tokens')} (${m.context.claudeMdFiles.map((f) => `${f.scope} ${f.tokens}`).join(', ') || t('digest.none')}); ${t('c.skill_descriptions')}: ~${m.context.skillDescriptionTokens} ${t('c.tokens')}.`);
  L.push(`${t('c.hooks')}: ${m.context.hooksCount} (${kv(m.context.hookEvents) || '—'}); ${t('c.status_line')}: ${m.context.statusLine ? t('digest.yes') : t('digest.no')}; ${t('c.agents')}: ${m.context.agentsInstalled}; ${t('c.plugins')}: ${m.context.installedPlugins}.`);
  L.push(`${t('c.peak_context')}: ${t('digest.max')} ${Math.round(m.context.peakTokensMax / 1000)}k, ${t('digest.median')} ${Math.round(m.context.peakTokensMedian / 1000)}k; ${t('c.sessions_over')} 150k: ${m.context.sessionsOver150k}, 400k: ${m.context.sessionsOver400k}. ${t('c.thinking')}: ${m.context.thinkingMinutes} ${t('digest.unit_min')}.`);
  L.push(`${t('c.models')}: ${Object.entries(m.totals.tokens).length ? Object.entries(mModels(m)).map(([k, v]) => `${k} ${pct(v.share)}`).join(', ') : '—'}.`);
  if (m.inventory.hooks.length) {
    L.push('');
    L.push(`${t('c.hook_list')}:`);
    for (const h of m.inventory.hooks.slice(0, 30)) L.push(`- ${h.scope} ${h.event}${h.matcher ? ` [${h.matcher}]` : ''} ${h.type === 'command' ? `\`${h.command}\`` : h.type}${h.timeout ? ` t=${h.timeout}` : ''}${h.async ? ' async' : ''}`);
  }
  L.push('');

  // ---- quality
  const Q = m.quality;
  L.push(`## ${t('digest.quality')}`);
  L.push('');
  L.push(`${t('q.commits')}: ${Q.commits}; ${t('q.pushes')}: ${Q.pushes}; ${t('q.force_pushes')}: ${Q.forcePushes}; ${t('q.destructive')}: ${Q.destructiveCommands}.`);
  L.push(`${t('q.tests')}: ${Q.testCommands} (${Q.testFailures} ${t('q.failed')}); ${t('q.tests_per_commit')}: ${Q.testsPerCommit ?? '—'}; ${t('q.edits_without_tests')}: ${Q.sessionsWithEditsNoTests}/${Q.sessionsWithEdits} (${pct(Q.editsWithoutTestsShare)}).`);
  L.push(`${t('q.languages')}: ${kv(m.languages.byLanguage, 8) || '—'}; ${t('q.formatter')}: ${m.languages.formatter}.`);
  L.push('');

  // ---- habits
  const H = m.habits;
  L.push(`## ${t('digest.habits')}`);
  L.push('');
  L.push(`${t('h.hours')} (0–23): \`${hourBar(H.hours)}\` ${t('h.peak')}: ${H.peakHours.join(', ')}${t('digest.unit_h')}; ${t('h.night')}: ${pct(H.nightShare)}; ${t('h.weekend')}: ${pct(H.weekendShare)}.`);
  L.push(`${t('h.prompt_len')}: ${t('digest.median')} ${H.promptMedianChars}, p90 ${H.promptP90Chars} ${t('h.chars')}; ${t('h.short_prompts')}: ${pct(H.shortPromptsShare)}; ${t('h.response_gap')}: ${H.responseGapMedianSec} ${t('digest.unit_s')}.`);
  if (H.repeatedStems.length) {
    L.push('');
    L.push(`${t('h.repeated_prompts')}:`);
    for (const s of H.repeatedStems.slice(0, 15)) L.push(`- ${s.count}× “${s.stem}” — ${s.sample}`);
  }
  L.push('');
  L.push(`${t('h.top_projects')}:`);
  for (const p of m.sessions.topProjects.slice(0, 8)) L.push(`- ${p.name}: ${p.sessions} ${t('digest.sessions')}, ${p.userMessages} ${t('digest.prompts')}${p.costUSD ? `, $${p.costUSD}` : ''}`);
  L.push('');

  // ---- insights
  if (m.insights.available) {
    L.push(`## ${t('digest.insights')}`);
    L.push('');
    L.push(`${t('i.facets')}: ${m.insights.facets} (${t('i.last_report')}: ${m.insights.lastReport || '?'}).`);
    L.push(`${t('i.friction')}: ${kv(m.insights.friction) || t('digest.none')}.`);
    L.push(`${t('i.outcome')}: ${kv(m.insights.outcome)}; ${t('i.satisfaction')}: ${kv(m.insights.satisfaction)}; ${t('i.helpfulness')}: ${kv(m.insights.helpfulness)}.`);
    L.push(`${t('i.session_types')}: ${kv(m.insights.sessionType)}.`);
    if (m.insights.frictionSamples.length) {
      L.push('');
      L.push(`${t('i.samples')}:`);
      for (const s of m.insights.frictionSamples.slice(0, 6)) L.push(`- [${s.kinds.join(', ')}] ${s.detail}`);
    }
    L.push('');
  }

  // ---- what moved since the previous measurement
  if (previous && previous.generatedAt) {
    const rows = compareMeasures(previous, m, t);
    if (rows.length) {
      L.push(`## ${t('digest.delta')}`);
      L.push('');
      L.push(t('digest.delta_intro', { prev: String(previous.generatedAt).slice(0, 10), prev_days: previous.windowDays, now_days: m.windowDays }));
      L.push('');
      L.push(
        table(
          rows.map((r) => [r.label, r.before, r.now, `${r.change}${r.better === true ? ' ✓' : r.better === false ? ' ✗' : ''}`]),
          [t('digest.metric'), t('digest.before'), t('digest.now'), t('digest.change')],
        ),
      );
      L.push('');
    }
  }

  L.push(`---`);
  L.push(t('digest.footer', { file: 'measure.json' }));
  return L.join('\n') + '\n';
}

function mModels(m) {
  // models live in totals? They were aggregated into the models map at build time; expose share by message count.
  return m.models || {};
}
