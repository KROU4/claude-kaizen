// scripts/lib/console.mjs and console/index.html: the data injected into the page, the choices validation, and the
// local server that receives the user's selection (exercised in a child process through the real CLI).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { loadLocale } from '../scripts/lib/i18n.mjs';
import { buildConsoleData, renderConsole, validateChoices } from '../scripts/lib/console.mjs';
import { CLI, KIT_ROOT, childEnv, cleanupTempDirs, materializeHome, readJson, runCli, writeJson } from './helpers.mjs';

const PAGE = path.join(KIT_ROOT, 'console', 'index.html');

after(() => cleanupTempDirs());

const recommendation = (over = {}) => ({
  id: 'settings.cleanup-period',
  category: 'settings',
  impact: 'low',
  risk: 'low',
  effort: 'low',
  scope: 'user',
  scopes: ['user'],
  title: 'Keep transcripts for 90 days',
  why: 'Longer window.',
  evidence: '3 sessions in 30 days.',
  matched: true,
  score: 1,
  params: [],
  actionsSummary: ['settings.json: cleanupPeriodDays = 90'],
  kind: 'recipe',
  source: null,
  conflicts: [],
  ...over,
});

/** Pull the object assigned to `const KAIZEN = ...;` out of a rendered page. */
function extractData(html) {
  const marker = 'const KAIZEN = ';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'rendered page must assign KAIZEN');
  const end = html.indexOf('\n', start);
  const line = html.slice(start + marker.length, end).replace(/;\s*$/, '');
  return JSON.parse(line);
}

const flattenLeaves = (obj, prefix = '', out = []) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flattenLeaves(v, `${prefix}${k}.`, out);
    else out.push(`${prefix}${k}`);
  }
  return out;
};

describe('buildConsoleData', () => {
  const rec = { sessions: 3, windowDays: 30, recommendations: [recommendation(), recommendation({ id: 'b' })] };

  it('passes language, mode, submit URL and recommendations through', () => {
    const d = buildConsoleData({ recommendations: rec, lang: 'en', mode: 'local', submitUrl: '/submit/abc', measure: null });
    assert.equal(d.lang, 'en');
    assert.equal(d.mode, 'local');
    assert.equal(d.submitUrl, '/submit/abc');
    assert.deepEqual(d.recommendations, rec.recommendations);
    assert.ok(Number.isFinite(Date.parse(d.generatedAt)));
  });

  it('takes the statistics from the measurement when there is one', () => {
    const measure = { totals: { sessions: 9, userMessages: 50 }, windowDays: 14 };
    const d = buildConsoleData({ recommendations: rec, lang: 'en', mode: 'local', submitUrl: null, measure });
    assert.deepEqual(d.stats, { sessions: 9, days: 14, prompts: 50, recommendations: 2 });
  });

  it('falls back to the numbers stored with the recommendations', () => {
    const d = buildConsoleData({ recommendations: rec, lang: 'en', mode: 'local', submitUrl: null, measure: null });
    assert.deepEqual(d.stats, { sessions: 3, days: 30, prompts: 0, recommendations: 2 });
    const bare = buildConsoleData({ recommendations: { recommendations: [] }, lang: 'en', mode: 'local', submitUrl: null, measure: null });
    assert.deepEqual(bare.stats, { sessions: 0, days: 0, prompts: 0, recommendations: 0 });
  });

  describe('i18n', () => {
    const en = buildConsoleData({ recommendations: rec, lang: 'en', mode: 'local', submitUrl: null, measure: null }).i18n;
    const ru = buildConsoleData({ recommendations: rec, lang: 'ru', mode: 'local', submitUrl: null, measure: null }).i18n;

    it('flattens the label groups: impact_high, risk_low, cat_hooks', () => {
      assert.equal(en.impact_high, loadLocale('en').console.impact.high);
      assert.equal(en.risk_high, loadLocale('en').console.risk.high);
      assert.equal(en.cat_hooks, loadLocale('en').console.categories.hooks);
      assert.equal(en['cat_claude-md'], loadLocale('en').console.categories['claude-md']);
    });

    it('keeps plain keys such as filter_all and title, and drops the group objects', () => {
      assert.equal(en.filter_all, loadLocale('en').console.filter_all);
      assert.equal(typeof en.title, 'string');
      assert.equal(en.impact, undefined);
      assert.equal(en.risk, undefined);
      assert.equal(en.categories, undefined);
    });

    it('contains only strings and exactly one entry per console label', () => {
      for (const data of [en, ru]) {
        assert.ok(Object.values(data).every((v) => typeof v === 'string'));
        assert.equal(Object.keys(data).length, flattenLeaves(loadLocale('en').console).length);
      }
    });

    it('is Russian when the language is ru', () => {
      assert.equal(ru.impact_high, loadLocale('ru').console.impact.high);
      assert.notEqual(ru.title, en.title);
      assert.ok(/[а-яё]/i.test(ru.submit));
      assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
    });
  });
});

