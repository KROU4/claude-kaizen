// scripts/lib/metrics.mjs: the measurement built from transcript summaries + inventory + /insights facets.
//
// The "fixture measure" below is built from the three synthetic transcripts, a real inventory() of a throw-away
// home assembled from tests/fixtures/claude-home (+ claude.json as ~/.claude.json) and readInsights() of
// tests/fixtures/usage-data. Scenario tests that need other inputs hand-build session summaries instead.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readInsights } from '../scripts/lib/insights.mjs';
import { inventory } from '../scripts/lib/inventory.mjs';
import { detectLang } from '../scripts/lib/i18n.mjs';
import { METRIC_DOCS, MEASURE_VERSION, MIN_SESSIONS_FOR_UNUSED, SAFE_VERBS, buildMeasure, suggestAllowRules } from '../scripts/lib/metrics.mjs';
import { loadCatalog, resolvePath } from '../scripts/lib/recipes.mjs';
import { commandVerb, newSessionSummary, scanTranscripts } from '../scripts/lib/transcripts.mjs';
import { PROJECTS_FIXTURE, USAGE_DATA_FIXTURE, cleanupTempDirs, materializeHome, setEnv } from './helpers.mjs';

let restoreEnv;
let sessions;
let scan;
let inv;
let ins;
let measure;

const ENV = { windowDays: 30, since: '2026-10-01T00:00:00.000Z', configDir: '/fixture/.claude', projectDir: null, platform: { platform: 'test', node: 'v0' }, claudeVersion: null, kitVersion: '0.0.0-test' };

/** A session summary for scenario tests: zeroed counters (filesEdited as a number, as after finalize) plus overrides. */
function makeSession(over = {}) {
  return { ...newSessionSummary('/projects/p/s.jsonl'), filesEdited: 0, durationMin: 0, ...over };
}

/** Empty sessions so that a scenario with one interesting session still has enough sessions for the "unused" metrics. */
function padding(n = MIN_SESSIONS_FOR_UNUSED - 1) {
  return Array.from({ length: n }, () => makeSession());
}

