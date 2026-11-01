// scripts/lib/digest.mjs: measure.json -> measure.md, the only thing an LLM reads about the user's history.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DELTA_METRICS, compareMeasures, renderDigest } from '../scripts/lib/digest.mjs';
import { loadLocale, translator } from '../scripts/lib/i18n.mjs';
import { buildMeasure } from '../scripts/lib/metrics.mjs';
import { buildFixtureMeasure, cleanupTempDirs } from './helpers.mjs';

after(() => cleanupTempDirs());

let fixture;
let measure;
before(async () => {
  fixture = await buildFixtureMeasure();
  measure = fixture.measure;
});

describe('renderDigest: units follow the language', () => {
  it('writes avg/max/ms/s/min/h in Russian in Russian mode, with no English unit left over', () => {
    const md = renderDigest(measure, 'ru');
    const d = loadLocale('ru').digest;
    assert.ok(md.includes(`\`x.mjs\`: 2 ${d.runs}, ${d.avg} 2000 ${d.unit_ms}, ${d.max} 2500 ${d.unit_ms}`), md);
    assert.ok(md.includes(`\`docker compose\`: 1×, ${d.avg} 120 ${d.unit_s}, ${d.max} 120 ${d.unit_s}`), md);
    assert.doesNotMatch(md, /\bavg \d|\bmax \d|\d ms\b|\bmedian \d|\d min\./);
    assert.ok(md.includes(`${d.unit_s}.`), 'the reply gap carries the Russian unit');
  });
});

describe('renderDigest', () => {
  it('starts with the localized title as a level-1 heading', () => {
    assert.equal(renderDigest(measure, 'en').split('\n')[0], `# ${loadLocale('en').digest.title}`);
    assert.equal(renderDigest(measure, 'ru').split('\n')[0], `# ${loadLocale('ru').digest.title}`);
  });

  it('defaults to the language detected in the measurement', () => {
    assert.equal(renderDigest(measure), renderDigest(measure, 'en'));
    const ru = { ...measure, locale: { lang: 'ru', cyrillicShare: 0.9 } };
    assert.equal(renderDigest(ru).split('\n')[0], `# ${loadLocale('ru').digest.title}`);
  });

  it('summarizes the window in the intro line', () => {
    const md = renderDigest(measure, 'en');
    assert.ok(md.includes('Window: last 30 days (2 active days). 3 sessions across 2 projects, 16 human prompts.'), md.split('\n').slice(0, 4).join('\n'));
  });

  it('has one level-2 heading per area, in a fixed order, in both languages', () => {
    for (const lang of ['en', 'ru']) {
      const d = loadLocale(lang).digest;
      const headings = renderDigest(measure, lang).split('\n').filter((l) => l.startsWith('## '));
      assert.deepEqual(headings, [d.snapshot, d.friction, d.tools, d.autonomy, d.extensions, d.context, d.quality, d.habits, d.insights].map((h) => `## ${h}`));
    }
  });

  it('shows the facts recipes are chosen from: slow hooks, slow commands, allow rules, unused MCP, repeated prompts', () => {
    const md = renderDigest(measure, 'en');
    assert.ok(md.includes(`\`x.mjs\`: 2 ${loadLocale('en').digest.runs}, avg 2000 ms, max 2500 ms`));
    assert.ok(md.includes('`docker compose`: 1×, avg 120 s, max 120 s'), 'no stray space before the comma');
    assert.ok(/`Bash\(git status[ :]\*\)` \(3\)/.test(md));
    assert.ok(md.includes('**dead-srv**'));
    assert.ok(md.includes('3× “deploy the service to staging and” — Deploy the service to staging and check logs'));
  });

  it('prints correction samples with their secrets already redacted', () => {
    const md = renderDigest(measure, 'en');
    assert.ok(md.includes("- No, don't hardcode password=[REDACTED:secret] in the config"));
    assert.ok(md.includes('- Нет, не надо трогать конфиг, token=[REDACTED:secret]'));
  });

  it('contains no secret from the fixtures and none of the unrepeated prompts', () => {
    const md = renderDigest(measure, 'en');
    for (const secret of ['swordfish123', 'FAKE-TOKEN-1234', 'FAKE-HOOK-SECRET-1', 'FAKE-DEPLOY-TOKEN', 'hunter2hunter2']) assert.ok(!md.toLowerCase().includes(secret.toLowerCase()), secret);
    for (const typed of ['Write a python script that converts the csv to json', 'Refactor the config loader', 'Check the open issues for the importer']) assert.ok(!md.includes(typed), typed);
  });

  it('is Russian in Russian', () => {
    const md = renderDigest(measure, 'ru');
    assert.ok(md.includes(loadLocale('ru').digest.friction));
    assert.ok(/[а-яё]{4,}/i.test(md.split('\n')[2]));
  });

  it('omits the /insights section when no facets are available', () => {
    const without = buildMeasure({ sessions: fixture.sessions, inventory: fixture.inventory, insights: null, env: { windowDays: 30, since: '2026-10-01T00:00:00.000Z', configDir: '/x', projectDir: null, platform: { platform: 'test', node: 'v0' }, claudeVersion: null, kitVersion: '0' }, scan: fixture.scan });
    const md = renderDigest(without, 'en');
    assert.ok(!md.includes(`## ${loadLocale('en').digest.insights}`));
    assert.ok(md.includes(`## ${loadLocale('en').digest.habits}`));
  });

  it('ends with the footer pointing at measure.json and a trailing newline', () => {
    const md = renderDigest(measure, 'en');
    assert.ok(md.endsWith(`${translator('en')('digest.footer', { file: 'measure.json' })}\n`));
  });

  it('escapes pipe characters inside table cells so tables stay intact', () => {
    const odd = structuredClone(measure);
    odd.sessions.medianUserMessages = 'a|b';
    const md = renderDigest(odd, 'en');
    assert.ok(md.includes('a\\|b'));
  });

  it('labels the PowerShell verbs line with its own key, not the Bash one plus a suffix', () => {
    for (const lang of ['en', 'ru']) {
      const tl = loadLocale(lang).tl;
      assert.ok(tl.powershell_verbs && tl.powershell_verbs !== tl.bash_verbs, lang);
      const md = renderDigest({ ...measure, tools: { ...measure.tools, powershellVerbs: { 'git status': 3 } } }, lang);
      assert.ok(md.includes(`${tl.powershell_verbs}: `), md);
      assert.ok(!md.includes(`${tl.bash_verbs} (PowerShell)`));
    }
  });

  it('handles an empty window without throwing', () => {
    const empty = buildMeasure({ sessions: [], inventory: fixture.inventory, insights: null, env: { windowDays: 30, since: '2026-10-01T00:00:00.000Z', configDir: '/x', projectDir: null, platform: { platform: 'test', node: 'v0' }, claudeVersion: null, kitVersion: '0' } });
    const md = renderDigest(empty, 'en');
    assert.ok(md.includes('0 sessions across 0 projects'));
    assert.ok(!md.includes('NaN'));
  });
});

