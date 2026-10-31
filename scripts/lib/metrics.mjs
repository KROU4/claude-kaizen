// Turns per-session summaries + inventory + /insights facets into the
// measurement object (measure.json). Every metric that a recipe may test is
// documented in docs/metrics.md (generated from METRIC_DOCS below).
import { detectLang } from './i18n.mjs';
import { topN } from './transcripts.mjs';
import { redact } from './redact.mjs';

export const MEASURE_VERSION = 1;
/** Fewer sessions than this cannot show that a skill or MCP server is unused, so those metrics stay empty. */
export const MIN_SESSIONS_FOR_UNUSED = 3;

const EXT_LANG = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'powershell',
  '.md': 'markdown',
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.html': 'web',
  '.css': 'web',
  '.scss': 'web',
  '.tf': 'terraform',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.ipynb': 'notebook',
};

const FORMATTERS = {
  python: 'ruff',
  typescript: 'prettier',
  javascript: 'prettier',
  vue: 'prettier',
  svelte: 'prettier',
  web: 'prettier',
  markdown: 'prettier',
  go: 'gofmt',
  rust: 'rustfmt',
  csharp: 'dotnet format',
  ruby: 'rubocop',
  php: 'php-cs-fixer',
  swift: 'swiftformat',
  kotlin: 'ktlint',
  java: 'google-java-format',
  terraform: 'terraform fmt',
  shell: 'shfmt',
};

function sum(arr, f = (x) => x) {
  let t = 0;
  for (const x of arr) t += f(x) || 0;
  return t;
}

