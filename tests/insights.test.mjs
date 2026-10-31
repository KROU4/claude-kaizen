// scripts/lib/insights.mjs: aggregation of the facets/session-meta files the built-in /insights command leaves behind.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readInsights } from '../scripts/lib/insights.mjs';
import { USAGE_DATA_FIXTURE, cleanupTempDirs, makeTempDir, writeJson, writeText } from './helpers.mjs';

after(() => cleanupTempDirs());

describe('readInsights on the fixture usage-data', () => {
  const r = readInsights(USAGE_DATA_FIXTURE);

  it('is available and counts the facets and session-meta files (the broken facet is skipped)', () => {
    assert.equal(r.available, true);
    assert.equal(r.facets, 3);
    assert.equal(r.sessionMeta, 3);
  });

  it('finds the newest report by file name', () => {
    assert.equal(r.lastReport, '2026-10-30');
  });

  it('counts outcome, helpfulness, session type and primary success labels', () => {
    assert.deepEqual(r.outcome, { mostly_achieved: 1, fully_achieved: 2 });
    assert.deepEqual(r.helpfulness, { very_helpful: 2, essential: 1 });
    assert.deepEqual(r.sessionType, { multi_task: 1, iterative_refinement: 1, single_task: 1 });
    assert.deepEqual(r.primarySuccess, { good_debugging: 1, multi_file_changes: 1, fast_accurate_search: 1 });
  });

  it('adds up satisfaction and friction counters across facets', () => {
    assert.deepEqual(r.satisfaction, { satisfied: 3, dissatisfied: 1, frustrated: 1, likely_satisfied: 1 });
    assert.deepEqual(r.friction, { wrong_approach: 3, tool_error: 1, excessive_asks: 2 });
  });

  it('sorts goal categories by count', () => {
    assert.equal(Object.keys(r.goalCategories)[0], 'debugging');
    assert.equal(r.goalCategories.debugging, 2);
  });

  it('keeps friction details with their kinds, redacting secrets', () => {
    assert.equal(r.frictionSamples.length, 2);
    // the order follows the directory listing, which is not the same on every file system
    const a = r.frictionSamples.find((s) => s.kinds.includes('tool_error'));
    const b = r.frictionSamples.find((s) => s.kinds.includes('excessive_asks'));
    assert.deepEqual(a.kinds.slice().sort(), ['tool_error', 'wrong_approach']);
    assert.ok(a.detail.includes('password=[REDACTED:secret]'));
    assert.deepEqual(b.kinds.slice().sort(), ['excessive_asks', 'wrong_approach']);
    assert.ok(!JSON.stringify(r.frictionSamples).includes('hunter2hunter2'));
  });

  it('sums the session-meta counters', () => {
    const m = r.meta;
    assert.equal(m.sessions, 3);
    assert.equal(m.durationMin, 19);
    assert.equal(m.userMessages, 16);
    assert.equal(m.assistantMessages, 44);
    assert.equal(m.interruptions, 1);
    assert.equal(m.toolErrors, 7);
    assert.equal(m.bashWouldPrompt, 7);
    assert.equal(m.destructiveCommands, 3);
    assert.equal(m.gitCommits, 2);
    assert.equal(m.gitPushes, 2);
  });

  it('counts how many sessions used subagents, MCP and web search', () => {
    assert.equal(r.meta.usesTaskAgent, 2);
    assert.equal(r.meta.usesMcp, 3);
    assert.equal(r.meta.usesWebSearch, 1);
  });

  it('merges tool error categories, language counters and response times', () => {
    assert.deepEqual(r.meta.toolErrorCategories, { 'Command Failed': 5, 'Edit Failed': 2 });
    assert.deepEqual(r.meta.languages, { TypeScript: 4, Python: 2, Markdown: 1, Go: 1 });
    assert.deepEqual([...r.meta.responseTimes].sort((a, b) => a - b), [8, 12.5, 30.1]);
  });
});

