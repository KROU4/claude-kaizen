// Turns per-session summaries + inventory + /insights facets into the
// measurement object (measure.json). Every metric that a recipe may test is
// documented in docs/metrics.md (generated from METRIC_DOCS below).
import { detectLang } from './i18n.mjs';
import { topN } from './transcripts.mjs';
import { redact } from './redact.mjs';

export const MEASURE_VERSION = 1;
/** Fewer sessions than this cannot show that a skill or MCP server is unused, so those metrics stay empty. */
export const MIN_SESSIONS_FOR_UNUSED = 3;
/**
 * A configured hook is offered for removal only when it failed at least this many times AND, when its runs can be counted,
 * in at least this share of them. When they cannot (see hookRunCount) the rate is unknown, but the recorded runs are a lower
 * bound on the runs, so errors / recorded is an upper bound on the rate: the hook is offered only if even that reaches the share.
 */
export const FAILING_HOOK_MIN_ERRORS = 20;
export const FAILING_HOOK_MIN_RATE = 0.5;

/**
 * Tool renames Claude Code still honours in hook matchers (legacy name -> current name). A list entry is mapped through them
 * (a matcher 'Task' selects Agent, 'KillShell' / 'KillBash' select TaskStop) and a regex is also tested against the legacy
 * names of the tool ('^Task$' selects Agent). Transcripts log the current names, so without this such a matcher selects no call.
 */
const LEGACY_TOOL_NAMES = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  KillBash: 'TaskStop',
  ListPeers: 'ListAgents',
  Brief: 'SendUserMessage',
  ListMcpResources: 'ListMcpResourcesTool',
  ReadMcpResource: 'ReadMcpResourceTool',
  ReadMcpResourceDir: 'ReadMcpResourceDirTool'
};
/** List entries that stand for a family of tools: 'Artifact' also covers these. */
const TOOL_FAMILIES = { Artifact: ['ArtifactComments', 'ArtifactData', 'ArtifactCheck'] };
/** current tool name -> its legacy names */
const LEGACY_OF = new Map();
for (const [legacy, current] of Object.entries(LEGACY_TOOL_NAMES)) LEGACY_OF.set(current, [...(LEGACY_OF.get(current) || []), legacy]);

/**
 * The names a hook matcher selects, with Claude Code's own rules: '' and '*' select everything; a matcher made only of
 * letters, digits, _ | , space and - is an exact list split on | or , (entries trimmed, mapped through the tool aliases),
 * so 'Edit, Write' and 'Edit | Write' select Edit and Write and 'Task' selects Agent; anything else is a regex tested
 * anywhere in the name (or in one of its legacy names), unanchored ('mcp__.*__write' selects mcp__filesystem__write_file).
 * null = not a usable pattern.
 */
function matcherTest(matcher) {
  const m = String(matcher || '').trim();
  if (!m || m === '*') return () => true;
  if (/^[a-zA-Z0-9_|, -]+$/.test(m)) {
    const names = new Set();
    for (const entry of m.split(/[|,]/).map((x) => x.trim()).filter(Boolean)) {
      names.add(entry);
      if (LEGACY_TOOL_NAMES[entry]) names.add(LEGACY_TOOL_NAMES[entry]);
      for (const member of TOOL_FAMILIES[entry] || []) names.add(member);
    }
    // an old transcript may log a legacy name: it is the same tool as its current name
    return (name) => names.has(name) || names.has(LEGACY_TOOL_NAMES[name]);
  }
  try {
    const re = new RegExp(m);
    return (name) => {
      const current = LEGACY_TOOL_NAMES[name] || name;
      return re.test(name) || re.test(current) || (LEGACY_OF.get(current) || []).some((legacy) => re.test(legacy));
    };
  } catch {
    return null;
  }
}

/** True when a session ran in the project (or below it); unknown on either side counts as inside, so nothing is dropped on a guess. */
function inProject(cwd, projectDir) {
  if (!projectDir || !cwd) return true;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(cwd);
  const p = norm(projectDir);
  return c === p || c.startsWith(`${p}/`);
}

/**
 * How many times a hook had the chance to run in ONE session, from `snap` on (see hooks.oppsSince; null = the whole session,
 * which is what the callers pass). `tests` are the matchers that apply to this session.
 * UserPromptSubmit: the prompts. SessionStart: one start (matcher startup|resume|clear) plus the compactions (matcher compact).
 * PreToolUse: the tool uses its matcher selects. PostToolUse: the same minus the failed ones (it does not run on a failure).
 * PostToolUseFailure: the failed ones. The run that wrote the first record is counted (+1) whichever line came first.
 * null when the event has no such count.
 */