describe('renderConsole', () => {
  const dataFor = (recommendations) => buildConsoleData({ recommendations: { sessions: 1, windowDays: 30, recommendations }, lang: 'en', mode: 'local', submitUrl: '/submit/0123456789abcdef', measure: null });

  it('replaces the data placeholder with the JSON of the data', () => {
    const data = dataFor([recommendation()]);
    const html = renderConsole(data);
    assert.ok(!html.includes('__KAIZEN_DATA__'));
    assert.deepEqual(extractData(html), JSON.parse(JSON.stringify(data)));
  });

  it('escapes "</script>" inside the data so the script block cannot be closed early', () => {
    const hostile = '</script><script>alert(1)</script>';
    const html = renderConsole(dataFor([recommendation({ title: hostile, evidence: `x${hostile}y` })]));
    const template = fs.readFileSync(PAGE, 'utf8');
    const closing = (text) => (text.match(/<\/script>/gi) || []).length;
    assert.equal(closing(html), closing(template));
    assert.ok(!html.includes(hostile));
    assert.equal(extractData(html).recommendations[0].title, hostile);
  });

  it('inserts text containing $-patterns literally ($&, $\', $`, $$, $1)', () => {
    const tricky = "price $& then $' and $` plus $$ and $1";
    const html = renderConsole(dataFor([recommendation({ title: tricky, evidence: tricky })]));
    const data = extractData(html);
    assert.equal(data.recommendations[0].title, tricky);
    assert.equal(data.recommendations[0].evidence, tricky);
  });

  it('keeps non-ASCII text (Russian titles) intact', () => {
    const html = renderConsole(dataFor([recommendation({ title: 'Убрать неиспользуемые MCP-серверы' })]));
    assert.equal(extractData(html).recommendations[0].title, 'Убрать неиспользуемые MCP-серверы');
  });
});