function merge(target, src, by = 1) {
  if (!src) return target;
  for (const [k, v] of Object.entries(src)) target[k] = (target[k] || 0) + (typeof v === 'number' ? v : by);
  return target;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Plugin names that provided MCP servers actually called (mcp__plugin_<plugin>_<server>__tool). */
function mcpUsedByPlugin(sessions) {
  const out = {};
  for (const s of sessions) {
    for (const [srv, v] of Object.entries(s.mcp || {})) {
      const m = srv.match(/^plugin_(.+?)_[^_]+$/);
      if (m) out[m[1]] = (out[m[1]] || 0) + v.calls;
    }
  }
  return out;
}

function shortProjectName(cwd) {
  if (!cwd) return '(unknown)';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * Strict allowlist for the "read-only" permission recipe. `Bash(<verb>:*)` is a prefix match, so a verb is listed only
 * when EVERY invocation starting with it is read-only: no runners (npm run, npx, make, uv run, python/node, test
 * runners that execute project code), nothing that writes, deletes, redirects or mutates remote state (find -delete/-exec,
 * git branch -D, git stash drop, git remote set-url, gh pr/api/run, docker compose, cat/echo > file, rg --pre, fd -x).
 * Every entry must be a verb that commandVerb() in transcripts.mjs can actually produce (tests enforce it).
 */
export const SAFE_VERBS = new Set([
  'git status', 'git diff', 'git log', 'git show', 'git blame', 'git rev-parse',
  'ls', 'pwd', 'head', 'tail', 'wc', 'grep', 'which', 'where', 'stat', 'file', 'du', 'df',
  'npm ls', 'npm view', 'npm outdated', 'docker ps', 'docker logs', 'kubectl get',
]);

export function suggestAllowRules(bashVerbs, { minCount = 3 } = {}) {
  const out = [];
  for (const [verb, n] of Object.entries(bashVerbs)) {
    if (n < minCount || !SAFE_VERBS.has(verb)) continue;
    out.push({ rule: `Bash(${verb}:*)`, count: n });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 40);
}

/**
 * Build the measurement.
 * @param {object} args
 * @param {Array} args.sessions   per-session summaries from transcripts.mjs
 * @param {object} args.inventory from inventory.mjs
 * @param {object} args.insights  from insights.mjs
 * @param {object} args.env       {windowDays, since, configDir, platform, claudeVersion, kitVersion, projectDir}
 * @param {object} args.scan      {scanned, cached, bytes, errors}
 */
export function buildMeasure({ sessions, inventory, insights, env, scan }) {
  const S = sessions;
  const n = S.length || 1;
  const days = Math.max(1, env.windowDays || 30);

  // ---- totals
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const models = {};
  for (const s of S) {
    for (const [m, u] of Object.entries(s.models || {})) {
      const mm = (models[m] ||= { messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
      mm.messages += u.messages;
      mm.input += u.input;
      mm.output += u.output;
      mm.cacheRead += u.cacheRead;
      mm.cacheCreate += u.cacheCreate;
      tokens.input += u.input;
      tokens.output += u.output;
      tokens.cacheRead += u.cacheRead;
      tokens.cacheCreate += u.cacheCreate;
    }
  }
  const totalMsgs = sum(Object.values(models), (m) => m.messages) || 1;
  for (const m of Object.values(models)) m.share = round(m.messages / totalMsgs, 3);
  const promptTokensAll = tokens.input + tokens.cacheRead + tokens.cacheCreate;
  const costSessions = S.filter((s) => typeof s.costUSD === 'number');

  const totals = {
    sessions: S.length,
    projects: new Set(S.map((s) => s.projectDir)).size,
    userMessages: sum(S, (s) => s.userMessages),
    assistantMessages: sum(S, (s) => s.assistantMessages),
    toolUses: sum(S, (s) => sum(Object.values(s.toolUses || {}))),
    durationMin: sum(S, (s) => s.durationMin),
    activeDays: new Set(S.map((s) => (s.startedAt || '').slice(0, 10)).filter(Boolean)).size,
    costUSD: round(sum(costSessions, (s) => s.costUSD), 2),
    costSessions: costSessions.length,
    tokens,
    cacheHitRate: promptTokensAll ? round(tokens.cacheRead / promptTokensAll, 3) : 0,
    linesAdded: sum(S, (s) => s.linesAdded),
    linesRemoved: sum(S, (s) => s.linesRemoved),
    filesEdited: sum(S, (s) => s.filesEdited),
  };

  // ---- sessions
  const userMsgCounts = S.map((s) => s.userMessages);
  const byEntrypoint = {};
  const byPermissionMode = {};
  const byProject = {};
  for (const s of S) {
    merge(byEntrypoint, s.entrypoints);
    merge(byPermissionMode, s.permissionModes);
    const p = (byProject[s.projectDir] ||= { name: shortProjectName(s.cwd), sessions: 0, userMessages: 0, costUSD: 0 });
    p.sessions++;
    p.userMessages += s.userMessages;
    p.costUSD = round(p.costUSD + (s.costUSD || 0), 2);
  }
  const permTotal = sum(Object.values(byPermissionMode)) || 1;
  const sessionsInfo = {
    perDay: round(S.length / days, 2),
    perActiveDay: totals.activeDays ? round(S.length / totals.activeDays, 2) : 0,
    medianUserMessages: round(quantile(userMsgCounts, 0.5), 1),
    p90UserMessages: round(quantile(userMsgCounts, 0.9), 1),
    longSessions: S.filter((s) => s.userMessages >= 40).length,
    oneShotSessions: S.filter((s) => s.userMessages <= 1).length,
    medianDurationMin: round(quantile(S.map((s) => s.durationMin), 0.5), 0),
    byEntrypoint,
    byPermissionMode,
    bypassShare: round(((byPermissionMode.bypassPermissions || 0) + (byPermissionMode.dontAsk || 0)) / permTotal, 3),
    planShare: round((byPermissionMode.plan || 0) / permTotal, 3),
    topProjects: Object.values(byProject)
      .sort((a, b) => b.userMessages - a.userMessages)
      .slice(0, 10),
  };

  // ---- tools
  const toolsByName = {};
  const errorsByName = {};
  const errorClasses = {};
  const durations = {};
  const bashVerbs = {};
  const bashCommands = {};
  const slowByVerb = {};
  for (const s of S) {
    merge(toolsByName, s.toolUses);
    merge(errorsByName, s.toolErrors);
    merge(errorClasses, s.errorClasses);
    merge(bashVerbs, s.bashVerbs);
    merge(bashCommands, s.bashCommands);
    for (const [t, d] of Object.entries(s.toolDurations || {})) {
      const x = (durations[t] ||= { n: 0, ms: 0, max: 0 });
      x.n += d.n;
      x.ms += d.ms;
      if (d.max > x.max) x.max = d.max;
    }
    for (const c of s.slowCommands || []) {
      const x = (slowByVerb[c.verb || '?'] ||= { count: 0, maxMs: 0, totalMs: 0 });
      x.count++;
      x.totalMs += c.ms;
      if (c.ms > x.maxMs) x.maxMs = c.ms;
    }
  }
  for (const d of Object.values(durations)) {
    d.avgMs = d.n ? Math.round(d.ms / d.n) : 0;
    d.maxMs = d.max;
    delete d.max;
    delete d.ms;
  }
  const toolErrorsTotal = sum(Object.values(errorsByName));
  const tools = {
    byName: topN(toolsByName, 40),
    errorsByName: topN(errorsByName, 20),
    errorClasses: topN(errorClasses, 20),
    errorRate: totals.toolUses ? round(toolErrorsTotal / totals.toolUses, 4) : 0,
    durations: Object.fromEntries(
      Object.entries(durations)
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 20),
    ),
    bashVerbs: topN(bashVerbs, 30),
    repeatedBashCommands: Object.entries(bashCommands)
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([command, count]) => ({ command, count })),
    slowBashCommands: Object.entries(slowByVerb)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15)
      .map(([verb, v]) => ({ verb, count: v.count, maxSec: Math.round(v.maxMs / 1000), avgSec: Math.round(v.totalMs / v.count / 1000) })),
    slowCommandsTotal: sum(Object.values(slowByVerb), (v) => v.count),
    suggestedAllowRules: suggestAllowRules(bashVerbs),
  };

  // ---- friction
  const permissionDecisions = {};
  const hookDurations = {};
  const hookTimeoutMap = {};
  const hookErrorSamples = [];
  let hookRuns = 0;
  let hookErrors = 0;
  let hookNonBlocking = 0;
  for (const s of S) {
    merge(permissionDecisions, s.permissionDecisions);
    hookRuns += s.hooks.hookRuns || 0;
    hookErrors += s.hooks.errors || 0;
    hookNonBlocking += s.hooks.nonBlockingErrors || 0;
    for (const [k, d] of Object.entries(s.hooks.durations || {})) {
      const x = (hookDurations[k] ||= { n: 0, ms: 0, max: 0 });
      x.n += d.n;
      x.ms += d.ms;
      if (d.max > x.max) x.max = d.max;
    }
    for (const [k, d] of Object.entries(s.hooks.timeouts || {})) {
      const x = (hookTimeoutMap[k] ||= { n: 0, limitMs: 0 });
      x.n += d.n;
      if (d.limitMs > x.limitMs) x.limitMs = d.limitMs;
    }
    for (const e of s.hooks.errorSamples || []) if (hookErrorSamples.length < 12) hookErrorSamples.push(e);
  }
  const hookTimeouts = Object.entries(hookTimeoutMap)
    .map(([hook, d]) => ({ hook, timeouts: d.n, limitMs: d.limitMs }))
    .sort((a, b) => b.timeouts - a.timeouts || a.hook.localeCompare(b.hook))
    .slice(0, 10);
  // failing hooks: errors per configured hook command (only hooks still present in settings are actionable)
  const errorsByCommand = {};
  for (const s of S) merge(errorsByCommand, s.hooks.errorsByCommand);
  const configuredCommands = new Set(inventory.hooks.commands.map((c) => c.command));
  const normalizeCmd = (c) => String(c).replace(/\s+/g, ' ').trim();
  const configuredNorm = new Map([...configuredCommands].map((c) => [normalizeCmd(c), c]));
  const failingHooks = Object.entries(errorsByCommand)
    .map(([key, errors]) => {
      const idx = key.indexOf('|');
      const event = key.slice(0, idx);
      const command = key.slice(idx + 1);
      const configured = configuredNorm.get(normalizeCmd(command)) || null;
      // `command` is the display copy (redacted); `configuredCommand` stays exactly as written in settings.json for matching
      return { event, command: redact(command), errors, configured: !!configured, configuredCommand: configured };
    })
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);
  const slowHooks = Object.entries(hookDurations)
    .map(([hook, d]) => ({ hook, runs: d.n, avgMs: d.n ? Math.round(d.ms / d.n) : 0, maxMs: d.max }))
    .filter((h) => h.avgMs >= 1500 || h.maxMs >= 10000)
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);
  // Interactive prompts: decisions that were not auto-resolved by mode/rule/hook/classifier.
  let promptedAccept = 0;
  let promptedReject = 0;
  let autoAccept = 0;
  for (const [k, v] of Object.entries(permissionDecisions)) {
    const [decision, , source] = k.split('/');
    // source "user_temporary" / "user_permanent" / "user_reject" = the human answered a prompt;
    // "config" / "hook" = resolved by mode, rule, classifier or a PreToolUse hook.
    const interactive = /^user/i.test(source || '');
    if (decision === 'accept' && !interactive) autoAccept += v;
    else if (decision === 'accept') promptedAccept += v;
    else if (decision === 'reject' && interactive) promptedReject += v;
  }
  const sessionsWithCompaction = S.filter((s) => s.compactions > 0).length;
  const denialKinds = {};
  for (const s of S) merge(denialKinds, s.denialKinds);
  const corrections = sum(S, (s) => s.corrections);
  const correctionSamples = [];
  for (const s of S) for (const c of s.correctionSamples || []) if (correctionSamples.length < 20) correctionSamples.push(c);
  const friction = {
    interruptions: sum(S, (s) => s.interruptions),
    interruptionsPerSession: round(sum(S, (s) => s.interruptions) / n, 2),
    toolInterrupted: sum(S, (s) => s.toolInterrupted),
    compactions: sum(S, (s) => s.compactions),
    sessionsWithCompaction,
    compactionShare: round(sessionsWithCompaction / n, 3),
    userRejections: Math.max(sum(S, (s) => s.userRejections), promptedReject, denialKinds['user-rejected'] || 0),
    denialKinds,
    permissionRuleDenials: denialKinds['permission-rule'] || 0,
    autoModeBlocks: denialKinds['automode-blocked'] || 0,
    permissionDecisions,
    permissionPrompts: promptedAccept + promptedReject,
    permissionAutoAccepts: autoAccept,
    corrections,
    correctionsPerSession: round(corrections / n, 2),
    correctionSamples,
    editMismatches: errorClasses['edit-mismatch'] || 0,
    userModifiedEdits: sum(S, (s) => s.userModifiedEdits),
    timeouts: (errorClasses.timeout || 0) + sum(S, (s) => s.toolTimeouts),
    toolTimeouts: sum(S, (s) => s.toolTimeouts),
    notFound: errorClasses['not-found'] || 0,
    missingDependency: errorClasses['missing-dependency'] || 0,
    testFailures: sum(S, (s) => s.testFailures),
    toolErrors: toolErrorsTotal,
    hookRuns,
    hookErrors,
    hookNonBlockingErrors: hookNonBlocking,
    hookErrorSamples,
    failingHooks,
    failingHookCommands: failingHooks.filter((h) => h.configured && h.errors >= 20).map((h) => h.configuredCommand),
    slowHooks,
    hookTimeouts,
    slowCommands: tools.slowCommandsTotal,
    backgroundTasks: sum(S, (s) => s.backgroundTasks),
  };

  // ---- autonomy & delegation
  const subagentsByType = {};
  const subagentModels = {};
  let sessionsWithSubagents = 0;
  for (const s of S) {
    if (Object.keys(s.subagents || {}).length) sessionsWithSubagents++;
    merge(subagentsByType, s.subagents);
    merge(subagentModels, s.subagentModels);
  }
  const autonomy = {
    askUserQuestions: sum(S, (s) => s.askUserQuestions),
    askPerSession: round(sum(S, (s) => s.askUserQuestions) / n, 2),
    planModeUses: sum(S, (s) => s.planMode),
    todoUses: sum(S, (s) => s.todoWrites),
    sessionsWithTodo: S.filter((s) => s.todoWrites > 0).length,
    bypassShare: sessionsInfo.bypassShare,
    defaultPermissionMode: inventory.permissions.defaultMode,
  };
  const delegation = {
    sessionsWithSubagents,
    share: round(sessionsWithSubagents / n, 3),
    spawns: sum(Object.values(subagentsByType)),
    byType: topN(subagentsByType, 20),
    models: subagentModels,
    sidechainMessages: sum(S, (s) => s.sidechainMessages),
    webSearches: sum(S, (s) => s.webSearches),
    webFetches: sum(S, (s) => s.webFetches),
  };

  // ---- skills, commands, mcp
  const skillsUsed = {};
  const slash = {};
  const mcpUsed = {};
  for (const s of S) {
    merge(skillsUsed, s.skills);
    merge(slash, s.slashCommands);
    for (const [srv, v] of Object.entries(s.mcp || {})) {
      const x = (mcpUsed[srv] ||= { calls: 0, tools: {} });
      x.calls += v.calls;
      merge(x.tools, v.tools);
    }
  }
  const installedSkillNames = inventory.skills.map((s) => s.name);
  const usedSkillNames = new Set(Object.keys(skillsUsed).map((k) => k.split(':').pop()));
  const usedSlashNames = new Set(Object.keys(slash).map((k) => k.split(':').pop()));
  // "Never used" is only a finding when the window holds enough sessions to have seen the usage at all.
  const enoughUsage = S.length >= MIN_SESSIONS_FOR_UNUSED;
  const unusedSkills = enoughUsage ? inventory.skills.filter((s) => !usedSkillNames.has(s.name) && !usedSlashNames.has(s.name)) : [];
  // plugins none of whose skills were used (candidates for disabling)
  const pluginUsage = {};
  for (const s of inventory.skills) {
    if (!s.source.startsWith('plugin:')) continue;
    const plugin = s.source.slice(7);
    const used = usedSkillNames.has(s.name) || usedSlashNames.has(s.name) || [...usedSkillNames, ...usedSlashNames].some((u) => u === `${plugin}:${s.name}`);
    const p = (pluginUsage[plugin] ||= { skills: 0, used: 0 });
    p.skills++;
    if (used) p.used++;
  }
  const unusedPlugins = (enoughUsage ? inventory.plugins.installed : [])
    .filter((p) => pluginUsage[p.name] && pluginUsage[p.name].used === 0 && !Object.keys(mcpUsedByPlugin(S)).includes(p.name))
    .map((p) => `${p.name}@${p.marketplace}`);
  const skills = {
    used: topN(skillsUsed, 40),
    slashCommands: topN(slash, 40),
    installed: inventory.skills.length,
    installedBySource: inventory.skills.reduce((acc, s) => merge(acc, { [s.source.split(':')[0]]: 1 }), {}),
    unused: unusedSkills.map((s) => s.name).slice(0, 100),
    unusedCount: unusedSkills.length,
    unusedShare: inventory.skills.length ? round(unusedSkills.length / inventory.skills.length, 3) : 0,
    unusedPlugins,
    pluginUsage,
    descriptionTokens: inventory.skillDescriptionTokens,
    legacyCommands: inventory.legacyCommands.length,
    installedNames: installedSkillNames.slice(0, 300),
  };
  const configured = new Set([...inventory.mcp.user, ...inventory.mcp.project, ...inventory.mcp.local]);
  const usedServers = new Set(Object.keys(mcpUsed).map((k) => k.replace(/^plugin_/, '')));
  const unusedMcp = (enoughUsage ? [...configured] : []).filter((name) => !usedServers.has(name) && ![...usedServers].some((u) => u.includes(name) || name.includes(u)));
  const mcp = {
    used: Object.fromEntries(
      Object.entries(mcpUsed)
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 30)
        .map(([k, v]) => [k, { calls: v.calls, distinctTools: Object.keys(v.tools).length, topTools: topN(v.tools, 5) }]),
    ),
    configured: inventory.mcp,
    configuredCount: configured.size,
    unused: unusedMcp,
    unusedCount: unusedMcp.length,
    pluginServers: Object.keys(mcpUsed).filter((k) => k.startsWith('plugin_')),
  };

  // ---- context
  const peaks = S.map((s) => s.peakContextTokens).filter((x) => x > 0);
  const context = {
    peakTokensMax: Math.max(0, ...peaks),
    peakTokensMedian: Math.round(quantile(peaks, 0.5)),
    sessionsOver150k: peaks.filter((p) => p >= 150000).length,
    sessionsOver400k: peaks.filter((p) => p >= 400000).length,
    claudeMdTokens: inventory.claudeMdTokens,
    claudeMdFiles: inventory.claudeMd,
    claudeMdHints: inventory.claudeMd.reduce((acc, f) => {
      for (const [k, v] of Object.entries(f.hints || {})) acc[k] = acc[k] || v;
      return acc;
    }, {}),
    claudeMdLines: Math.max(0, ...inventory.claudeMd.map((f) => f.lines || 0)),
    userClaudeMdTokens: sum(inventory.claudeMd.filter((f) => f.scope === 'user'), (f) => f.tokens),
    skillDescriptionTokens: inventory.skillDescriptionTokens,
    hooksCount: inventory.hooks.total,
    hookEvents: inventory.hooks.events,
    hookCommandsText: inventory.hooks.commands.map((c) => `${c.event}:${c.command}`).join('\n').toLowerCase(),
    kaizenHooks: inventory.hooks.commands.filter((c) => /kaizen[\\/]hooks/i.test(c.command)).length,
    hasFormatterHook: inventory.hooks.commands.some((c) => /prettier|ruff|black|gofmt|rustfmt|format-on-edit|eslint --fix|biome/i.test(c.command)),
    hasGuardHook: inventory.hooks.commands.some((c) => /guard|block-force|destructive|protect/i.test(c.command)),
    hasNotifyHook: inventory.hooks.commands.some((c) => /notify|notification|telegram|ntfy|toast/i.test(c.command)) || !!inventory.hooks.events.Notification,
    hasSessionStartHook: !!inventory.hooks.events.SessionStart,
    hasPreCompactHook: !!inventory.hooks.events.PreCompact,
    hasStopHook: !!inventory.hooks.events.Stop,
    hasDenyRules: inventory.permissions.deny > 0,
    denyRulesText: inventory.permissions.denyRules.join('\n').toLowerCase(),
    settingsLanguage: inventory.settings.map((s) => s.language).filter(Boolean).pop() || null,
    cleanupPeriodDays: inventory.settings.map((s) => s.cleanupPeriodDays).filter((x) => x !== null && x !== undefined).pop() ?? null,
    installedPlugins: inventory.plugins.installed.length,
    disabledPlugins: inventory.settings.flatMap((s) => s.disabledPlugins).length,
    agentsInstalled: inventory.agents.length,
    statusLine: inventory.statusLine,
    thinkingMinutes: Math.round(sum(S, (s) => s.thinkingMs) / 60000),
  };

  // ---- git & quality
  const git = {};
  for (const s of S) merge(git, s.git);
  const quality = {
    commits: git.commit || 0,
    pushes: git.push || 0,
    forcePushes: sum(S, (s) => s.forcePushes),
    destructiveCommands: sum(S, (s) => s.destructive),
    testCommands: sum(S, (s) => s.testCommands),
    testFailures: sum(S, (s) => s.testFailures),
    testsPerCommit: git.commit ? round(sum(S, (s) => s.testCommands) / git.commit, 2) : null,
    sessionsWithCommits: S.filter((s) => (s.git && s.git.commit) > 0).length,
    sessionsWithTests: S.filter((s) => s.testCommands > 0).length,
    sessionsWithEditsNoTests: S.filter((s) => s.filesEdited > 0 && s.testCommands === 0).length,
    sessionsWithEdits: S.filter((s) => s.filesEdited > 0).length,
    gitVerbs: git,
  };
  quality.editsWithoutTestsShare = quality.sessionsWithEdits ? round(quality.sessionsWithEditsNoTests / quality.sessionsWithEdits, 3) : 0;

  // ---- habits
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const promptLengths = [];
  const gaps = [];
  const stems = {};
  const stemSamples = {};
  const langSamples = [];
  // Sessions driven through the SDK (scripts, bots, e2e tests) are not the human typing; keep them out of habit metrics.
  const isAutomated = (s) => {
    const e = s.entrypoints || {};
    const total = sum(Object.values(e)) || 1;
    const sdk = sum(Object.entries(e).filter(([k]) => /^sdk/i.test(k)), ([, v]) => v);
    return sdk / total > 0.5;
  };
  for (const s of S) {
    if (isAutomated(s)) continue;
    s.hours.forEach((v, i) => (hours[i] += v));
    s.weekdays.forEach((v, i) => (weekdays[i] += v));
    for (const l of s.promptLengths || []) promptLengths.push(l);
    for (const g of s.responseGaps || []) gaps.push(g);
    for (const [k, v] of Object.entries(s.promptStems || {})) {
      stems[k] = (stems[k] || 0) + v;
      if (!stemSamples[k] && s.promptSamples && s.promptSamples[k]) stemSamples[k] = s.promptSamples[k];
    }
    for (const t of s.langSample || []) if (langSamples.length < 400) langSamples.push(t);
  }
  const hourTotal = sum(hours) || 1;
  const repeatedStems = Object.entries(stems)
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([stem, count]) => ({ stem, count, sample: stemSamples[stem] || '' }));
  const habits = {
    hours,
    weekdays,
    peakHours: hours
      .map((v, h) => ({ h, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((x) => x.h),
    nightShare: round(sum(hours.slice(0, 6)) / hourTotal + hours[23] / hourTotal, 3),
    weekendShare: round((weekdays[0] + weekdays[6]) / (sum(weekdays) || 1), 3),
    promptMedianChars: Math.round(quantile(promptLengths, 0.5)),
    promptP90Chars: Math.round(quantile(promptLengths, 0.9)),
    shortPromptsShare: promptLengths.length ? round(promptLengths.filter((l) => l < 40).length / promptLengths.length, 3) : 0,
    repeatedStems,
    repeatedStemsCount: repeatedStems.length,
    responseGapMedianSec: Math.round(quantile(gaps.filter((g) => g < 3600), 0.5)),
  };

  // ---- languages
  const extensions = {};
  for (const s of S) merge(extensions, s.extensions);
  const langCounts = {};
  for (const [ext, c] of Object.entries(extensions)) merge(langCounts, { [EXT_LANG[ext] || 'other']: c });
  const primary = Object.entries(langCounts)
    .filter(([l]) => !['config', 'markdown', 'other'].includes(l))
    .sort((a, b) => b[1] - a[1])
    .map(([l]) => l);
  const languages = {
    extensions: topN(extensions, 15),
    byLanguage: topN(langCounts, 15),
    primary: primary.slice(0, 4),
    formatter: FORMATTERS[primary[0]] || 'auto',
  };

  const locale = detectLang(langSamples);

  // ---- insights (optional)
  const ins = insights || { available: false };
  const insightsOut = {
    available: !!ins.available,
    facets: ins.facets || 0,
    lastReport: ins.lastReport || null,
    friction: topN(ins.friction || {}, 12),
    frictionTotal: sum(Object.values(ins.friction || {})),
    outcome: ins.outcome || {},
    satisfaction: ins.satisfaction || {},
    helpfulness: ins.helpfulness || {},
    sessionType: ins.sessionType || {},
    goalCategories: ins.goalCategories || {},
    frictionSamples: (ins.frictionSamples || []).slice(0, 10),
    meta: ins.meta || null,
  };
  const satTotal = sum(Object.values(insightsOut.satisfaction));
  insightsOut.dissatisfiedShare = satTotal
    ? round(sum(Object.entries(insightsOut.satisfaction).filter(([k]) => /dissatisfied|frustrated|unsatisfied/i.test(k)), ([, v]) => v) / satTotal, 3)
    : 0;

  const measure = {
    version: MEASURE_VERSION,
    generatedAt: new Date().toISOString(),
    windowDays: env.windowDays,
    since: env.since,
    env: {
      configDir: env.configDir,
      projectDir: env.projectDir || null,
      platform: env.platform,
      claudeVersion: env.claudeVersion || null,
      kitVersion: env.kitVersion,
      scanned: scan ? scan.scanned : S.length,
      cached: scan ? scan.cached : 0,
      bytesMB: scan ? Math.round(scan.bytes / 1e6) : null,
      scanErrors: scan ? scan.errors.length : 0,
    },
    locale,
    totals,
    sessions: sessionsInfo,
    tools,
    friction,
    autonomy,
    delegation,
    skills,
    mcp,
    context,
    quality,
    habits,
    languages,
    insights: insightsOut,
    inventory: {
      settingsFiles: inventory.settings.map((s) => ({ scope: s.scope, file: s.file, hooks: s.hooks.total, allow: s.permissions.allow, deny: s.permissions.deny })),
      hooks: inventory.hooks.commands.map((c) => ({ scope: c.scope, event: c.event, matcher: c.matcher, type: c.type, timeout: c.timeout, async: c.async, command: c.command })),
      permissions: { allow: inventory.permissions.allow, deny: inventory.permissions.deny, ask: inventory.permissions.ask, defaultMode: inventory.permissions.defaultMode, allowRules: inventory.permissions.allowRules.slice(0, 100), denyRules: inventory.permissions.denyRules.slice(0, 100) },
      agents: inventory.agents.map((a) => ({ name: a.name, source: a.source, model: a.model })),
      agentNames: inventory.agents.map((a) => a.name),
      plugins: inventory.plugins.installed.map((p) => ({ name: p.name, marketplace: p.marketplace, version: p.version, components: p.components })),
      marketplaces: inventory.plugins.marketplaces,
      settings: inventory.settings.map((s) => ({
        scope: s.scope,
        model: s.model,
        outputStyle: s.outputStyle,
        cleanupPeriodDays: s.cleanupPeriodDays,
        alwaysThinkingEnabled: s.alwaysThinkingEnabled,
        language: s.language,
        attribution: s.attribution,
        statusLine: s.statusLine,
        envKeys: Object.keys(s.env),
        disabledPlugins: s.disabledPlugins,
      })),
      claudeMd: inventory.claudeMd,
    },
  };
  return measure;
}

/** Human-readable documentation for the metrics recipes may test. */
export const METRIC_DOCS = {
  'totals.sessions': 'Sessions in the window',
  'totals.userMessages': 'Human-written prompts (slash commands and tool results excluded)',
  'totals.costUSD': 'Sum of per-session cost as recorded by Claude Code (cost-state lines)',
  'totals.cacheHitRate': 'cache_read / (input + cache_read + cache_create) across assistant messages',
  'sessions.bypassShare': 'Share of user turns in bypassPermissions or dontAsk mode',
  'sessions.longSessions': 'Sessions with 40+ human prompts',
  'tools.errorRate': 'tool_result is_error / tool_use',
  'tools.slowCommandsTotal': 'Bash commands that took 30 s or longer',
  'tools.suggestedAllowRules': 'Strictly read-only Bash verbs (git status/diff/log, ls, grep, ...; never runners or writers) run 3+ times, formatted as permission rules',
  'friction.interruptions': 'User pressed Esc while Claude worked',
  'friction.compactions': 'Context compactions (summaries injected into sessions)',
  'friction.permissionPrompts': 'Permission decisions made interactively (not by mode, rule, hook or classifier)',
  'friction.userRejections': 'Tool uses the user rejected',
  'friction.corrections': 'Prompts that start like a correction ("no, ...", "don\'t", "нет, ...", "не надо")',
  'friction.editMismatches': 'Edit tool failures (old_string not found, file changed since read)',
  'friction.userModifiedEdits': 'Edits where the user had changed the file manually in between',
  'friction.timeouts': 'Timed-out tool calls plus timeout-looking errors',
  'friction.hookNonBlockingErrors': 'Hook runs that reported an error (non-blocking)',
  'friction.failingHookCommands': 'Configured hook commands that failed 20+ times in the window',
  'friction.slowHooks': 'Hooks averaging 1.5 s+ or peaking at 10 s+ (completed runs only)',
  'friction.hookTimeouts': 'Hooks that were killed for exceeding their timeout: count and the configured limit',
  'autonomy.askUserQuestions': 'AskUserQuestion tool uses',
  'delegation.share': 'Share of sessions that spawned subagents',
  'skills.unusedCount': 'Installed skills never invoked in the window (0 when the window has fewer than 3 sessions)',
  'mcp.unusedCount': 'Configured MCP servers with zero calls in the window (0 when the window has fewer than 3 sessions)',
  'context.peakTokensMax': 'Largest prompt (input + cache) seen in one request',
  'context.claudeMdTokens': 'Estimated tokens of all CLAUDE.md / rules files that load every session',
  'quality.editsWithoutTestsShare': 'Share of sessions that edited files but never ran a test command',
  'quality.destructiveCommands': 'rm -rf, git reset --hard, DROP TABLE and similar',
  'quality.forcePushes': 'git push --force / -f / --force-with-lease',
  'habits.repeatedStemsCount': 'Distinct prompt openings repeated 3+ times (skill candidates)',
  'habits.nightShare': 'Share of prompts sent 23:00–06:00',
  'languages.primary': 'Most edited programming languages (by file extension)',
  'locale.lang': 'Detected dialog language (ru when 30%+ of prompt text is Cyrillic)',
  'insights.frictionTotal': 'Friction events counted by the built-in /insights facets, when present',
  'insights.dissatisfiedShare': 'Share of /insights satisfaction labels that read dissatisfied/frustrated',
};