function sessionOpportunities(event, tests, s, snap) {
  const since = snap || {};
  const trigger = snap ? 1 : 0;
  const prompts = s.userMessages || 0;
  if (event === 'UserPromptSubmit') return Math.min(prompts, Math.max(0, prompts - (since.prompts || 0)) + trigger);
  if (event === 'SessionStart') {
    const match = (source) => tests.some((x) => x(source));
    return (['startup', 'resume', 'clear'].some(match) ? 1 : 0) + (match('compact') ? Math.max(0, (s.compactions || 0) - (since.compactions || 0)) : 0);
  }
  const opps = (s.hooks && s.hooks.opps) || {};
  const uses = opps.toolUses || {};
  const fails = opps.toolFailures || {};
  const delta = (cur, base, name) => Math.max(0, (cur[name] || 0) - ((base && base[name]) || 0));
  let n = 0;
  for (const name of new Set([...Object.keys(uses), ...Object.keys(fails)])) {
    if (!tests.some((x) => x(name))) continue;
    const used = delta(uses, since.toolUses, name);
    const failed = delta(fails, since.toolFailures, name);
    n += event === 'PreToolUse' ? used : event === 'PostToolUse' ? Math.max(0, used - failed) : failed;
  }
  return n > 0 ? n + trigger : 0;
}

/**
 * How many times a hook had the chance to run, summed over the sessions in which it left at least one record (a session
 * without a record says nothing about this hook: it may not have existed yet, or belong to another project). `entries` are
 * the configured {matcher, scope} of the hook; a project or local entry applies only to sessions of the project.
 * null when there is no such count (other events, or a matcher that is unknown or not a valid pattern).
 */