describe('console/index.html', () => {
  const html = fs.readFileSync(PAGE, 'utf8');

  it('has exactly one data placeholder', () => {
    assert.equal(html.split('/*__KAIZEN_DATA__*/null/*__END__*/').length - 1, 1);
  });

  it('has inline scripts that compile', () => {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const body of scripts) assert.doesNotThrow(() => new vm.Script(body));
  });

  it('loads nothing from the network: no external scripts, styles, images or imports', () => {
    assert.ok(!/<(script|link|img|iframe|source|video|audio)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html), 'external resource reference');
    assert.ok(!/@import|url\(\s*["']?(https?:)?\/\//i.test(html), 'external CSS import');
  });

  it('never persists a secret parameter to localStorage (the field object carries secret: true and save() leaves it out)', () => {
    // the field exposes the flag ...
    assert.match(html, /return \{ name: p\.name, secret: !!p\.secret, get, set,/);
    // ... read() drops flagged fields when asked to persist ...
    assert.match(html, /c\.fields\.filter\(\(f\) => !\(persist && f\.secret\)\)/);
    // ... and the only writer of the storage key asks for that
    const save = html.slice(html.indexOf('function save()'), html.indexOf('function restore()'));
    assert.match(save, /read\(c, true\)/);
    assert.doesNotMatch(save, /read\(c\)/);
    // everything that reaches setItem is built in save()
    assert.equal([...html.matchAll(/setItem\(/g)].length, 1);
  });

  it('keeps secret parameters in the submission whatever the position of their recipe', () => {
    // read(c, persist) must never be handed to map() directly: map passes the index as `persist`,
    // which dropped the token of every selected recipe after the first one
    assert.doesNotMatch(html, /\.map\(read\)/);
    const collect = html.slice(html.indexOf('selected: on.filter'), html.indexOf('selected: on.filter') + 120);
    assert.match(collect, /read\(c, false\)/);
    // behavioural check of the same logic: the second card keeps its secret field
    const read = (c, persist) => ({ id: c.id, params: Object.fromEntries(c.fields.filter((f) => !(persist && f.secret)).map((f) => [f.name, f.get()])) });
    const cards = [{ id: 'a', fields: [] }, { id: 'n', fields: [{ name: 'telegramBotToken', secret: true, get: () => 'T' }] }];
    assert.equal(cards.map((c) => read(c, false))[1].params.telegramBotToken, 'T');
  });

  it('only uses translation keys that the locales or its own fallback table define', () => {
    const used = [...new Set([...html.matchAll(/\bt\('([a-z_]+)'\)/g)].map((m) => m[1]))];
    assert.ok(used.length > 15, 'the page should use many translated labels');
    const fallbackTable = html.slice(html.indexOf('const EN = {'), html.indexOf('const RU = {'));
    const { i18n } = buildConsoleData({ recommendations: { recommendations: [] }, lang: 'en', mode: 'local', submitUrl: null, measure: null });
    const missing = used.filter((key) => !(key in i18n) && !new RegExp(`\\b${key}\\s*:`).test(fallbackTable));
    assert.deepEqual(missing, []);
  });
});

describe('validateChoices', () => {
  const valid = () => ({ selected: [{ id: 'hooks.guard-destructive', scope: 'user', params: { mode: 'ask' } }, { id: 'settings.cleanup-period' }], discuss: ['claude-md.diet'], notes: 'tests are `make check`', lang: 'ru', submittedAt: '2026-10-30T10:00:00.000Z' });

  it('accepts a valid payload and returns the normalized choices', () => {
    const out = validateChoices(valid());
    assert.equal(out.version, 1);
    assert.equal(out.lang, 'ru');
    assert.equal(out.submittedAt, '2026-10-30T10:00:00.000Z');
    assert.equal(out.selected.length, 2);
    assert.deepEqual(out.selected[0], { id: 'hooks.guard-destructive', scope: 'user', params: { mode: 'ask' } });
    assert.deepEqual(out.discuss, ['claude-md.diet']);
    assert.equal(out.notes, 'tests are `make check`');
  });

  it('fills in defaults: language en, a submission time, empty discuss and notes', () => {
    const out = validateChoices({ selected: [] });
    assert.equal(out.lang, 'en');
    assert.ok(Number.isFinite(Date.parse(out.submittedAt)));
    assert.deepEqual(out.discuss, []);
    assert.equal(out.notes, '');
  });

  it('accepts the two scopes apply understands and rejects the rest (local used to be let through and landed in the user files)', () => {
    for (const scope of ['user', 'project']) assert.doesNotThrow(() => validateChoices({ selected: [{ id: 'a.b', scope }] }));
    for (const scope of ['local', 'projekt', 'Project']) assert.throws(() => validateChoices({ selected: [{ id: 'a.b', scope }] }), /bad scope "[^"]*" for a\.b/, scope);
  });

  it('rejects anything that is not an object with a selected array', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { selected: 'a' }, { selected: {} }]) assert.throws(() => validateChoices(bad), /choices/, JSON.stringify(bad));
  });

  it('rejects recipe ids that are missing, not strings, or contain characters outside a-z 0-9 . -', () => {
    for (const id of [undefined, 42, '', 'Has Space', 'UPPER', 'semi;colon', '../etc', 'a/b', 'quote"']) {
      assert.throws(() => validateChoices({ selected: [{ id }] }), /bad recipe id/, String(id));
    }
    assert.throws(() => validateChoices({ selected: [null] }), /bad recipe id/);
  });

  it('rejects an unknown scope', () => {
    assert.throws(() => validateChoices({ selected: [{ id: 'a.b', scope: 'global' }] }), /bad scope "[^"]*" for a\.b/);
  });

  it('rejects params that are not an object', () => {
    assert.throws(() => validateChoices({ selected: [{ id: 'a.b', params: 'x' }] }), /params for a\.b must be an object/);
  });

  it('rejects notes that are not a string and truncates very long notes', () => {
    assert.throws(() => validateChoices({ selected: [], notes: 5 }), /notes must be a string/);
    assert.equal(validateChoices({ selected: [], notes: 'n'.repeat(25000) }).notes.length, 20000);
  });

  it('drops non-string entries from discuss', () => {
    assert.deepEqual(validateChoices({ selected: [], discuss: ['a', 1, null, 'b'] }).discuss, ['a', 'b']);
    assert.deepEqual(validateChoices({ selected: [], discuss: 'nope' }).discuss, []);
  });
});