describe('renderDigest: hook failure rate and cost scope (round 8)', () => {
  const withHooks = (failingHooks, extra = {}) => ({ ...structuredClone(measure), friction: { ...structuredClone(measure.friction), failingHooks, ...extra } });
  const known = { event: 'PostToolUse', command: 'npx prettier --write', errors: 25, runs: 400, runsRecorded: 25, failureRate: 0.063, configured: true, configuredCommand: 'npx prettier --write' };
  const unknown = { event: 'Notification', command: 'node notify.mjs', errors: 30, runs: null, runsRecorded: 30, failureRate: null, configured: true, configuredCommand: 'node notify.mjs' };

  it('shows a failing hook with its runs and rate, and a hook whose runs cannot be counted as rate unknown (never 100%)', () => {
    const md = renderDigest(withHooks([known, unknown]), 'en');
    assert.ok(md.includes('- `npx prettier --write` (PostToolUse): 25 errors in 400 runs (6.3% of them)'), md);
    assert.ok(md.includes('- `node notify.mjs` (Notification): 30 errors, failure rate unknown'), md);
    assert.ok(!/node notify\.mjs.*100%/.test(md));
  });

  it('says the same in Russian, without English leftovers in the new lines', () => {
    const md = renderDigest(withHooks([known, unknown]), 'ru');
    assert.ok(md.includes('- `npx prettier --write` (PostToolUse): 25 ошибок за 400 запусков (6.3% запусков)'), md);
    assert.ok(md.includes('- `node notify.mjs` (Notification): 30 ошибок, доля сбоев неизвестна'), md);
    assert.ok(!md.includes('failure rate unknown'));
  });

  it('marks a failing hook that is not in the settings files, with its source when it has one', () => {
    const md = renderDigest(withHooks([{ ...known, configured: false, configuredCommand: null }, { ...known, command: 'node corp.mjs', configured: false, configuredCommand: null, source: 'managed' }]), 'en');
    assert.ok(md.includes('(6.3% of them); not in the settings files'), md);
    assert.ok(md.includes('`node corp.mjs` (PostToolUse): 25 errors in 400 runs (6.3% of them); managed'), md);
  });

  it('shows the recorded and the estimated hook runs side by side', () => {
    assert.ok(renderDigest(withHooks([], { hookRuns: 10, hookRunsEstimated: 480 }), 'en').includes('10 recorded, ~480 estimated'));
    assert.ok(renderDigest(withHooks([], { hookRuns: 10, hookRunsEstimated: 480 }), 'ru').includes('10 записано, ~480 по оценке'));
  });

  it('labels the cost as whole-session cost when sessions began before the window, and says nothing otherwise', () => {
    assert.ok(!renderDigest(measure, 'en').includes('cumulative totals of whole sessions'));
    const partial = { ...structuredClone(measure), totals: { ...measure.totals, costSessions: 4, costPartialSessions: 3, costInWindowUSD: 1.25 } };
    assert.ok(renderDigest(partial, 'en').includes('3 of 4 sessions with a cost began before the window'));
    assert.ok(renderDigest(partial, 'en').includes('$1.25'));
    assert.ok(renderDigest(partial, 'ru').includes('3 из 4 сессий со стоимостью начались до окна'));
  });
});