function hookOpportunities(event, entries, records, projectDir) {
  if (!['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event)) return null;
  const takesMatcher = event !== 'UserPromptSubmit' && event !== 'SessionStart';
  if (takesMatcher && !entries.length) return null; // not in any settings file: its matcher is unknown
  // an unconfigured UserPromptSubmit / SessionStart hook is counted without a matcher
  const applicable = entries.length ? entries : [{ matcher: '', scope: 'user' }];
  let n = 0;
  for (const { s, snap, recorded } of records) {
    const here = inProject(s.cwd, projectDir);
    const tests = [];
    for (const e of applicable) {
      if ((e.scope === 'project' || e.scope === 'local') && !here) continue;
      const test = event === 'UserPromptSubmit' ? () => true : matcherTest(e.matcher);
      if (!test) return null;
      tests.push(test);
    }
    // A session of another project can hold a hook of the same text that is not this one: only its recorded runs are certain.
    // The whole session is counted, not only from the first record on: silent successes leave no trace, so the first record
    // is usually a failure, and counting from it would inflate the failure rate of a hook that fails late in a session.
    void snap;
    n += tests.length ? Math.max(recorded, sessionOpportunities(event, tests, s, null)) : recorded;
  }
  return n;
}

/**
 * Runs of one hook, or null when they cannot be told. Claude Code writes a hook_* attachment only for a run that produced
 * output or failed, so for every event but Stop / SubagentStop (counted from the stop_hook_summary line, which lists every
 * hook that ran) the recorded runs are a lower bound, and runs == errors would make any hook look like it fails every time.
 * Those events use max(recorded, opportunities) when the opportunities are known and at least the errors; otherwise null.
 */
function hookRunCount(event, errors, recorded, entries, records, projectDir) {
  if (event === 'Stop' || event === 'SubagentStop') return recorded > 0 && recorded >= errors ? recorded : null;
  const opps = hookOpportunities(event, entries, records, projectDir);
  return opps !== null && opps >= errors ? Math.max(recorded, opps) : null;
}

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
/** How Claude Code writes an MCP server name into tool names (mcp__<this>__<tool>). */
function mcpToolServerName(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

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

// Words of a hook script name that make a "protect*"/"*guard" hook a destructive-command guard / a non-destructive one.
const GUARD_POS = new Set(['rm', 'delete', 'deletion', 'force', 'main', 'master', 'branch', 'push', 'reset', 'git', 'dangerous', 'destructive']);
const GUARD_NEG = new Set(['secret', 'secrets', 'env', 'dotenv', 'file', 'files', 'key', 'keys', 'credential', 'credentials', 'path', 'paths']);
const GUARD_DEL = new Set(['rm', 'delete', 'deletion', 'force']); // the only words that make "protect-<secrets|env|files>-.." a destructive-command guard

/**
 * Is this hook command a destructive-command guard? Judged per script name (directories do not count): guard|block-force|
 * destructive|dangerous, or protect* whose next word is not secrets/env/files/keys/..; a positive word (rm, force, main,
 * git, push, ...) anywhere in the name wins, a negative one ("secrets-guard", "protect-env-vars") rules a bare guard out.
 */
export function isGuardHookCommand(command) {
  for (const raw of String(command).split(/["'\s]+/)) {
    const name = raw.split(/[\\/]/).pop();
    const w = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const pos = w.some((x) => GUARD_POS.has(x));
    const viaGuard = /guard|block[-_]?force|destructive|dangerous/i.test(name) && (pos || !w.some((x) => GUARD_NEG.has(x)));
    const p = w.findIndex((x) => x.startsWith('protect'));
    // protect-<secrets|env|files|keys..>-<anything> is a file/secret protector unless a deletion word is present (main/git/push do not count);
    // "protect-sensitive-<x>" is judged by <x> ("-files" no, "-commands" yes)
    const nx = w[p + 1] === 'sensitive' ? w[p + 2] : w[p + 1];
    if (viaGuard || (p >= 0 && (GUARD_NEG.has(nx) ? w.some((x) => GUARD_DEL.has(x)) : true))) return true;
  }
  return false;
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

export function suggestAllowRules(bashVerbs, { minCount = 3, exclude = [] } = {}) {
  const have = new Set(exclude);
  if (exclude.some((r) => r === 'Bash' || r === 'Bash(*)')) return []; // a blanket Bash rule allows every command
  // `Bash(git:*)` / `Bash(git *)` already allow every `git ...` verb, `Bash(git diff*)` every `git diff...`; an exact `Bash(git diff)` allows only itself.
  const ms = exclude.map((r) => /^Bash\((.+?)(:\*| \*|\*)\)$/.exec(String(r))).filter(Boolean);
  const prefixes = ms.filter((m) => m[2] !== '*').map((m) => m[1].trim());
  const rawPrefixes = ms.filter((m) => m[2] === '*').map((m) => m[1]);
  const covered = (verb) => prefixes.some((p) => verb === p || verb.startsWith(p + ' ')) || rawPrefixes.some((p) => verb.startsWith(p));
  const out = [];
  for (const [verb, n] of Object.entries(bashVerbs)) {
    if (n < minCount || !SAFE_VERBS.has(verb)) continue;
    const rule = `Bash(${verb}:*)`;
    if (have.has(rule) || covered(verb)) continue; // already allowed: nothing to ask for
    out.push({ rule, count: n });
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
  // cost-state totals are cumulative per session and carry no timestamp: a session that began before the window contributes its
  // whole cost, not the part inside it (costWindowCut is set by scanTranscripts for a session spread over several copies).
  const costPartial = costSessions.filter((s) => (s.costWindowCut ?? s.windowCut) === true);

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
    costPartialSessions: costPartial.length,
    costInWindowUSD: round(sum(costSessions, (s) => s.costUSD) - sum(costPartial, (s) => s.costUSD), 2),
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
  const powershellVerbs = {};
  const bashCommands = {};
  const slowByVerb = {};
  for (const s of S) {
    merge(toolsByName, s.toolUses);
    merge(errorsByName, s.toolErrors);
    merge(errorClasses, s.errorClasses);
    merge(bashVerbs, s.bashVerbs);
    merge(powershellVerbs, s.powershellVerbs);
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
    // PowerShell tool commands: counted apart from Bash because no Bash(...) allow rule covers them
    powershellVerbs: topN(powershellVerbs, 30),
    repeatedBashCommands: Object.entries(bashCommands)
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([command, count]) => ({ command, count })),
    slowBashCommands: Object.entries(slowByVerb)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15)
      .map(([verb, v]) => ({ verb, count: v.count, maxSec: Math.round(v.maxMs / 1000), avgSec: Math.round(v.totalMs / v.count / 1000) })),
    // per-session lists are capped; the per-session count keeps the true total
    slowCommandsTotal: sum(S, (s) => (typeof s.slowCommandCount === 'number' ? s.slowCommandCount : (s.slowCommands || []).length)),
    suggestedAllowRules: suggestAllowRules(bashVerbs, { exclude: inventory.permissions.allowRules }),
  };

  // ---- friction
  const permissionDecisions = {};
  const hookDurations = {};
  const hookRunsByCommand = {};
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
    merge(hookRunsByCommand, s.hooks.runsByCommand);
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
  // settings.hook.remove edits only the user, project and local settings files. Hooks of plugins and of managed
  // settings are counted for has*Hook but cannot be removed that way, so they stay in the digest as information only.
  const removableScopes = new Set(['user', 'project', 'local']);
  const normalizeCmd = (c) => String(c).replace(/\s+/g, ' ').trim();
  const configuredNorm = new Map(inventory.hooks.commands.filter((c) => !c.scope || removableScopes.has(c.scope)).map((c) => [normalizeCmd(c.command), c.command]));
  const fixedSource = new Map();
  for (const c of inventory.hooks.commands) {
    const src = c.scope === 'managed' ? 'managed' : String(c.scope || '').startsWith('plugin:') ? 'plugin' : null;
    if (src && !fixedSource.has(normalizeCmd(c.command))) fixedSource.set(normalizeCmd(c.command), src);
  }
  // matchers of every configured entry (any scope) by `event|command`: they tell which tool uses a PreToolUse / PostToolUse hook ran on
  const matchersOf = new Map();
  for (const c of inventory.hooks.commands) {
    const k = `${c.event}|${normalizeCmd(c.command)}`;
    if (!matchersOf.has(k)) matchersOf.set(k, []);
    matchersOf.get(k).push({ matcher: c.matcher || '', scope: c.scope || 'user' });
  }
  // the sessions in which each `event|normalized command` left a record, with the counters at its first record there
  const recordsOf = new Map();
  for (const s of S) {
    const seen = new Map();
    const normKeyOf = (key) => `${key.slice(0, key.indexOf('|'))}|${normalizeCmd(key.slice(key.indexOf('|') + 1))}`;
    const note = (key, snap) => {
      const k = normKeyOf(key);
      if (!seen.has(k)) seen.set(k, { snap: null, recorded: 0 });
      if (snap && !seen.get(k).snap) seen.get(k).snap = snap;
    };
    for (const key of Object.keys(s.hooks.oppsSince || {})) note(key, s.hooks.oppsSince[key]);
    for (const key of [...Object.keys(s.hooks.runsByCommand || {}), ...Object.keys(s.hooks.errorsByCommand || {})]) note(key, null);
    for (const [key, n] of Object.entries(s.hooks.runsByCommand || {})) seen.get(normKeyOf(key)).recorded += n;
    for (const [k, { snap, recorded }] of seen) {
      if (!recordsOf.has(k)) recordsOf.set(k, []);
      recordsOf.get(k).push({ s, snap, recorded });
    }
  }
  const projectDir = env.projectDir || null;
  const recordedNorm = {}; // recorded runs by `event|normalized command`
  for (const [key, n] of Object.entries(hookRunsByCommand)) {
    const idx = key.indexOf('|');
    const k = `${key.slice(0, idx)}|${normalizeCmd(key.slice(idx + 1))}`;
    recordedNorm[k] = (recordedNorm[k] || 0) + n;
  }
  // Total runs: the recorded ones are a lower bound, so every configured hook is raised to the runs it had the chance to make
  // in every session of the window (a hook that always succeeds silently leaves no record at all). The failure rate below is
  // stricter: it counts only the sessions where the hook left a record.
  const everySession = S.map((s) => ({ s, snap: null, recorded: 0 }));
  let hookRunsEstimated = sum(Object.entries(recordedNorm).filter(([k]) => !matchersOf.has(k)), ([, n]) => n);
  for (const [k, matchers] of matchersOf) {
    const recorded = recordedNorm[k] || 0;
    hookRunsEstimated += hookRunCount(k.slice(0, k.indexOf('|')), 0, recorded, matchers, everySession, projectDir) ?? recorded;
  }
  const failingHooks = Object.entries(errorsByCommand)
    .map(([key, errors]) => {
      const idx = key.indexOf('|');
      const event = key.slice(0, idx);
      const command = key.slice(idx + 1);
      const configured = configuredNorm.get(normalizeCmd(command)) || null;
      // `command` is the display copy (redacted); `configuredCommand` stays exactly as written in settings.json for matching
      const source = configured ? null : fixedSource.get(normalizeCmd(command)) || null; // 'managed' / 'plugin': not removable
      // runs of this very hook (same event and command as the errors, any outcome). hookDurations is keyed by script name and would
      // mix hooks that share it. null = not countable (see hookRunCount): the rate is unknown and the digest says so.
      const recorded = hookRunsByCommand[key] || 0;
      const normKey = `${event}|${normalizeCmd(command)}`;
      const runs = hookRunCount(event, errors, recorded, matchersOf.get(normKey) || [], recordsOf.get(normKey) || [], projectDir);
      return {
        event,
        command: redact(command),
        errors,
        runs,
        runsRecorded: recorded,
        failureRate: runs === null ? null : round(errors / runs, 3),
        configured: !!configured,
        configuredCommand: configured,
        ...(source ? { source } : {}),
      };
    })
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);
  const failingHookCommands = failingHooks.filter((h) => h.configured && h.errors >= FAILING_HOOK_MIN_ERRORS && (h.failureRate ?? h.errors / Math.max(h.runsRecorded, h.errors)) >= FAILING_HOOK_MIN_RATE).map((h) => h.configuredCommand);
  // configured in the user's settings and failing, but below the removal threshold: "not in your settings" is false for them
  const flakyConfiguredHooks = failingHooks.filter((h) => h.configured && !failingHookCommands.includes(h.configuredCommand));
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
    const [decision, reason, source] = k.split('/');
    // source "user_temporary" / "user_reject" = the human answered a prompt; "config" / "hook" = resolved by mode, rule,
    // classifier or a PreToolUse hook. reason "rule" is a saved rule matching (accept/rule/user_permanent is the user's own
    // allow rule from settings, applied without asking), so it is auto even though a user wrote the rule.
    const interactive = /^user/i.test(source || '') && reason !== 'rule';
    if (decision === 'accept' && !interactive) autoAccept += v;
    else if (decision === 'accept') promptedAccept += v;
    else if (decision === 'reject' && interactive) promptedReject += v;
  }
  const sessionsWithCompaction = S.filter((s) => s.compactions > 0).length;
  const denialKinds = {};
  for (const s of S) merge(denialKinds, s.denialKinds);
  // Sessions driven through the SDK (scripts, bots, e2e tests) are not the human typing; keep them out of the habit and correction metrics.
  const isAutomated = (s) => {
    const e = s.entrypoints || {};
    const total = sum(Object.values(e)) || 1;
    const sdk = sum(Object.entries(e).filter(([k]) => /^sdk/i.test(k)), ([, v]) => v);
    return sdk / total > 0.5;
  };
  const typed = S.filter((s) => !isAutomated(s));
  const corrections = sum(typed, (s) => s.corrections);
  const correctionSamples = [];
  for (const s of typed) for (const c of s.correctionSamples || []) if (correctionSamples.length < 20) correctionSamples.push(c);
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
    hookRuns, // recorded runs: a lower bound, a hook that succeeds without output leaves no record
    hookRunsEstimated,
    hookErrors,
    hookNonBlockingErrors: hookNonBlocking,
    hookErrorSamples,
    failingHooks,
    failingHookCommands,
    flakyConfiguredHooks,
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
  // A plugin is also in use through its subagents ('plugin:agent' spawn types) and its hooks, which disabling would switch off.
  const pluginsWithSubagents = new Set(Object.keys(subagentsByType).filter((k) => k.includes(':')).map((k) => k.slice(0, k.indexOf(':'))));
  const pluginsWithHooks = new Set(inventory.hooks.commands.filter((c) => typeof c.scope === 'string' && c.scope.startsWith('plugin:')).map((c) => c.scope.slice(7)));
  // ...and through its slash commands / skills ('plugin:name' keys), which have no SKILL.md in the inventory.
  const pluginsWithSlash = new Set([...Object.keys(slash), ...Object.keys(skillsUsed)].filter((k) => k.includes(':')).map((k) => k.slice(0, k.indexOf(':'))));
  const unusedPlugins = (enoughUsage ? inventory.plugins.installed : [])
    .filter((p) => pluginUsage[p.name] && pluginUsage[p.name].used === 0 && !Object.keys(mcpUsedByPlugin(S)).includes(p.name) && !pluginsWithSubagents.has(p.name) && !pluginsWithSlash.has(p.name) && !pluginsWithHooks.has(p.name) && !(p.components && p.components.hooks))
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
  // servers of the shared .mcp.json that the user disabled, or never approved, are not loaded and so cost nothing. A server
  // switched off with /mcp for this project (disabledMcpServers) is off only here: that spares a project or local server
  // (it exists only for this project), but a user-scope server stays connected, and costs context, in every other project,
  // and the transcript scan covers all of them. So it stays a candidate no matter which directory measure runs from.
  const inactiveProject = new Set([...(inventory.mcp.disabledProject || []), ...(inventory.mcp.pendingProject || [])]);
  const disabledHere = new Set(inventory.mcp.disabledHere || []);
  const configured = new Set([
    ...inventory.mcp.user,
    ...[...inventory.mcp.project.filter((n) => !inactiveProject.has(n)), ...inventory.mcp.local].filter((n) => !disabledHere.has(n)),
  ]);
  // Claude Code builds tool names as mcp__<server with every char outside [a-zA-Z0-9_-] replaced by '_'>__<tool>, so
  // compare the normalised configured name with the transcript key exactly; the configured name stays as written.
  const usedServers = new Set(Object.keys(mcpUsed));
  const unusedMcp = (enoughUsage ? [...configured] : []).filter((name) => !usedServers.has(mcpToolServerName(name)));
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
    hasGuardHook: inventory.hooks.commands.some((c) => isGuardHookCommand(c.command)),
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
    // code edits only (docs and images excluded); summaries from before the split fall back to all edits
    sessionsWithEditsNoTests: S.filter((s) => (s.codeFilesEdited ?? s.filesEdited) > 0 && s.testCommands === 0).length,
    sessionsWithEdits: S.filter((s) => (s.codeFilesEdited ?? s.filesEdited) > 0).length,
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
  'totals.costUSD': 'Sum of per-session cost as recorded by Claude Code (cost-state lines, counted once per session). It is the cost of whole sessions: a session that began before the window contributes all of it',
  'totals.costPartialSessions': 'Sessions in costUSD that began before the window (their cost includes time outside it)',
  'totals.costInWindowUSD': 'Part of costUSD that belongs to sessions entirely inside the window',
  'totals.cacheHitRate': 'cache_read / (input + cache_read + cache_create) across assistant messages',
  'sessions.bypassShare': 'Share of user turns in bypassPermissions or dontAsk mode',
  'sessions.longSessions': 'Sessions with 40+ human prompts',
  'tools.errorRate': 'tool_result is_error / tool_use',
  'tools.slowCommandsTotal': 'Bash commands that took 30 s or longer',
  'tools.suggestedAllowRules': 'Strictly read-only Bash verbs (git status/diff/log, ls, grep, ...; never runners or writers) run 3+ times, formatted as permission rules; rules already in an allow list are left out',
  'friction.interruptions': 'User pressed Esc while Claude worked',
  'friction.compactions': 'Context compactions (summaries injected into sessions)',
  'friction.permissionPrompts': 'Permission decisions made interactively (not by mode, rule, hook or classifier)',
  'friction.userRejections': 'Tool uses the user rejected',
  'friction.corrections': 'Prompts that start like a correction ("no, ...", "don\'t", "нет, ...", "не надо")',
  'friction.editMismatches': 'Edit tool failures (old_string not found, file changed since read)',
  'friction.userModifiedEdits': 'Edits where the user had changed the file manually in between',
  'friction.timeouts': 'Timed-out tool calls plus timeout-looking errors',
  'friction.hookNonBlockingErrors': 'Hook runs that reported an error (non-blocking)',
  'friction.hookRuns': 'Hook runs Claude Code recorded (a lower bound: a hook that succeeds without output leaves no record)',
  'friction.hookRunsEstimated': 'Hook runs with every configured hook raised to the runs it had the chance to make (prompts, tool uses of its matcher, sessions) in the window; failure rates use only the sessions where that hook left a record',
  'friction.failingHookCommands': 'Configured hook commands that failed 20+ times in the window and, when their runs can be counted, in at least half of them (when they cannot, in at least half of the runs that were recorded)',
  'friction.flakyConfiguredHooks': 'Failing hooks that are configured in user, project or local settings but stay below the removal threshold of failingHookCommands (fewer than 20 errors, or under half of their runs)',
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