// ---------------------------------------------------------------- the local server, through the CLI

function httpRequest(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { Connection: 'close' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('kaizen console (local server)', () => {
  let home;
  let child;
  let started;
  let exited;
  let stdout = '';
  let stderr = '';
  let page;

  before(async () => {
    home = materializeHome();
    writeJson(path.join(home.stateDir, 'recommendations.json'), {
      generatedAt: '2026-10-30T10:00:00.000Z',
      lang: 'en',
      windowDays: 30,
      sessions: 3,
      recommendations: [recommendation(), recommendation({ id: 'hooks.guard-destructive', category: 'hooks', impact: 'high', title: 'Guard against destructive commands' })],
      alreadyApplied: [],
      notApplicable: 0,
    });
    child = spawn(process.execPath, [CLI, 'console', '--no-open', '--port', '0', '--lang', 'en'], { env: childEnv(home.env), cwd: os.tmpdir(), windowsHide: true });
    exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`console did not start. stdout=${stdout} stderr=${stderr}`)), 20000);
      child.stdout.on('data', (d) => {
        stdout += d;
        const m = stdout.match(/\{"url":"[^\n]+\}/);
        if (m) {
          clearTimeout(timer);
          resolve(JSON.parse(m[0]));
        }
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`console exited early (${code}). stderr=${stderr}`));
      });
    });
    started.catch(() => {});
    const info = await started;
    page = await httpRequest(info.url);
  });

  after(async () => {
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited;
  });

  it('listens on 127.0.0.1 only and announces its URL and the choices file on stdout', async () => {
    const info = await started;
    assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(info.waiting, true);
    assert.equal(path.resolve(info.choicesFile), path.join(home.stateDir, 'choices.json'));
  });

  it('serves the page with the recommendations, uncached', () => {
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const data = extractData(page.body);
    assert.equal(data.mode, 'local');
    assert.equal(data.recommendations.length, 2);
    assert.equal(data.stats.recommendations, 2);
    assert.match(data.submitUrl, /^\/submit\/[0-9a-f]{16}$/);
  });

  it('answers 404 for any other path', async () => {
    const info = await started;
    const res = await httpRequest(new URL('/favicon.ico', info.url).href);
    assert.equal(res.status, 404);
  });

  it('answers 404 to a submission with the wrong token and writes nothing', async () => {
    const info = await started;
    const res = await httpRequest(new URL('/submit/0000000000000000', info.url).href, { method: 'POST', body: JSON.stringify({ selected: [] }) });
    assert.equal(res.status, 404);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('answers 400 to a submission that is not JSON, and keeps waiting', async () => {
    const info = await started;
    const { submitUrl } = extractData(page.body);
    const res = await httpRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).ok, false);
    assert.equal(child.exitCode, null);
  });

  it('answers 400 to a submission with an invalid recipe id, naming the problem', async () => {
    const info = await started;
    const { submitUrl } = extractData(page.body);
    const res = await httpRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: JSON.stringify({ selected: [{ id: 'Bad Id' }] }) });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /bad recipe id/);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('writes choices.json for a valid submission, reports it, and exits cleanly', async () => {
    const info = await started;
    const { submitUrl } = extractData(page.body);
    const payload = { selected: [{ id: 'settings.cleanup-period', scope: 'user', params: {} }], discuss: ['claude-md.diet'], notes: 'tests are `make check`', lang: 'en' };
    const res = await httpRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(res.status, 200);
    const reply = JSON.parse(res.body);
    assert.equal(reply.ok, true);
    assert.equal(path.resolve(reply.file), path.join(home.stateDir, 'choices.json'));
    const saved = readJson(path.join(home.stateDir, 'choices.json'));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.selected, payload.selected);
    assert.deepEqual(saved.discuss, ['claude-md.diet']);
    assert.equal(saved.notes, 'tests are `make check`');
    assert.equal(await exited, 0);
    const lines = stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(lines[lines.length - 1], { ok: true, file: reply.file, selected: 1, discuss: 1, notes: true });
  });
});