function findNonFinite(value, trail = '$') {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [trail];
  if (Array.isArray(value)) return value.flatMap((v, i) => findNonFinite(v, `${trail}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => findNonFinite(v, `${trail}.${k}`));
  return [];
}

/** True when `dotted` resolves in the measure, or sits in a map of counts where an absent key just means zero. */
function resolvesOrIsCount(m, dotted) {
  if (resolvePath(m, dotted) !== undefined) return true;
  const parent = resolvePath(m, dotted.split('.').slice(0, -1).join('.'));
  return !!parent && typeof parent === 'object' && !Array.isArray(parent) && Object.values(parent).every((v) => typeof v === 'number');
}

function collectMetricPaths(cond, out = new Set()) {
  if (!cond || typeof cond !== 'object') return out;
  if (Array.isArray(cond)) {
    cond.forEach((c) => collectMetricPaths(c, out));
    return out;
  }
  if (cond.metric) out.add(cond.metric);
  for (const key of ['all', 'any']) if (Array.isArray(cond[key])) cond[key].forEach((c) => collectMetricPaths(c, out));
  if (cond.not) collectMetricPaths(cond.not, out);
  return out;
}

before(async () => {
  const home = materializeHome();
  restoreEnv = setEnv({ ...home.env, CLAUDE_PROJECT_DIR: undefined });
  scan = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE });
  sessions = scan.sessions;
  inv = inventory({ projectDir: null });
  ins = readInsights(USAGE_DATA_FIXTURE);
  measure = buildMeasure({ sessions, inventory: inv, insights: ins, env: ENV, scan });
});

after(() => {
  if (restoreEnv) restoreEnv();
  cleanupTempDirs();
});

describe('measure envelope', () => {
  it('carries the measure version, a generation timestamp and the window', () => {
    assert.equal(measure.version, MEASURE_VERSION);
    assert.ok(Number.isFinite(Date.parse(measure.generatedAt)));
    assert.equal(measure.windowDays, 30);
    assert.equal(measure.since, ENV.since);
  });

  it('records the environment and scan statistics', () => {
    assert.equal(measure.env.kitVersion, '0.0.0-test');
    assert.equal(measure.env.scanned, 3);
    assert.equal(measure.env.cached, 0);
    assert.equal(measure.env.scanErrors, 0);
    assert.equal(measure.env.projectDir, null);
  });

  it('contains no NaN or Infinity anywhere', () => {
    assert.deepEqual(findNonFinite(measure), []);
  });

  it('survives a JSON round trip unchanged', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(measure)), measure);
  });

  it('never carries environment values from settings.json, only their names', () => {
    const text = JSON.stringify(measure);
    assert.ok(!text.includes('synthetic-not-a-real-key'));
    assert.deepEqual(measure.inventory.settings[0].envKeys, ['DEMO_API_KEY', 'LOG_LEVEL']);
  });

  it('never carries the text of prompts that are not part of a repeated opening', () => {
    const text = JSON.stringify(measure);
    for (const typed of ['Write a python script that converts the csv to json', 'Add a retry to the fetch helper', 'Refactor the config loader', 'Check the open issues for the importer']) {
      assert.ok(!text.includes(typed), `prompt text leaked into the measure: ${typed}`);
    }
  });

  it('keeps secrets out of repeated commands, correction samples and hook error samples', () => {
    const text = JSON.stringify(measure);
    for (const secret of ['swordfish123', 'FAKE-TOKEN-1234', 'FAKE-HOOK-SECRET-1', 'FAKE-DEPLOY-TOKEN', 'hunter2hunter2']) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `secret leaked into the measure: ${secret}`);
    }
  });
});

describe('totals', () => {
  it('adds up sessions, projects, prompts, responses, tool uses and active time', () => {
    const t = measure.totals;
    assert.equal(t.sessions, 3);
    assert.equal(t.projects, 2);
    assert.equal(t.userMessages, 16);
    assert.equal(t.assistantMessages, 44);
    assert.equal(t.toolUses, 48);
    assert.equal(t.durationMin, 19);
    assert.equal(t.activeDays, 2);
  });

  it('sums the cost of the sessions that reported one', () => {
    assert.equal(measure.totals.costUSD, 2);
    assert.equal(measure.totals.costSessions, 2);
  });

  it('sums token usage across models', () => {
    assert.deepEqual(measure.totals.tokens, { input: 278, output: 2044, cacheRead: 185000, cacheCreate: 6520 });
  });

  it('computes the cache hit rate as cache_read / (input + cache_read + cache_create)', () => {
    assert.equal(measure.totals.cacheHitRate, 0.965);
  });

  it('sums lines added/removed and distinct edited files per session', () => {
    assert.equal(measure.totals.linesAdded, 15);
    assert.equal(measure.totals.linesRemoved, 5);
    assert.equal(measure.totals.filesEdited, 6);
  });
});

describe('sessions', () => {
  it('derives rates from the window length', () => {
    assert.equal(measure.sessions.perDay, 0.1);
    assert.equal(measure.sessions.perActiveDay, 1.5);
  });

  it('computes prompt-count quantiles over sessions', () => {
    assert.equal(measure.sessions.medianUserMessages, 5);
    assert.equal(measure.sessions.p90UserMessages, 7.4);
    assert.equal(measure.sessions.longSessions, 0);
    assert.equal(measure.sessions.oneShotSessions, 0);
    assert.equal(measure.sessions.medianDurationMin, 4);
  });

  it('counts permission modes and the bypassPermissions share', () => {
    assert.deepEqual(measure.sessions.byPermissionMode, { default: 17, bypassPermissions: 2 });
    assert.equal(measure.sessions.bypassShare, 0.105);
    assert.equal(measure.sessions.planShare, 0);
  });

  it('counts entrypoints', () => {
    assert.deepEqual(Object.keys(measure.sessions.byEntrypoint).sort(), ['claude-desktop', 'cli']);
    assert.ok(measure.sessions.byEntrypoint.cli > measure.sessions.byEntrypoint['claude-desktop']);
  });

  it('ranks projects by prompts, naming them after the last two path segments', () => {
    assert.deepEqual(measure.sessions.topProjects, [
      { name: 'work/demo-app', sessions: 2, userMessages: 13, costUSD: 2 },
      { name: 'work/other', sessions: 1, userMessages: 3, costUSD: 0 },
    ]);
  });
});

describe('tools', () => {
  it('merges tool counts across sessions', () => {
    assert.equal(measure.tools.byName.Bash, 24);
    assert.equal(measure.tools.byName.Edit, 6);
    assert.equal(measure.tools.byName.mcp__github__get_issue, 3);
  });

  it('merges errors by tool and by class, and derives the error rate', () => {
    assert.deepEqual(measure.tools.errorsByName, { Bash: 5, Edit: 2 });
    assert.deepEqual(measure.tools.errorClasses, { 'edit-mismatch': 2, 'test-failure': 1, 'user-rejected': 1, other: 1, timeout: 1, 'nonzero-exit': 1 });
    assert.equal(measure.tools.errorRate, 0.1458);
  });

  it('averages tool durations', () => {
    assert.deepEqual(measure.tools.durations.Bash, { n: 24, avgMs: 10042, maxMs: 120000 });
  });

  it('merges Bash verbs across sessions', () => {
    assert.equal(measure.tools.bashVerbs['git status'], 3);
    assert.equal(measure.tools.bashVerbs['npm run'], 3);
    assert.equal(measure.tools.bashVerbs.rm, 2);
  });

  it('lists commands repeated three or more times, secrets already redacted', () => {
    const repeated = measure.tools.repeatedBashCommands;
    assert.deepEqual(repeated.map((c) => c.count), [3, 3]);
    assert.ok(repeated.some((c) => c.command === 'git status'));
    assert.ok(repeated.some((c) => c.command === './deploy.sh --token=[REDACTED:secret] --env staging'));
  });

  it('groups commands that ran 30 s or longer by verb', () => {
    assert.equal(measure.tools.slowCommandsTotal, 3);
    const byVerb = Object.fromEntries(measure.tools.slowBashCommands.map((c) => [c.verb, c]));
    assert.deepEqual(byVerb['npm run'], { verb: 'npm run', count: 1, maxSec: 40, avgSec: 40 });
    assert.deepEqual(byVerb['docker compose'], { verb: 'docker compose', count: 1, maxSec: 120, avgSec: 120 });
    assert.deepEqual(byVerb.pytest, { verb: 'pytest', count: 1, maxSec: 30, avgSec: 30 });
  });

  it('suggests an allow rule for git status because it ran three times', () => {
    const rule = measure.tools.suggestedAllowRules.find((r) => /^Bash\(git status[ :]\*\)$/.test(r.rule));
    assert.ok(rule, 'git status must be suggested');
    assert.equal(rule.count, 3);
  });

  it('does not suggest rules for verbs that ran fewer than three times, or for unsafe verbs', () => {
    const rules = measure.tools.suggestedAllowRules.map((r) => r.rule).join('\n');
    assert.ok(!/git diff/.test(rules), 'git diff ran only twice');
    assert.ok(!/\brm\b/.test(rules), 'rm is never suggested');
    assert.ok(!/deploy\.sh/.test(rules), 'unknown scripts are never suggested');
  });
});

describe('friction', () => {
  it('counts permission prompts only for decisions made by the user (source user_*)', () => {
    assert.equal(measure.friction.permissionPrompts, 5); // 3 user_permanent + 1 user_temporary + 1 user_reject
    assert.equal(measure.friction.permissionAutoAccepts, 10); // mode/config x8, hook x1, rule/config x1
  });

  it('merges permission decisions across sessions', () => {
    assert.deepEqual(measure.friction.permissionDecisions, {
      'accept/rule/user_permanent': 3,
      'accept/mode/config': 8,
      'accept/hook/hook': 1,
      'accept/rule/user_temporary': 1,
      'reject/user/user_reject': 1,
      'reject/rule/config': 1,
      'accept/rule/config': 1,
    });
  });

  it('reports rejections, denial kinds and rule denials', () => {
    assert.equal(measure.friction.userRejections, 1);
    assert.deepEqual(measure.friction.denialKinds, { 'user-rejected': 1, 'permission-rule': 1 });
    assert.equal(measure.friction.permissionRuleDenials, 1);
    assert.equal(measure.friction.autoModeBlocks, 0);
  });

  it('counts interruptions, compactions and corrections', () => {
    assert.equal(measure.friction.interruptions, 1);
    assert.equal(measure.friction.interruptionsPerSession, 0.33);
    assert.equal(measure.friction.compactions, 2);
    assert.equal(measure.friction.sessionsWithCompaction, 2);
    assert.equal(measure.friction.compactionShare, 0.667);
    assert.equal(measure.friction.corrections, 2);
    assert.equal(measure.friction.correctionsPerSession, 0.67);
  });

  it('collects redacted correction samples', () => {
    assert.deepEqual(measure.friction.correctionSamples, [
      "No, don't hardcode password=[REDACTED:secret] in the config",
      'Нет, не надо трогать конфиг, token=[REDACTED:secret]',
    ]);
  });

  it('counts edit mismatches, user-modified edits, timeouts and test failures', () => {
    assert.equal(measure.friction.editMismatches, 2);
    assert.equal(measure.friction.userModifiedEdits, 1);
    assert.equal(measure.friction.timeouts, 2); // one timeout-looking error + one timed-out tool result
    assert.equal(measure.friction.toolTimeouts, 1);
    assert.equal(measure.friction.testFailures, 1);
    assert.equal(measure.friction.toolErrors, 7);
    assert.equal(measure.friction.toolInterrupted, 1);
    assert.equal(measure.friction.backgroundTasks, 1);
  });

  it('counts hook runs and errors, and lists slow hooks', () => {
    assert.equal(measure.friction.hookRuns, 8); // 3 Stop-hook runs + 5 tool-hook attachments
    assert.equal(measure.friction.hookErrors, 1);
    assert.equal(measure.friction.hookNonBlockingErrors, 2);
    assert.deepEqual(measure.friction.slowHooks, [{ hook: 'x.mjs', runs: 2, avgMs: 2000, maxMs: 2500 }]);
    assert.equal(measure.friction.slowCommands, 3);
  });

  it('keeps redacted hook error samples', () => {
    assert.equal(measure.friction.hookErrorSamples.length, 2);
    assert.equal(measure.friction.hookErrorSamples[0].stderr, 'guard.mjs: cannot read config token=[REDACTED:secret]');
  });

  it('marks failing hooks that are still configured in settings', () => {
    const byEvent = Object.fromEntries(measure.friction.failingHooks.map((h) => [h.event, h]));
    assert.equal(byEvent.PostToolUse.configured, true);
    assert.equal(byEvent.PostToolUse.configuredCommand, 'npx prettier --write');
    assert.equal(byEvent.PreToolUse.configured, false);
    assert.deepEqual(measure.friction.failingHookCommands, []);
  });
});

describe('autonomy and delegation', () => {
  it('counts questions, plan mode and todo use', () => {
    assert.equal(measure.autonomy.askUserQuestions, 1);
    assert.equal(measure.autonomy.askPerSession, 0.33);
    assert.equal(measure.autonomy.planModeUses, 2);
    assert.equal(measure.autonomy.todoUses, 1);
    assert.equal(measure.autonomy.sessionsWithTodo, 1);
    assert.equal(measure.autonomy.defaultPermissionMode, 'default');
  });

  it('measures subagent delegation', () => {
    assert.equal(measure.delegation.sessionsWithSubagents, 2);
    assert.equal(measure.delegation.share, 0.667);
    assert.equal(measure.delegation.spawns, 3);
    assert.deepEqual(measure.delegation.byType, { 'code-reviewer': 1, 'general-purpose': 1, Explore: 1 });
    assert.deepEqual(measure.delegation.models, { haiku: 1 });
    assert.equal(measure.delegation.sidechainMessages, 4);
    assert.equal(measure.delegation.webSearches, 1);
    assert.equal(measure.delegation.webFetches, 1);
  });
});

describe('skills and plugins', () => {
  it('lists installed skills by source', () => {
    assert.equal(measure.skills.installed, 4);
    assert.deepEqual(measure.skills.installedBySource, { user: 2, plugin: 2 });
    assert.deepEqual(measure.skills.installedNames.slice().sort(), ['demo-plugin-skill', 'demo-skill', 'idle-plugin-skill', 'idle-skill']);
  });

  it('counts skill and slash command use', () => {
    assert.deepEqual(measure.skills.used, { 'demo-skill': 1 });
    assert.deepEqual(measure.skills.slashCommands, { commit: 1, review: 1 });
  });

  it('lists installed skills that were never invoked', () => {
    assert.ok(measure.skills.unused.includes('idle-skill'));
    assert.ok(!measure.skills.unused.includes('demo-skill'), 'demo-skill was invoked');
    assert.equal(measure.skills.unusedCount, 3);
    assert.equal(measure.skills.unusedShare, 0.75);
  });

  it('lists plugins none of whose skills ran and that served no MCP call', () => {
    assert.deepEqual(measure.skills.unusedPlugins, ['idle@fixture-market']);
    assert.deepEqual(measure.skills.pluginUsage, { demo: { skills: 1, used: 0 }, idle: { skills: 1, used: 0 } });
  });

  it('does not report a plugin as unused when its MCP server was called (mcp__plugin_demo_srv__tool)', () => {
    assert.ok(!measure.skills.unusedPlugins.some((p) => p.startsWith('demo@')));
  });

  it('estimates the context cost of skill descriptions', () => {
    assert.ok(measure.skills.descriptionTokens > 0);
    assert.equal(measure.context.skillDescriptionTokens, measure.skills.descriptionTokens);
  });
});

describe('mcp', () => {
  it('lists configured servers that were never called', () => {
    assert.deepEqual(measure.mcp.unused, ['dead-srv']);
    assert.equal(measure.mcp.unusedCount, 1);
    assert.equal(measure.mcp.configuredCount, 2);
  });

  it('does not list a configured server that was called', () => {
    assert.ok(!measure.mcp.unused.includes('used-srv'));
  });

  it('reports usage per server, plugin servers included', () => {
    assert.equal(measure.mcp.used.github.calls, 3);
    assert.equal(measure.mcp.used['used-srv'].calls, 1);
    assert.deepEqual(measure.mcp.used.plugin_demo_srv, { calls: 1, distinctTools: 1, topTools: { tool: 1 } });
    assert.deepEqual(measure.mcp.pluginServers, ['plugin_demo_srv']);
  });

  it('exposes the configured server names by scope', () => {
    assert.deepEqual(measure.mcp.configured.user, ['used-srv', 'dead-srv']);
    assert.deepEqual(measure.mcp.configured.project, []);
  });
});

describe('context', () => {
  it('detects that CLAUDE.md already contains a language rule ("Always answer in English")', () => {
    assert.equal(measure.context.claudeMdHints.language, true);
    assert.equal(measure.context.claudeMdHints.tests, false);
    assert.equal(measure.context.claudeMdHints.readBeforeEdit, false);
    assert.equal(measure.context.claudeMdHints.verification, false);
    assert.equal(measure.context.claudeMdHints.autonomy, false);
  });

  it('measures CLAUDE.md size', () => {
    assert.ok(measure.context.claudeMdLines >= 120);
    assert.ok(measure.context.claudeMdTokens > 500);
    assert.equal(measure.context.userClaudeMdTokens, measure.context.claudeMdTokens);
    assert.equal(measure.context.claudeMdFiles.length, 1);
  });

  it('summarizes the prompt-size peaks', () => {
    assert.equal(measure.context.peakTokensMax, 6273);
    assert.equal(measure.context.sessionsOver150k, 0);
    assert.equal(measure.context.sessionsOver400k, 0);
    assert.equal(measure.context.thinkingMinutes, 2);
  });

  it('summarizes the configured hooks', () => {
    assert.equal(measure.context.hooksCount, 2);
    assert.deepEqual(measure.context.hookEvents, { PostToolUse: 1, Stop: 1 });
    assert.equal(measure.context.hasFormatterHook, true);
    assert.equal(measure.context.hasStopHook, true);
    assert.equal(measure.context.hasGuardHook, false);
    assert.equal(measure.context.hasNotifyHook, false);
    assert.equal(measure.context.hasSessionStartHook, false);
    assert.equal(measure.context.hasPreCompactHook, false);
    assert.equal(measure.context.kaizenHooks, 0);
  });

  it('summarizes permissions, status line, agents and plugins', () => {
    assert.equal(measure.context.hasDenyRules, false);
    assert.equal(measure.context.denyRulesText, '');
    assert.equal(measure.context.statusLine, false);
    assert.equal(measure.context.agentsInstalled, 2);
    assert.equal(measure.context.installedPlugins, 2);
    assert.equal(measure.context.disabledPlugins, 1);
    assert.equal(measure.context.settingsLanguage, null);
    assert.equal(measure.context.cleanupPeriodDays, null);
  });
});

describe('quality', () => {
  it('counts destructive commands (rm -rf x2, git reset --hard) and exactly one force push', () => {
    assert.equal(measure.quality.destructiveCommands, 3);
    assert.ok(measure.quality.destructiveCommands >= 2);
    assert.equal(measure.quality.forcePushes, 1);
  });

  it('counts commits, pushes and test runs', () => {
    assert.equal(measure.quality.commits, 2);
    assert.equal(measure.quality.pushes, 2);
    assert.equal(measure.quality.testCommands, 3);
    assert.equal(measure.quality.testFailures, 1);
    assert.equal(measure.quality.testsPerCommit, 1.5);
    assert.deepEqual(measure.quality.gitVerbs, { push: 2, commit: 2, reset: 1 });
  });

  it('measures how many editing sessions never ran a test', () => {
    assert.equal(measure.quality.sessionsWithEdits, 3);
    assert.equal(measure.quality.sessionsWithTests, 2);
    assert.equal(measure.quality.sessionsWithEditsNoTests, 1);
    assert.equal(measure.quality.editsWithoutTestsShare, 0.333);
    assert.equal(measure.quality.sessionsWithCommits, 1);
  });
});

describe('habits', () => {
  it('lists prompt openings repeated three or more times, with the first redacted sample', () => {
    assert.equal(measure.habits.repeatedStemsCount, 1);
    assert.equal(measure.habits.repeatedStems[0].count, 3);
    assert.deepEqual(measure.habits.repeatedStems[0], { stem: 'deploy the service to staging and', count: 3, sample: 'Deploy the service to staging and check logs' });
  });

  it('measures prompt length', () => {
    assert.equal(measure.habits.promptMedianChars, 41);
    assert.equal(measure.habits.shortPromptsShare, 0.5);
  });

  it('keeps 24 hourly and 7 weekday buckets that sum to the prompt count', () => {
    assert.equal(measure.habits.hours.length, 24);
    assert.equal(measure.habits.weekdays.length, 7);
    assert.equal(measure.habits.hours.reduce((a, b) => a + b, 0), 16);
    assert.equal(measure.habits.weekdays.reduce((a, b) => a + b, 0), 16);
  });
});

describe('languages', () => {
  it('orders primary languages by edits across sessions, ignoring config and markdown', () => {
    assert.deepEqual(measure.languages.primary, ['typescript', 'python', 'go']);
    assert.deepEqual(measure.languages.extensions, { '.ts': 4, '.py': 2, '.md': 1, '.json': 1, '.go': 1 });
  });

  it('picks the formatter of the top language', () => {
    assert.equal(measure.languages.formatter, 'prettier');
  });

  it('puts python first when python edits dominate, and falls back to "auto" without any edits', () => {
    const py = makeSession({ extensions: { '.py': 5, '.ts': 1 } });
    const m = buildMeasure({ sessions: [py], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(m.languages.primary, ['python', 'typescript']);
    assert.equal(m.languages.formatter, 'ruff');
    const none = buildMeasure({ sessions: [makeSession()], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(none.languages.primary, []);
    assert.equal(none.languages.formatter, 'auto');
  });

  it('groups extensions of the same language (.ts and .tsx are both typescript)', () => {
    const m = buildMeasure({ sessions: [makeSession({ extensions: { '.ts': 1, '.tsx': 2, '.js': 2 } })], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(m.languages.byLanguage, { typescript: 3, javascript: 2 });
  });
});

describe('locale', () => {
  it('detects English for the fixture prompts (a few Russian ones stay far below the threshold)', () => {
    assert.equal(measure.locale.lang, 'en');
    assert.ok(measure.locale.cyrillicShare > 0 && measure.locale.cyrillicShare < 0.3);
  });

  it('detects Russian for a second scenario made of Russian prompts', () => {
    const russian = makeSession({ langSample: ['Привет, посмотри на этот код и скажи что не так', 'Пожалуйста, исправь ошибку в тестах'] });
    const m = buildMeasure({ sessions: [russian], inventory: inv, insights: null, env: ENV });
    assert.equal(m.locale.lang, 'ru');
    assert.equal(m.locale.cyrillicShare, 1);
  });

  it('detects Russian when Russian prompts mix with English technical words', () => {
    const mixed = makeSession({ langSample: ['Посмотри на unit тесты в модуле router и исправь падающий кейс', 'Добавь retry в fetch helper и запусти сборку'] });
    const m = buildMeasure({ sessions: [mixed], inventory: inv, insights: null, env: ENV });
    assert.equal(m.locale.lang, 'ru');
    assert.ok(m.locale.cyrillicShare >= 0.3 && m.locale.cyrillicShare < 1);
  });

  it('pools prompt samples of all sessions: a few Russian prompts among many English ones stay English', () => {
    const russian = makeSession({ langSample: ['Привет, посмотри на этот код и скажи что не так'] });
    const m = buildMeasure({ sessions: [...sessions, russian], inventory: inv, insights: ins, env: ENV, scan });
    assert.equal(m.locale.lang, 'en');
  });

  it('stays English just below the threshold', () => {
    // 2 Cyrillic letters against 8 Latin letters = 0.2
    const m = buildMeasure({ sessions: [makeSession({ langSample: ['аб', 'abcdefgh'] })], inventory: inv, insights: null, env: ENV });
    assert.equal(m.locale.lang, 'en');
    assert.equal(m.locale.cyrillicShare, 0.2);
  });

  it('switches to Russian exactly at 0.3', () => {
    const m = buildMeasure({ sessions: [makeSession({ langSample: ['абв', 'abcdefg'] })], inventory: inv, insights: null, env: ENV });
    assert.equal(m.locale.lang, 'ru');
    assert.equal(m.locale.cyrillicShare, 0.3);
    assert.deepEqual(detectLang(['абв', 'abcdefg']), { lang: 'ru', cyrillicShare: 0.3 });
  });
});

describe('prompt stems across sessions', () => {
  it('adds the counts of the same stem from different sessions', () => {
    const a = makeSession({ promptStems: { 'fix the failing build please': 2 }, promptSamples: { 'fix the failing build please': 'Fix the failing build please' } });
    const b = makeSession({ promptStems: { 'fix the failing build please': 2, 'one off request about css': 1 } });
    const m = buildMeasure({ sessions: [a, b], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(m.habits.repeatedStems, [{ stem: 'fix the failing build please', count: 4, sample: 'Fix the failing build please' }]);
  });

  it('does not report a stem that was seen only twice in total', () => {
    const a = makeSession({ promptStems: { 'rename the helper module': 1 } });
    const b = makeSession({ promptStems: { 'rename the helper module': 1 } });
    const m = buildMeasure({ sessions: [a, b], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(m.habits.repeatedStems, []);
    assert.equal(m.habits.repeatedStemsCount, 0);
  });

  it('orders repeated stems by count', () => {
    const a = makeSession({ promptStems: { 'first stem here now': 3, 'second stem here now': 5 } });
    const m = buildMeasure({ sessions: [a], inventory: inv, insights: null, env: ENV });
    assert.deepEqual(m.habits.repeatedStems.map((s) => s.count), [5, 3]);
  });
});

describe('permission prompts', () => {
  const withDecisions = (permissionDecisions) => buildMeasure({ sessions: [makeSession({ permissionDecisions })], inventory: inv, insights: null, env: ENV }).friction;

  it('counts user_permanent, user_temporary and user_reject but not mode, hook or rule decisions', () => {
    const f = withDecisions({
      'accept/rule/user_permanent': 2,
      'accept/rule/user_temporary': 1,
      'reject/user/user_reject': 1,
      'accept/mode/config': 7,
      'accept/hook/hook': 3,
      'reject/rule/config': 4,
    });
    assert.equal(f.permissionPrompts, 4);
    assert.equal(f.permissionAutoAccepts, 10);
  });

  it('is zero when nothing was decided interactively', () => {
    assert.equal(withDecisions({ 'accept/mode/config': 5 }).permissionPrompts, 0);
    assert.equal(withDecisions({}).permissionPrompts, 0);
  });

  it('takes the highest of the three rejection signals for userRejections', () => {
    const s = makeSession({ userRejections: 0, permissionDecisions: { 'reject/user/user_reject': 3 }, denialKinds: { 'user-rejected': 2 } });
    assert.equal(buildMeasure({ sessions: [s], inventory: inv, insights: null, env: ENV }).friction.userRejections, 3);
  });

  it('counts dontAsk like bypassPermissions in bypassShare', () => {
    const s = makeSession({ permissionModes: { dontAsk: 1, bypassPermissions: 1, default: 2 } });
    assert.equal(buildMeasure({ sessions: [s], inventory: inv, insights: null, env: ENV }).sessions.bypassShare, 0.5);
  });
});

describe('suggestAllowRules', () => {
  it('suggests a rule only when the verb ran at least three times', () => {
    assert.deepEqual(suggestAllowRules({ 'git status': 2 }), []);
    const rules = suggestAllowRules({ 'git status': 3 });
    assert.equal(rules.length, 1);
    assert.match(rules[0].rule, /^Bash\(git status[ :]\*\)$/);
    assert.equal(rules[0].count, 3);
  });

  it('never suggests unsafe or unknown verbs, however often they ran', () => {
    assert.deepEqual(suggestAllowRules({ rm: 50, curl: 50, sudo: 50, 'git push': 50, 'git reset': 50, 'docker rm': 50, bash: 50, sh: 50 }), []);
  });

  it('never suggests runners, interpreters or verbs whose prefix covers writes or deletes', () => {
    const risky = [
      'uv run', 'poetry run', 'make', 'npm run', 'npm test', 'npm exec', 'npx', 'node', 'node --test', 'python', 'python -m', 'python3 -m', 'pytest', 'cargo build', 'cargo test', 'go build', 'go test',
      'docker compose', 'docker run', 'docker exec', 'find', 'echo', 'cat', 'rg', 'fd', 'sed', 'awk', 'tee', 'xargs', 'eval', 'env',
      'git stash', 'git branch', 'git remote', 'git fetch', 'git checkout', 'git push', 'git reset', 'git clean', 'git config', 'git tag', 'git add',
      'gh api', 'gh pr', 'gh issue', 'gh run', 'gh release', 'kubectl apply', 'kubectl delete', 'rm', 'mv', 'cp', 'curl', 'wget', 'ssh', 'sudo', 'bash', 'sh', 'powershell',
    ];
    const verbs = Object.fromEntries(risky.map((v) => [v, 50]));
    assert.deepEqual(suggestAllowRules(verbs), []);
    for (const v of risky) assert.ok(!SAFE_VERBS.has(v), `${v} must not be in SAFE_VERBS`);
  });

  it('only ever emits rules from the strict read-only allowlist', () => {
    const rules = suggestAllowRules(Object.fromEntries([...SAFE_VERBS].map((v) => [v, 5]))).map((r) => r.rule);
    assert.equal(rules.length, SAFE_VERBS.size);
    for (const rule of rules) {
      const verb = rule.replace(/^Bash\((.*):\*\)$/, '$1');
      assert.ok(SAFE_VERBS.has(verb), rule);
      assert.doesNotMatch(rule, /\b(run|exec|compose|build|install|rm|push|delete)\b/);
    }
  });

  it('lists only verbs that commandVerb() can actually produce from a real command line', () => {
    for (const v of SAFE_VERBS) assert.equal(commandVerb(`${v} some-arg`), v, `dead allowlist entry: ${v}`);
  });

  it('sorts by count and honours minCount', () => {
    const rules = suggestAllowRules({ 'git diff': 4, 'git status': 9, ls: 6 }, { minCount: 4 });
    assert.deepEqual(rules.map((r) => r.count), [9, 6, 4]);
    assert.equal(suggestAllowRules({ 'git diff': 4 }, { minCount: 5 }).length, 0);
  });
});

describe('unused MCP servers', () => {
  const withMcp = (mcp, user = ['github', 'dead-srv']) => {
    const i = structuredClone(inv);
    i.mcp = { user, project: [], local: [], disabledProject: [] };
    return buildMeasure({ sessions: [makeSession({ mcp }), ...padding()], inventory: i, insights: null, env: ENV }).mcp;
  };

  it('stays empty below the minimum number of sessions, so thin data never recommends removing every server', () => {
    const i = structuredClone(inv);
    i.mcp = { user: ['github', 'dead-srv'], project: [], local: [], disabledProject: [] };
    for (const sessions of [[], [makeSession()], padding(MIN_SESSIONS_FOR_UNUSED - 1)]) {
      const m = buildMeasure({ sessions, inventory: i, insights: null, env: ENV }).mcp;
      assert.deepEqual(m.unused, []);
      assert.equal(m.unusedCount, 0);
      assert.equal(m.configuredCount, 2);
    }
  });

  it('lists configured servers without calls', () => {
    assert.deepEqual(withMcp({ github: { calls: 2, tools: { x: 2 } } }).unused, ['dead-srv']);
  });

  it('treats a plugin-provided server as the configured one when the names overlap', () => {
    assert.deepEqual(withMcp({ plugin_github_github: { calls: 1, tools: { x: 1 } } }).unused, ['dead-srv']);
  });

  it('lists every configured server when nothing was called', () => {
    assert.deepEqual(withMcp({}).unused, ['github', 'dead-srv']);
  });
});

describe('unused skills and plugins', () => {
  const run = (session) => buildMeasure({ sessions: [makeSession(session), ...padding()], inventory: inv, insights: null, env: ENV }).skills;

  it('reports nothing as unused below the minimum number of sessions', () => {
    for (const sessions of [[], padding(MIN_SESSIONS_FOR_UNUSED - 1)]) {
      const skills = buildMeasure({ sessions, inventory: inv, insights: null, env: ENV }).skills;
      assert.deepEqual(skills.unused, []);
      assert.equal(skills.unusedCount, 0);
      assert.equal(skills.unusedShare, 0);
      assert.deepEqual(skills.unusedPlugins, []);
      assert.equal(skills.installed, 4);
    }
  });

  it('counts a slash command with the skill name as use', () => {
    const skills = run({ slashCommands: { 'idle-skill': 2 } });
    assert.ok(!skills.unused.includes('idle-skill'));
  });

  it('counts a namespaced skill call (plugin:skill) as use of that plugin skill', () => {
    const skills = run({ skills: { 'idle:idle-plugin-skill': 1 } });
    assert.ok(!skills.unused.includes('idle-plugin-skill'));
    assert.deepEqual(skills.pluginUsage.idle, { skills: 1, used: 1 });
    assert.deepEqual(skills.unusedPlugins, ['demo@fixture-market']);
  });

  it('keeps a plugin out of unusedPlugins when only its MCP server was called', () => {
    const skills = run({ mcp: { plugin_idle_server: { calls: 1, tools: { t: 1 } } } });
    assert.deepEqual(skills.unusedPlugins, ['demo@fixture-market']);
    assert.deepEqual(skills.pluginUsage.idle, { skills: 1, used: 0 });
  });

  it('lists both plugins when nothing was used', () => {
    assert.deepEqual(run({}).unusedPlugins, ['demo@fixture-market', 'idle@fixture-market']);
  });
});

describe('insights section', () => {
  it('aggregates facet friction and orders it by count', () => {
    assert.deepEqual(measure.insights.friction, { wrong_approach: 3, excessive_asks: 2, tool_error: 1 });
    assert.equal(measure.insights.frictionTotal, 6);
  });

  it('copies outcome, satisfaction, helpfulness and session types', () => {
    assert.equal(measure.insights.available, true);
    assert.equal(measure.insights.facets, 3);
    assert.equal(measure.insights.lastReport, '2026-10-30');
    assert.deepEqual(measure.insights.outcome, { mostly_achieved: 1, fully_achieved: 2 });
    assert.deepEqual(measure.insights.satisfaction, { satisfied: 3, dissatisfied: 1, frustrated: 1, likely_satisfied: 1 });
    assert.deepEqual(measure.insights.helpfulness, { very_helpful: 2, essential: 1 });
    assert.deepEqual(measure.insights.sessionType, { multi_task: 1, iterative_refinement: 1, single_task: 1 });
  });

  it('computes the dissatisfied share from dissatisfied/frustrated/unsatisfied labels only', () => {
    assert.equal(measure.insights.dissatisfiedShare, 0.333); // 2 of 6 labels; "satisfied" and "likely_satisfied" do not count
  });

  it('keeps redacted friction samples', () => {
    assert.equal(measure.insights.frictionSamples.length, 2);
    assert.ok(measure.insights.frictionSamples.some((s) => s.detail.includes('password=[REDACTED:secret]')));
  });

  it('reports available:false and zeros when /insights data is missing', () => {
    const m = buildMeasure({ sessions, inventory: inv, insights: null, env: ENV, scan });
    assert.equal(m.insights.available, false);
    assert.equal(m.insights.frictionTotal, 0);
    assert.equal(m.insights.dissatisfiedShare, 0);
    assert.deepEqual(m.insights.friction, {});
  });
});

describe('an empty window', () => {
  it('builds a measure with zeros and no NaN when there are no sessions', () => {
    const m = buildMeasure({ sessions: [], inventory: inv, insights: null, env: ENV });
    assert.equal(m.totals.sessions, 0);
    assert.equal(m.totals.cacheHitRate, 0);
    assert.equal(m.sessions.perActiveDay, 0);
    assert.equal(m.sessions.bypassShare, 0);
    assert.equal(m.friction.permissionPrompts, 0);
    assert.equal(m.quality.testsPerCommit, null);
    assert.equal(m.quality.editsWithoutTestsShare, 0);
    assert.equal(m.habits.shortPromptsShare, 0);
    assert.equal(m.locale.lang, 'en');
    assert.deepEqual(findNonFinite(m), []);
  });
});

describe('consistency with the recipe catalog and the metric docs', () => {
  it('resolves every metric documented in METRIC_DOCS', () => {
    const missing = Object.keys(METRIC_DOCS).filter((key) => !resolvesOrIsCount(measure, key));
    assert.deepEqual(missing, [], `documented metrics the measure does not produce: ${missing.join(', ')}`);
  });

  it('resolves every metric path used by a catalog condition (a typo would silently disable the recipe)', () => {
    const catalog = loadCatalog();
    const problems = [];
    for (const r of catalog.recipes) {
      const paths = collectMetricPaths(r.when);
      for (const b of r.boost || []) collectMetricPaths(b.when, paths);
      for (const a of r.actions || []) collectMetricPaths(a.when, paths);
      for (const p of paths) if (!resolvesOrIsCount(measure, p)) problems.push(`${r.id}: ${p}`);
    }
    assert.deepEqual(problems, []);
  });

  it('resolves every placeholder used in recipe titles, reasons and evidence', () => {
    const catalog = loadCatalog();
    const problems = [];
    for (const r of catalog.recipes) {
      for (const field of ['title', 'why', 'evidence']) {
        for (const lang of ['en', 'ru']) {
          for (const m of String(r[field][lang]).matchAll(/\{([a-zA-Z0-9_.]+)(?:\|[a-z]+)?\}/g)) {
            if (m[1].startsWith('params.')) continue;
            if (!resolvesOrIsCount(measure, m[1])) problems.push(`${r.id}.${field}.${lang}: {${m[1]}}`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});