describe('compareMeasures', () => {
  const t = translator('en');
  const at = (obj) => structuredClone(obj);
  const base = () => ({ totals: { sessions: 10, userMessages: 100, costUSD: 1.234 }, friction: { permissionPrompts: 20, compactionShare: 0.5, interruptionsPerSession: 1.5 }, tools: { errorRate: 0.1 } });

  it('reports metrics present in both measurements, formatted by kind', () => {
    const prev = base();
    const cur = at(prev);
    cur.friction.permissionPrompts = 10;
    cur.friction.compactionShare = 0.25;
    cur.totals.costUSD = 2.5;
    const rows = Object.fromEntries(compareMeasures(prev, cur, t).map((r) => [r.path, r]));
    assert.equal(rows['friction.permissionPrompts'].before, '20');
    assert.equal(rows['friction.permissionPrompts'].now, '10');
    assert.equal(rows['friction.permissionPrompts'].change, '-10');
    assert.equal(rows['friction.compactionShare'].before, '50%');
    assert.equal(rows['friction.compactionShare'].change, '-25%');
    assert.equal(rows['totals.costUSD'].before, '$1.23');
    assert.equal(rows['totals.costUSD'].change, '+$1.27');
  });

  it('marks a drop in a lower-is-better metric as better and a rise as worse', () => {
    const prev = base();
    const cur = at(prev);
    cur.friction.permissionPrompts = 10;
    cur.tools.errorRate = 0.3;
    const rows = Object.fromEntries(compareMeasures(prev, cur, t).map((r) => [r.path, r]));
    assert.equal(rows['friction.permissionPrompts'].better, true);
    assert.equal(rows['tools.errorRate'].better, false);
  });

  it('does not judge changes under 5 percent, or metrics without a direction', () => {
    const prev = base();
    prev.friction.permissionPrompts = 100;
    const cur = at(prev);
    cur.friction.permissionPrompts = 104; // +4 percent
    cur.totals.sessions = 30; // tripled, but sessions has no better/worse direction
    const rows = Object.fromEntries(compareMeasures(prev, cur, t).map((r) => [r.path, r]));
    assert.equal(rows['friction.permissionPrompts'].better, null);
    assert.equal(rows['totals.sessions'].better, null);
  });

  it('judges a change of exactly 5 percent', () => {
    const prev = base();
    prev.friction.permissionPrompts = 100;
    const cur = at(prev);
    cur.friction.permissionPrompts = 105;
    const row = compareMeasures(prev, cur, t).find((r) => r.path === 'friction.permissionPrompts');
    assert.equal(row.better, false);
  });

  it('treats growth from zero as a full change', () => {
    const prev = base();
    prev.friction.permissionPrompts = 0;
    const cur = at(prev);
    cur.friction.permissionPrompts = 4;
    const row = compareMeasures(prev, cur, t).find((r) => r.path === 'friction.permissionPrompts');
    assert.equal(row.relative, 1);
    assert.equal(row.better, false);
  });

  it('skips metrics that are missing or not numbers on either side', () => {
    const prev = { totals: { sessions: 5 } };
    const cur = { totals: { sessions: 'many' }, friction: { permissionPrompts: 3 } };
    assert.deepEqual(compareMeasures(prev, cur, t), []);
  });

  it('only compares the metrics listed in DELTA_METRICS', () => {
    const rows = compareMeasures(base(), base(), t);
    const known = new Set(DELTA_METRICS.map(([path]) => path));
    assert.ok(rows.length > 0 && rows.every((r) => known.has(r.path)));
    assert.ok(rows.every((r) => r.change === '0' || r.change === '0%' || r.change === '$0.00'));
  });
});

describe('renderDigest with a previous measurement', () => {
  const d = loadLocale('en').digest;
  const earlier = () => {
    const prev = structuredClone(measure);
    prev.generatedAt = '2026-10-01T10:00:00.000Z';
    prev.windowDays = 14;
    prev.friction.permissionPrompts = 20;
    return prev;
  };

  it('adds a "what moved" table with the previous date and window', () => {
    const md = renderDigest(measure, 'en', earlier());
    assert.ok(md.includes(`## ${d.delta}`));
    assert.ok(md.includes('2026-10-01'));
    assert.ok(md.includes(`| ${loadLocale('en').f.permission_prompts} | 20 | 1 | -19 ✓ |`), md.slice(md.indexOf(`## ${d.delta}`)));
    assert.ok(md.includes('(14-day window)'));
    assert.ok(md.includes('(30-day window)'));
  });

  it('adds nothing without a previous measurement', () => {
    assert.ok(!renderDigest(measure, 'en').includes(`## ${d.delta}`));
    assert.ok(!renderDigest(measure, 'en', null).includes(`## ${d.delta}`));
  });

  it('adds nothing when the previous measurement has no comparable numbers', () => {
    assert.ok(!renderDigest(measure, 'en', { generatedAt: '2026-10-01T00:00:00.000Z', windowDays: 30 }).includes(`## ${d.delta}`));
  });
});