describe('kaizen console (other modes)', () => {
  it('fails with a helpful message when there are no recommendations yet', () => {
    const home = materializeHome();
    const r = runCli(['console', '--no-open'], { env: home.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No recommendations at .*recommendations\.json/);
    assert.match(r.stderr, /kaizen recommend/);
  });

  it('renders a static page with --mode render, in the requested language, without starting a server', () => {
    const home = materializeHome();
    writeJson(path.join(home.stateDir, 'recommendations.json'), { generatedAt: '2026-10-30T10:00:00.000Z', lang: 'en', windowDays: 30, sessions: 3, recommendations: [recommendation()], alreadyApplied: [], notApplicable: 0 });
    const out = path.join(home.root, 'out', 'console.html');
    const r = runCli(['console', '--mode', 'render', '--out', out, '--lang', 'ru'], { env: home.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(path.resolve(r.stdout.trim()), out);
    const data = extractData(fs.readFileSync(out, 'utf8'));
    assert.equal(data.lang, 'ru');
    assert.equal(data.mode, 'artifact');
    assert.equal(data.submitUrl, null);
    assert.equal(data.i18n.impact_high, loadLocale('ru').console.impact.high);
  });
});

// ---------------------------------------------------------------- DNS rebinding / cross-origin protection

function rawRequest(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { Connection: 'close', ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('kaizen console: Host and Origin checks', () => {
  let home;
  let child;
  let exited;
  let info;
  let submitUrl;
  let stdout = '';
  let stderr = '';

  before(async () => {
    home = materializeHome();
    writeJson(path.join(home.stateDir, 'recommendations.json'), { generatedAt: '2026-10-30T10:00:00.000Z', lang: 'en', windowDays: 30, sessions: 3, recommendations: [recommendation()], alreadyApplied: [], notApplicable: 0 });
    child = spawn(process.execPath, [CLI, 'console', '--no-open', '--port', '0', '--lang', 'en'], { env: childEnv(home.env), cwd: os.tmpdir(), windowsHide: true });
    exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`console did not start. stdout=${stdout} stderr=${stderr}`)), 20000);
      child.stdout.on('data', (d) => {
        stdout += d;
        const m = stdout.match(/\{"url":"[^\n]+\}/);
        if (m) {
          clearTimeout(timer);
          resolve(JSON.parse(m[0]));
        }
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`console exited early (${code}). stderr=${stderr}`));
      });
    });
    const page = await rawRequest(info.url);
    submitUrl = extractData(page.body).submitUrl;
  });

  after(async () => {
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited;
  });

  const port = () => new URL(info.url).port;
  const json = { 'Content-Type': 'application/json' };
  const choices = JSON.stringify({ selected: [{ id: 'settings.cleanup-period', scope: 'user', params: {} }] });

  it('refuses a request whose Host is not our loopback address (a rebound attacker domain), for the page and for a POST', async () => {
    const page = await rawRequest(info.url, { headers: { Host: `attacker.example:${port()}` } });
    assert.equal(page.status, 403);
    assert.ok(!page.body.includes('submitUrl'));
    const post = await rawRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: choices, headers: { ...json, Host: `attacker.example:${port()}` } });
    assert.equal(post.status, 403);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('refuses the right host name on the wrong port', async () => {
    const res = await rawRequest(info.url, { headers: { Host: '127.0.0.1:1' } });
    assert.equal(res.status, 403);
  });

  it('refuses a POST that carries a foreign Origin', async () => {
    const res = await rawRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: choices, headers: { ...json, Origin: 'https://attacker.example' } });
    assert.equal(res.status, 403);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('refuses a POST that is not application/json (a cross-site "simple" request)', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const headers = type ? { 'Content-Type': type } : {};
      const res = await rawRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: choices, headers });
      assert.equal(res.status, 415, String(type));
    }
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('serves localhost:<port> and accepts a same-origin POST', async () => {
    const page = await rawRequest(info.url, { headers: { Host: `localhost:${port()}` } });
    assert.equal(page.status, 200);
    const res = await rawRequest(new URL(submitUrl, info.url).href, { method: 'POST', body: choices, headers: { ...json, Origin: `http://127.0.0.1:${port()}` } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(await exited, 0);
  });
});