describe('readInsights: missing and partial data', () => {
  it('reports available:false and empty aggregates when the directory does not exist', () => {
    const r = readInsights(path.join(makeTempDir('kaizen-ins-'), 'nope'));
    assert.equal(r.available, false);
    assert.equal(r.facets, 0);
    assert.equal(r.lastReport, null);
    assert.deepEqual(r.friction, {});
    assert.equal(r.meta.sessions, 0);
  });

  it('is available as soon as one of the two subdirectories exists', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'facets', 'only.json'), { session_id: 'only', outcome: 'fully_achieved' });
    const r = readInsights(dir);
    assert.equal(r.available, true);
    assert.equal(r.facets, 1);
    assert.equal(r.sessionMeta, 0);
  });

  it('uses the file name when a facet has no session_id and ignores non-json files', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'facets', 'abc.json'), { outcome: 'x' });
    writeText(path.join(dir, 'facets', 'notes.txt'), 'ignored');
    assert.equal(readInsights(dir).facets, 1);
  });

  it('treats a non-numeric counter value as one occurrence', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'facets', 'a.json'), { friction_counts: { odd: 'yes', normal: 2 } });
    assert.deepEqual(readInsights(dir).friction, { odd: 1, normal: 2 });
  });

  it('keeps at most 25 friction samples, each truncated to 240 characters', () => {
    const dir = makeTempDir('kaizen-ins-');
    for (let i = 0; i < 30; i++) writeJson(path.join(dir, 'facets', `f${i}.json`), { friction_counts: { k: 1 }, friction_detail: 'x'.repeat(500) });
    const r = readInsights(dir);
    assert.equal(r.frictionSamples.length, 25);
    assert.equal(r.frictionSamples[0].detail.length, 240);
  });

  it('keeps at most 40 goal categories, most frequent first', () => {
    const dir = makeTempDir('kaizen-ins-');
    const goals = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`goal${i}`, i + 1]));
    writeJson(path.join(dir, 'facets', 'a.json'), { goal_categories: goals });
    const keys = Object.keys(readInsights(dir).goalCategories);
    assert.equal(keys.length, 40);
    assert.equal(keys[0], 'goal49');
  });
});

describe('readInsights: time window (sinceMs)', () => {
  it('keeps only sessions that started inside the window, and the facets that belong to them', () => {
    const r = readInsights(USAGE_DATA_FIXTURE, { sinceMs: Date.parse('2026-10-30T00:00:00Z') });
    assert.equal(r.sessionMeta, 1);
    assert.equal(r.facets, 1);
    assert.deepEqual(r.outcome, { fully_achieved: 1 });
    assert.deepEqual(r.friction, {});
  });

  it('keeps everything when the window starts before the first session', () => {
    const r = readInsights(USAGE_DATA_FIXTURE, { sinceMs: Date.parse('2026-01-01T00:00:00Z') });
    assert.equal(r.sessionMeta, 3);
    assert.equal(r.facets, 3);
  });

  it('counts nothing when every session is older than the window', () => {
    const r = readInsights(USAGE_DATA_FIXTURE, { sinceMs: Date.parse('2027-01-01T00:00:00Z') });
    assert.equal(r.sessionMeta, 0);
    assert.equal(r.facets, 0, 'facets of sessions outside the window must not be counted');
    assert.deepEqual(r.friction, {});
  });

  it('keeps a facet that has no session-meta file at all, because it cannot be dated', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'facets', 'undated.json'), { session_id: 'undated', outcome: 'fully_achieved' });
    const r = readInsights(dir, { sinceMs: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(r.facets, 1);
  });

  it('drops the facet of a session that is outside the window even when other sessions are inside it', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'session-meta', 'old.json'), { session_id: 'old', start_time: '2026-01-01T00:00:00Z' });
    writeJson(path.join(dir, 'session-meta', 'new.json'), { session_id: 'new', start_time: '2026-10-01T00:00:00Z' });
    writeJson(path.join(dir, 'facets', 'old.json'), { session_id: 'old', outcome: 'not_achieved' });
    writeJson(path.join(dir, 'facets', 'new.json'), { session_id: 'new', outcome: 'fully_achieved' });
    const r = readInsights(dir, { sinceMs: Date.parse('2026-06-01T00:00:00Z') });
    assert.deepEqual(r.outcome, { fully_achieved: 1 });
    assert.equal(r.sessionMeta, 1);
  });

  it('keeps a session whose start_time is missing or unparsable', () => {
    const dir = makeTempDir('kaizen-ins-');
    writeJson(path.join(dir, 'session-meta', 'a.json'), { session_id: 'a', duration_minutes: 3 });
    writeJson(path.join(dir, 'session-meta', 'b.json'), { session_id: 'b', start_time: 'garbage', duration_minutes: 4 });
    const r = readInsights(dir, { sinceMs: Date.parse('2030-01-01T00:00:00Z') });
    assert.equal(r.sessionMeta, 2);
    assert.equal(r.meta.durationMin, 7);
  });
});