describe('isLoopbackHost / isLoopbackOrigin', () => {
  it('match only 127.0.0.1 and localhost with the server port', async () => {
    const { isLoopbackHost, isLoopbackOrigin } = await import('../scripts/lib/console.mjs');
    assert.equal(isLoopbackHost('127.0.0.1:5000', 5000), true);
    assert.equal(isLoopbackHost('LOCALHOST:5000', 5000), true);
    for (const bad of ['127.0.0.1', '127.0.0.1:5001', 'evil.example:5000', 'localhost.evil.example:5000', undefined, '']) assert.equal(isLoopbackHost(bad, 5000), false, String(bad));
    assert.equal(isLoopbackHost('127.0.0.1:0', 0), false);
    assert.equal(isLoopbackOrigin('http://127.0.0.1:5000', 5000), true);
    assert.equal(isLoopbackOrigin('http://localhost:5000', 5000), true);
    for (const bad of ['https://127.0.0.1:5000', 'http://127.0.0.1:5001', 'null', 'http://evil.example:5000', undefined]) assert.equal(isLoopbackOrigin(bad, 5000), false, String(bad));
  });
});

describe('kaizen console (mode B): an old choices.json is never taken for this run', () => {
  const old = { version: 1, submittedAt: '2026-10-24T10:00:00.000Z', lang: 'en', selected: [{ id: 'settings.cleanup-period', scope: 'user', params: {} }], discuss: [], notes: 'last week' };
  const setup = () => {
    const home = materializeHome();
    writeJson(path.join(home.stateDir, 'recommendations.json'), { generatedAt: '2026-10-30T10:00:00.000Z', lang: 'en', windowDays: 30, sessions: 3, recommendations: [recommendation()], alreadyApplied: [], notApplicable: 0 });
    writeJson(path.join(home.stateDir, 'choices.json'), old);
    return home;
  };

  it('on timeout it exits 3, prints {"ok":false,"timedOut":true}, and leaves no choices.json for `apply` to pick up', () => {
    const home = setup();
    const r = runCli(['console', '--no-open', '--timeout', '0.02'], { env: home.env });
    assert.equal(r.status, 3, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(lines[lines.length - 1], { ok: false, timedOut: true });
    assert.ok(!lines.some((l) => l.ok === true), 'no submission line');
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')), 'the stale selection is gone');
    assert.deepEqual(readJson(path.join(home.stateDir, 'choices.previous.json')), old, 'and kept under another name');
  });

  it('`apply` after that timeout has nothing to apply instead of last week\'s selection', () => {
    const home = setup();
    const m = runCli(['measure', '--all', '--quiet'], { env: { ...home.env, CLAUDE_CONFIG_DIR: home.configDir } });
    assert.equal(m.status, 0, m.stderr);
    assert.equal(runCli(['console', '--no-open', '--timeout', '0.02'], { env: home.env }).status, 3);
    const dry = runCli(['apply', '--dry-run'], { env: home.env });
    assert.notEqual(dry.status, 0);
    assert.ok(!/would be applied/.test(dry.stdout), dry.stdout);
    assert.match(dry.stderr, /choices\.json/);
  });

  it('a console started without an old file works as before and writes no choices.previous.json', () => {
    const home = materializeHome();
    writeJson(path.join(home.stateDir, 'recommendations.json'), { generatedAt: '2026-10-30T10:00:00.000Z', lang: 'en', windowDays: 30, sessions: 3, recommendations: [recommendation()], alreadyApplied: [], notApplicable: 0 });
    const r = runCli(['console', '--no-open', '--timeout', '0.02'], { env: home.env });
    assert.equal(r.status, 3);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.previous.json')));
  });
});
