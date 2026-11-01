// scripts/kaizen.mjs through the real command line (child processes), against a throw-away home built from the fixtures.
// Every child gets a hermetic environment (see helpers.childEnv): its own CLAUDE_CONFIG_DIR, HOME, USERPROFILE and
// KAIZEN_STATE_DIR (or the default <config dir>/kaizen), and a PATH that holds only the Node binary's directory.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../scripts/kaizen.mjs';
import { interpolate, loadLocale } from '../scripts/lib/i18n.mjs';
import { KIT_ROOT, childEnv, cleanupTempDirs, copyTree, makeTempDir, materializeHome, prefixOf, readJson, runCli, snapshotDir, t, tRu, writeJson, writeText } from './helpers.mjs';

const pkg = readJson(path.join(KIT_ROOT, 'package.json'));

after(() => cleanupTempDirs());

const cli = (home, args, opts = {}) => runCli(args, { env: home.env, ...opts });
const json = (r) => {
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const measured = (opts = {}) => {
  const home = materializeHome({ projects: true, usageData: true, ...opts });
  const r = cli(home, ['measure', '--all', '--quiet']);
  assert.equal(r.status, 0, r.stderr);
  return home;
};

describe('parseArgs', () => {
  it('splits positional arguments from flags', () => {
    assert.deepEqual(parseArgs(['apply', 'choices.json', '--dry-run']), { _: ['apply', 'choices.json'], flags: { 'dry-run': true } });
  });

  it('gives a flag the next argument as its value unless that is another flag', () => {
    assert.deepEqual(parseArgs(['measure', '--days', '7', '--quiet', '--lang', 'ru']).flags, { days: '7', quiet: true, lang: 'ru' });
  });

  it('understands --key=value, including values that contain "="', () => {
    assert.deepEqual(parseArgs(['--lang=ru', '--param=a.b=c']).flags, { lang: 'ru', param: 'a.b=c' });
  });

  it('accepts a negative number as a value', () => {
    assert.equal(parseArgs(['--days', '-5']).flags.days, '-5');
  });

  it('treats a trailing flag as true', () => {
    assert.deepEqual(parseArgs(['recommend', '--json']).flags, { json: true });
  });

  it('collects a repeated --param so that several parameters can be given', () => {
    const { flags } = parseArgs(['apply', '--recipe', 'skills.from-repeated-prompts', '--param', 'skills.from-repeated-prompts.name=deploy', '--param', 'skills.from-repeated-prompts.content=Do it']);
    assert.deepEqual(flags.param, ['skills.from-repeated-prompts.name=deploy', 'skills.from-repeated-prompts.content=Do it']);
  });

  it('keeps a single --param as a plain string', () => {
    assert.equal(parseArgs(['--param', 'a.b=c']).flags.param, 'a.b=c');
  });

  it('returns empty collections for no arguments', () => {
    assert.deepEqual(parseArgs([]), { _: [], flags: {} });
  });
});

describe('kaizen: basics', () => {
  it('--version prints the package version', () => {
    const r = runCli(['--version']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  it('the version command prints it too', () => {
    assert.equal(runCli(['version']).stdout.trim(), pkg.version);
  });

  it('help lists every command and the state-directory override', () => {
    const r = runCli(['help'], { env: { KAIZEN_STATE_DIR: path.join(makeTempDir(), 'state') } });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith(`claude-kaizen ${pkg.version}`));
    for (const command of ['measure', 'recommend', 'console', 'apply', 'undo', 'status', 'verify', 'doctor', 'selfcheck', 'docs', 'nudge']) assert.match(r.stdout, new RegExp(`^  ${command}\\s`, 'm'), command);
    assert.match(r.stdout, /KAIZEN_STATE_DIR/);
  });

  it('prints help when called without a command', () => {
    assert.match(runCli([]).stdout, /Usage: node scripts\/kaizen\.mjs <command>/);
  });

  it('exits with code 2 and a message for an unknown command', () => {
    const r = runCli(['frobnicate']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), t('cli.unknown_command', { cmd: 'frobnicate' }));
    assert.equal(r.stdout, '');
  });

  it('selfcheck passes (or fails only because a template is missing)', () => {
    const r = runCli(['selfcheck']);
    if (r.status === 0) {
      assert.match(r.stdout, /selfcheck: ok/);
    } else {
      const problems = r.stderr.split(/\r?\n/).filter((l) => l.startsWith('✗'));
      assert.ok(problems.length > 0 && problems.every((p) => /template missing/.test(p)), r.stderr);
    }
  });

  it('doctor reports versions, paths and counts but no transcript content', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const run = cli(home, ['doctor']);
    assert.equal(run.stderr, '', 'doctor must not print warnings (for example a Node deprecation notice from the claude --version probe)');
    const d = json(run);
    assert.equal(d.kitVersion, pkg.version);
    assert.equal(path.resolve(d.kitRoot), KIT_ROOT);
    assert.equal(path.resolve(d.configDir), home.configDir);
    assert.equal(d.configDirExists, true);
    assert.equal(path.resolve(d.stateDir), home.stateDir);
    assert.deepEqual(d.transcripts, { projects: 2, files: 3, mb: 0 });
    assert.equal(d.insightsData, true);
    assert.equal(d.settingsJson, true);
    assert.ok(Array.isArray(d.catalogProblems));
    assert.equal(d.platform.platform, process.platform);
    assert.ok(!JSON.stringify(d).includes('Deploy the service'));
  });

  it('doctor copes with a home that has no Claude data at all', () => {
    const root = makeTempDir('kaizen-empty-');
    const d = json(runCli(['doctor'], { env: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), KAIZEN_STATE_DIR: path.join(root, 'state') } }));
    assert.equal(d.configDirExists, false);
    assert.deepEqual(d.transcripts, { projects: 0, files: 0, mb: 0 });
    assert.equal(d.insightsData, false);
    assert.equal(d.settingsJson, false);
  });

  it('status before any measurement shows empty state', () => {
    const home = materializeHome();
    const s = json(cli(home, ['status']));
    assert.equal(s.kitVersion, pkg.version);
    assert.equal(path.resolve(s.stateDir), home.stateDir);
    assert.equal(s.lastMeasure, null);
    assert.equal(s.recommendations, null);
    assert.deepEqual(s.applied, []);
    assert.deepEqual(s.config, {});
  });
});

describe('kaizen measure', () => {
  it('writes measure.json, measure.md, last-measure.json and the per-transcript cache', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const r = cli(home, ['measure', '--all', '--quiet', '--lang', 'en']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    for (const f of ['measure.json', 'measure.md', 'last-measure.json']) assert.ok(fs.existsSync(path.join(home.stateDir, f)), f);
    assert.equal(fs.readdirSync(path.join(home.stateDir, 'cache', 'sessions')).length, 3);
    const m = readJson(path.join(home.stateDir, 'measure.json'));
    assert.equal(m.totals.sessions, 3);
    assert.equal(m.totals.projects, 2);
    assert.equal(m.env.kitVersion, pkg.version);
    assert.equal(m.env.scanned, 3);
    assert.equal(m.env.cached, 0);
    assert.equal(m.locale.lang, 'en');
    assert.equal(m.windowDays, 3650);
    const last = readJson(path.join(home.stateDir, 'last-measure.json'));
    assert.equal(last.sessions, 3);
    assert.equal(last.kitVersion, pkg.version);
    assert.equal(last.at, m.generatedAt);
  });

  it('writes a digest that starts with the title and states the window', () => {
    const home = measured();
    const md = fs.readFileSync(path.join(home.stateDir, 'measure.md'), 'utf8');
    assert.equal(md.split('\n')[0], `# ${loadLocale('en').digest.title}`);
    assert.ok(md.includes('3 sessions across 2 projects, 16 human prompts'));
    assert.ok(md.includes('claude-sonnet-4-6 54%'), 'model mix comes from the CLI, not buildMeasure');
  });

  it('adds the model mix (sorted by messages) to measure.json', () => {
    const m = readJson(path.join(measured().stateDir, 'measure.json'));
    assert.deepEqual(Object.keys(m.models), ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5']);
    assert.equal(m.models['claude-sonnet-4-6'].messages, 25);
    assert.ok(Math.abs(m.models['claude-sonnet-4-6'].share - 25 / 46) < 1e-9);
  });

  it('prints the digest to stdout and progress to stderr when not quiet', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const r = cli(home, ['measure', '--all', '--lang', 'en']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('# Kaizen measurement'));
    assert.ok(r.stderr.includes(prefixOf('cli.measuring', { days: 3650 })), r.stderr);
    assert.ok(r.stderr.includes(prefixOf('cli.scanned', { files: 3, mb: 0, cached: 0 })), r.stderr);
    assert.ok(r.stderr.includes(prefixOf('cli.written')) && /measure\.json/.test(r.stderr), r.stderr);
  });

  it('prints the measurement as JSON with --json', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const m = json(cli(home, ['measure', '--all', '--quiet', '--json']));
    assert.equal(m.totals.sessions, 3);
    assert.equal(m.generatedAt, readJson(path.join(home.stateDir, 'measure.json')).generatedAt);
  });

  it('reads everything from the cache on the second run and keeps the previous measurement', () => {
    const home = measured();
    const first = readJson(path.join(home.stateDir, 'measure.json'));
    const r = cli(home, ['measure', '--all', '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    const second = readJson(path.join(home.stateDir, 'measure.json'));
    assert.equal(second.env.cached, 3);
    assert.equal(second.totals.sessions, first.totals.sessions);
    assert.deepEqual(readJson(path.join(home.stateDir, 'measure.previous.json')).generatedAt, first.generatedAt);
    assert.ok(fs.existsSync(path.join(home.stateDir, 'measure.previous.md')));
  });

  it('shows what moved since the previous measurement in the second digest', () => {
    const home = measured();
    cli(home, ['measure', '--all', '--quiet']);
    const md = fs.readFileSync(path.join(home.stateDir, 'measure.md'), 'utf8');
    assert.ok(md.includes(`## ${loadLocale('en').digest.delta}`));
  });

  it('--no-cache scans the transcripts again', () => {
    const home = measured();
    cli(home, ['measure', '--all', '--quiet', '--no-cache']);
    assert.equal(readJson(path.join(home.stateDir, 'measure.json')).env.cached, 0);
  });

  it('writes the digest in Russian with --lang ru', () => {
    const home = materializeHome({ projects: true, usageData: true });
    cli(home, ['measure', '--all', '--quiet', '--lang', 'ru']);
    const md = fs.readFileSync(path.join(home.stateDir, 'measure.md'), 'utf8');
    assert.equal(md.split('\n')[0], `# ${loadLocale('ru').digest.title}`);
  });

  it('reports a missing transcripts directory and still writes an empty measurement', () => {
    const home = materializeHome();
    const r = cli(home, ['measure', '--all', '--lang', 'en']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(prefixOf('cli.no_data')), r.stderr);
    const m = readJson(path.join(home.stateDir, 'measure.json'));
    assert.equal(m.totals.sessions, 0);
    assert.equal(m.env.scanned, 0);
  });

  it('includes the project settings when --project points at a project', () => {
    const home = materializeHome({ projects: true });
    const project = makeTempDir('kaizen-proj-');
    writeJson(path.join(project, '.claude', 'settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }] } });
    cli(home, ['measure', '--all', '--quiet', '--project', project]);
    const m = readJson(path.join(home.stateDir, 'measure.json'));
    assert.equal(path.resolve(m.env.projectDir), path.resolve(project));
    assert.equal(m.context.hasSessionStartHook, true);
    assert.ok(m.inventory.hooks.some((h) => h.scope === 'project' && h.event === 'SessionStart'));
  });

  it('falls back to CLAUDE_PROJECT_DIR when --project is not given', () => {
    const home = materializeHome({ projects: true });
    const project = makeTempDir('kaizen-proj-');
    writeJson(path.join(project, '.claude', 'settings.json'), { permissions: { deny: ['Read(./.env)'] } });
    runCli(['measure', '--all', '--quiet'], { env: { ...home.env, CLAUDE_PROJECT_DIR: project } });
    const m = readJson(path.join(home.stateDir, 'measure.json'));
    assert.equal(m.context.hasDenyRules, true);
  });

  it('keeps the transcripts and their secrets out of both output files', () => {
    const home = measured();
    for (const f of ['measure.json', 'measure.md']) {
      const text = fs.readFileSync(path.join(home.stateDir, f), 'utf8');
      for (const leaked of ['swordfish123', 'FAKE-TOKEN-1234', 'FAKE-HOOK-SECRET-1', 'FAKE-DEPLOY-TOKEN', 'hunter2hunter2', 'synthetic-not-a-real-key', 'Write a python script that converts']) {
        assert.ok(!text.toLowerCase().includes(leaked.toLowerCase()), `${f} contains ${leaked}`);
      }
    }
  });
});

describe('kaizen: language selection', () => {
  const titleOf = (home) => fs.readFileSync(path.join(home.stateDir, 'measure.md'), 'utf8').split('\n')[0];

  it('uses the language from config.json when no --lang flag is given', () => {
    const home = materializeHome({ projects: true, usageData: true });
    writeJson(path.join(home.stateDir, 'config.json'), { lang: 'ru' });
    cli(home, ['measure', '--all', '--quiet']);
    assert.equal(titleOf(home), `# ${loadLocale('ru').digest.title}`);
    assert.deepEqual(json(cli(home, ['status'])).config, { lang: 'ru' });
  });

  it('lets --lang override config.json', () => {
    const home = materializeHome({ projects: true, usageData: true });
    writeJson(path.join(home.stateDir, 'config.json'), { lang: 'ru' });
    cli(home, ['measure', '--all', '--quiet', '--lang', 'en']);
    assert.equal(titleOf(home), `# ${loadLocale('en').digest.title}`);
  });

  it('ignores an unsupported --lang and falls back to config.json', () => {
    const home = materializeHome({ projects: true, usageData: true });
    writeJson(path.join(home.stateDir, 'config.json'), { lang: 'ru' });
    cli(home, ['measure', '--all', '--quiet', '--lang', 'de']);
    assert.equal(titleOf(home), `# ${loadLocale('ru').digest.title}`);
  });

  it('falls back to the language detected in the prompts, which is English for the fixtures', () => {
    const home = materializeHome({ projects: true, usageData: true });
    cli(home, ['measure', '--all', '--quiet']);
    assert.equal(titleOf(home), `# ${loadLocale('en').digest.title}`);
    assert.equal(readJson(path.join(home.stateDir, 'measure.json')).locale.lang, 'en');
  });

  it('survives a config.json that is not valid JSON', () => {
    const home = materializeHome({ projects: true, usageData: true });
    writeText(path.join(home.stateDir, 'config.json'), '{ nope');
    const r = cli(home, ['measure', '--all', '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(json(cli(home, ['status'])).config, {});
  });
});

describe('kaizen recommend', () => {
  it('prints the recommendations as JSON and stores the same payload in recommendations.json', () => {
    const home = measured();
    const payload = json(cli(home, ['recommend', '--json']));
    assert.equal(payload.lang, 'en');
    assert.equal(payload.sessions, 3);
    assert.equal(payload.windowDays, 3650);
    assert.deepEqual(payload.alreadyApplied, []);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
    const ids = payload.recommendations.map((r) => r.id);
    for (const id of ['hooks.guard-destructive', 'permissions.deny-secrets', 'context.mcp-unused']) assert.ok(ids.includes(id), id);
    assert.deepEqual(readJson(path.join(home.stateDir, 'recommendations.json')), payload);
  });

  it('gives each recommendation the fields the console and apply rely on', () => {
    const home = measured();
    const mcp = json(cli(home, ['recommend', '--json'])).recommendations.find((r) => r.id === 'context.mcp-unused');
    for (const key of ['id', 'category', 'impact', 'effort', 'risk', 'scope', 'scopes', 'title', 'why', 'evidence', 'matched', 'score', 'params', 'actionsSummary', 'kind', 'source', 'conflicts']) assert.ok(key in mcp, key);
    assert.deepEqual(mcp.params[0].value, ['dead-srv']);
    assert.match(mcp.evidence, /1 of 2 configured servers/);
  });

  it('prints a readable list without --json', () => {
    const home = measured();
    const r = cli(home, ['recommend']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\d+ recommendations \(\d+ high impact\):/);
    assert.match(r.stdout, /^\[H\] hooks\.guard-destructive — /m);
    assert.match(r.stdout, /^ {4}→ /m);
  });

  it('--top limits the list', () => {
    const home = measured();
    assert.equal(json(cli(home, ['recommend', '--json', '--top', '2'])).recommendations.length, 2);
  });

  it('--all also lists recipes whose conditions are not met, flagged matched:false', () => {
    const home = measured();
    const all = json(cli(home, ['recommend', '--json', '--all'])).recommendations;
    assert.ok(all.some((r) => r.matched === false));
    assert.ok(all.length > json(cli(home, ['recommend', '--json'])).recommendations.length);
  });

  it('--lang ru produces Russian titles', () => {
    const home = measured();
    const rec = json(cli(home, ['recommend', '--json', '--lang', 'ru'])).recommendations.find((r) => r.id === 'permissions.deny-secrets');
    assert.ok(/[а-яё]/i.test(rec.title));
  });

  it('fails clearly when there is no measurement yet', () => {
    const home = materializeHome();
    const r = cli(home, ['recommend']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No measurement found at .*measure\.json\. Run `kaizen measure` first\./);
  });

  it('--add merges extra recipes, parameter defaults and a profile', () => {
    const home = measured();
    const extra = path.join(home.root, 'extra.json');
    writeJson(extra, {
      recipes: [{ id: 'extra.always', category: 'advice', impact: 'high', risk: 'low', title: { en: 'Extra', ru: 'Дополнительно' }, why: { en: 'w', ru: 'п' }, evidence: { en: 'e', ru: 'д' }, when: true }],
      paramDefaults: { 'hooks.guard-destructive': { mode: 'ask' } },
      profile: 'Prefers terse answers.',
    });
    const payload = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(payload.recommendations.some((r) => r.id === 'extra.always'));
    const guard = payload.recommendations.find((r) => r.id === 'hooks.guard-destructive');
    assert.equal(guard.params.find((p) => p.name === 'mode').value, 'ask');
    assert.equal(readJson(path.join(home.stateDir, 'profile.json')).profile, 'Prefers terse answers.');
  });

  it('--add warns about paramDefaults for recipes that are not recommended', () => {
    const home = measured();
    const extra = path.join(home.root, 'extra.json');
    writeJson(extra, { recipes: [], paramDefaults: { 'no.such-recipe': { x: 1 } } });
    const r = cli(home, ['recommend', '--json', '--lang', 'en', '--add', extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /paramDefaults ignored .*no\.such-recipe/);
    JSON.parse(r.stdout);
  });

  it('--add with an unreadable file is an error', () => {
    const home = measured();
    const r = cli(home, ['recommend', '--add', path.join(home.root, 'missing.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--add: cannot read/);
  });
});

describe('kaizen apply (dry run) and undo on a measured home', () => {
  it('apply --recipe settings.cleanup-period --dry-run prints the plan and writes nothing', () => {
    const home = measured();
    json(cli(home, ['recommend', '--json']));
    const before = snapshotDir(home.root);
    const r = cli(home, ['apply', '--recipe', 'settings.cleanup-period', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /→ .*settings\.json: set cleanupPeriodDays = 90/);
    assert.ok(r.stdout.includes(t('cli.apply_dry', { n: 1 })), r.stdout);
    assert.deepEqual(snapshotDir(home.root), before);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'applied')));
  });

  it('apply without a measurement fails clearly', () => {
    const home = materializeHome();
    const r = cli(home, ['apply', '--recipe', 'settings.cleanup-period']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No measurement found/);
  });

  it('apply without --recipe and without choices fails clearly', () => {
    const home = measured();
    const r = cli(home, ['apply']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No choices file at .*choices\.json\. Run `kaizen console` or pass --recipe/);
  });

  it('undo with nothing applied says so', () => {
    const home = materializeHome();
    const r = cli(home, ['undo']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(t('cli.undo_nothing')), r.stdout);
  });

  it('applies several --param values to one recipe (a repeated flag)', () => {
    const home = measured();
    const r = cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'hooks.guard-destructive.mode=ask', '--param', 'hooks.guard-destructive.protectedBranches=main,release']);
    assert.equal(r.status, 0, r.stderr);
    const script = fs.readFileSync(path.join(home.stateDir, 'hooks', 'guard-destructive.mjs'), 'utf8');
    assert.ok(script.includes("const MODE_RAW = 'ask';"));
    assert.ok(script.includes("const BRANCHES_RAW = 'main,release';"));
  });
});

describe('kaizen end to end: measure, recommend, apply, verify, undo', () => {
  it('walks the whole cycle on the default state directory and restores the configuration', () => {
    const home = materializeHome({ projects: true, usageData: true, defaultState: true });
    const settingsBefore = readJson(home.settingsFile);
    const claudeMdBefore = fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8');

    assert.equal(cli(home, ['measure', '--all', '--quiet']).status, 0);
    assert.ok(fs.existsSync(path.join(home.configDir, 'kaizen', 'last-measure.json')), 'the default state directory is <config dir>/kaizen');

    const rec = json(cli(home, ['recommend', '--json']));
    assert.ok(rec.recommendations.some((r) => r.id === 'hooks.guard-destructive'));

    const applied = cli(home, ['apply', '--recipe', 'permissions.deny-secrets,hooks.guard-destructive,claude-md.read-before-edit']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.ok(applied.stdout.includes(prefixOf('cli.apply_done', { n: 3 })) && /manifest\.json/.test(applied.stdout), applied.stdout);
    const settings = readJson(home.settingsFile);
    assert.ok(settings.permissions.deny.includes('Read(./.env)'));
    assert.ok(settings.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.includes('guard-destructive.mjs'))));
    const script = path.join(home.configDir, 'kaizen', 'hooks', 'guard-destructive.mjs');
    assert.ok(fs.existsSync(script));
    assert.ok(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8').includes('<!-- kaizen:start read-before-edit -->'));

    const verify = json(cli(home, ['verify', '--json']));
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
    assert.ok(verify.checks.some((c) => c.ok && /guard-destructive\.mjs: self-test ok/.test(c.text)), JSON.stringify(verify.checks));
    assert.ok(verify.checks.some((c) => c.ok && /1 Kaizen block\(s\), markers balanced/.test(c.text)), JSON.stringify(verify.checks));

    const again = json(cli(home, ['recommend', '--json']));
    assert.deepEqual(
      again.alreadyApplied.slice().sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'claude-md.read-before-edit', matched: false }, // applied by choice although the data did not call for it
        { id: 'hooks.guard-destructive', matched: true },
        { id: 'permissions.deny-secrets', matched: true },
      ],
    );
    assert.ok(!again.recommendations.some((r) => ['hooks.guard-destructive', 'permissions.deny-secrets'].includes(r.id)));

    const status = json(cli(home, ['status']));
    assert.equal(status.applied.length, 1);
    assert.deepEqual(status.applied[0].recipes, ['permissions.deny-secrets', 'hooks.guard-destructive', 'claude-md.read-before-edit']);
    assert.equal(status.applied[0].undone, false);

    const undone = cli(home, ['undo']);
    assert.equal(undone.status, 0, undone.stderr);
    assert.ok(undone.stdout.includes(prefixOf('cli.undo_done', { n: 4 })), undone.stdout);
    assert.deepEqual(readJson(home.settingsFile), settingsBefore);
    assert.equal(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8'), claudeMdBefore);
    assert.ok(!fs.existsSync(script));
    assert.equal(json(cli(home, ['status'])).applied[0].undone, true);
    assert.ok(cli(home, ['undo']).stdout.includes(t('cli.undo_nothing')));
  });

  it('undo keeps what was edited after apply: the batch shows as partiallyUndone, and undo --force finishes it', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive']).status, 0);
    const script = path.join(home.stateDir, 'hooks', 'guard-destructive.mjs');
    fs.appendFileSync(script, '\n// tuned by hand\n');
    const first = cli(home, ['undo']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /kept: .*modified since apply/);
    assert.match(first.stdout, /only partly undone/);
    assert.ok(fs.existsSync(script));
    const partial = json(cli(home, ['status'])).applied[0];
    assert.equal(partial.undone, false);
    assert.equal(partial.partiallyUndone, true);
    const forced = cli(home, ['undo', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(!fs.existsSync(script));
    const done = json(cli(home, ['status'])).applied[0];
    assert.equal(done.undone, true);
    assert.equal(done.partiallyUndone, undefined);
  });

  it('undoing precompact-handoff leaves the session-context script and hook that another batch still uses', () => {
    const home = measured();
    const script = path.join(home.stateDir, 'hooks', 'session-context.mjs');
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.session-context', '--param', 'hooks.session-context.includeGit=false']).status, 0);
    const mine = fs.readFileSync(script, 'utf8');
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.precompact-handoff']).status, 0);
    assert.equal(fs.readFileSync(script, 'utf8'), mine, 'the second recipe must not reset the first one\'s parameters');
    const undone = cli(home, ['undo']);
    assert.equal(undone.status, 0, undone.stderr);
    assert.equal(fs.readFileSync(script, 'utf8'), mine);
    assert.ok(!undone.stdout.includes('--force'), undone.stdout);
    const verified = cli(home, ['verify']);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(cli(home, ['undo']).status, 0);
    assert.ok(!fs.existsSync(script));
  });

  it('undo --all --dry-run previews exactly what undo --all does with a script two recipes share', () => {
    const home = measured();
    const script = path.join(home.stateDir, 'hooks', 'session-context.mjs');
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.precompact-handoff']).status, 0);
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.session-context', '--param', 'hooks.session-context.includeGit=false']).status, 0);
    const before = snapshotDir(home.root);
    const dry = cli(home, ['undo', '--all', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(snapshotDir(home.root), before, 'a dry run changes nothing');
    assert.ok(!/modified since apply|--force/.test(dry.stdout), dry.stdout);
    const real = cli(home, ['undo', '--all']);
    assert.equal(real.status, 0, real.stderr);
    assert.ok(!/modified since apply|--force/.test(real.stdout), real.stdout);
    const plan = (out) => out.split('\n').filter((l) => /^ {2}[→✓] /.test(l)).map((l) => l.replace(/^ {2}[→✓] /, ''));
    assert.deepEqual(plan(dry.stdout), plan(real.stdout));
    assert.ok(plan(real.stdout).length >= 4);
    assert.ok(!fs.existsSync(script), 'nothing is left behind');
  });

  it('apply --dry-run with two recipes that share a script prints the plan the real run carries out', () => {
    const home = measured();
    const recipes = 'hooks.session-context,hooks.precompact-handoff,claude-md.read-before-edit,claude-md.autonomy';
    const before = snapshotDir(home.root);
    const dry = cli(home, ['apply', '--recipe', recipes, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(snapshotDir(home.root), before, 'a dry run changes nothing');
    const real = cli(home, ['apply', '--recipe', recipes]);
    assert.equal(real.status, 0, real.stderr);
    const plan = (out) => out.split('\n').filter((l) => /^ {2}[→✓·] /.test(l)).map((l) => l.replace(/^ {2}[→✓] /, '  ~ '));
    assert.deepEqual(plan(dry.stdout), plan(real.stdout));
    assert.match(dry.stdout, /session-context\.mjs: shared with hooks\.session-context, kept as it is/);
    assert.equal((dry.stdout.match(/add SessionStart hook/g) || []).length, 1, dry.stdout);
  });

  it('format-on-edit applied to two projects installs one script per project; verify self-tests both and undo --all removes both', () => {
    const home = measured();
    const projA = path.join(home.root, 'projA');
    const projB = path.join(home.root, 'projB');
    fs.mkdirSync(projA);
    fs.mkdirSync(projB);
    const apply = (proj, formatter) => cli(home, ['apply', '--recipe', 'hooks.format-on-edit', '--scope', 'project', '--project', proj, '--param', `hooks.format-on-edit.formatter=${formatter}`]);
    assert.equal(apply(projA, 'ruff').status, 0);
    assert.equal(apply(projB, 'prettier').status, 0);
    const scripts = fs.readdirSync(path.join(home.stateDir, 'hooks')).sort();
    assert.equal(scripts.length, 2, scripts.join(', '));
    for (const s of scripts) assert.match(s, /^format-on-edit\.[0-9a-f]{10}\.mjs$/);
    const texts = scripts.map((s) => fs.readFileSync(path.join(home.stateDir, 'hooks', s), 'utf8'));
    assert.ok(texts.some((x) => x.includes("const FORMATTER_RAW = 'ruff';")) && texts.some((x) => x.includes("const FORMATTER_RAW = 'prettier';")), 'each project keeps its own formatter');
    const verify = json(cli(home, ['verify', '--json', '--project', projA]));
    assert.equal(verify.ok, true, JSON.stringify(verify.checks));
    for (const s of scripts) assert.ok(verify.checks.some((c) => c.ok && c.text.includes(s) && /self-test ok/.test(c.text)), `${s}: ${JSON.stringify(verify.checks)}`);
    assert.equal(cli(home, ['undo', '--all']).status, 0);
    assert.deepEqual(fs.readdirSync(path.join(home.stateDir, 'hooks')), []);
  });

  it('skills.prune-unused: a plugin on in the user settings but off in the project is switched off in the user settings too, and undo gives it back', () => {
    const home = measured();
    const proj = path.join(home.root, 'projPlugin');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'x@m': false } }));
    const userFile = path.join(home.configDir, 'settings.json');
    const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    user.enabledPlugins = { ...(user.enabledPlugins || {}), 'x@m': true };
    fs.writeFileSync(userFile, JSON.stringify(user));
    const before = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    const args = ['apply', '--recipe', 'skills.prune-unused', '--project', proj, '--param', 'skills.prune-unused.plugins=x@m'];
    const r = cli(home, args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`${userFile}: disable plugins x@m`), r.stdout);
    assert.equal(JSON.parse(fs.readFileSync(userFile, 'utf8')).enabledPlugins['x@m'], false);
    assert.ok(!fs.existsSync(path.join(proj, '.claude', 'settings.local.json')));
    assert.equal(cli(home, ['undo']).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(userFile, 'utf8')), before);
  });

  it('apply --recipe for a defaultScope-project recipe that was never recommended plans the project settings, not the user ones', () => {
    const home = measured();
    const proj = path.join(home.root, 'projScope');
    fs.mkdirSync(proj);
    const before = snapshotDir(home.root);
    const r = cli(home, ['apply', '--recipe', 'hooks.verify-before-stop', '--project', proj, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(path.join(proj, '.claude', 'settings.json')), r.stdout);
    assert.ok(!r.stdout.includes(path.join(home.configDir, 'settings.json')), r.stdout);
    assert.ok(new RegExp(`verify-before-stop\\.${'[0-9a-f]'.repeat(10)}\\.mjs`).test(r.stdout), r.stdout);
    assert.deepEqual(snapshotDir(home.root), before, 'a dry run writes nothing');
  });
});

describe('kaizen verify', () => {
  it('has nothing to check on an empty home', () => {
    const root = makeTempDir('kaizen-empty-');
    const env = { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), KAIZEN_STATE_DIR: path.join(root, 'state') };
    const r = runCli(['verify'], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(t('verify.header')), r.stdout);
    assert.ok(r.stdout.includes(t('verify.nothing')), r.stdout);
  });

  it('checks that settings.json parses', () => {
    const home = materializeHome({ defaultState: true });
    const r = cli(home, ['verify', '--json']);
    const v = json(r);
    assert.equal(v.ok, true);
    assert.ok(v.checks.some((c) => /settings\.json: valid JSON \(0 Kaizen hook\(s\)\)/.test(c.text)));
  });

  it('fails on a settings.json that does not parse', () => {
    const home = materializeHome({ defaultState: true });
    writeText(home.settingsFile, '{ broken');
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1);
    const v = JSON.parse(r.stdout);
    assert.equal(v.ok, false);
    assert.ok(v.checks.some((c) => !c.ok && /INVALID JSON/.test(c.text)));
  });

  it('fails on unbalanced Kaizen markers in CLAUDE.md', () => {
    const home = materializeHome({ defaultState: true });
    writeText(path.join(home.configDir, 'CLAUDE.md'), '# Notes\n\n<!-- kaizen:start lonely -->\nrule\n');
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && /unbalanced Kaizen markers \(start 1, end 0\)/.test(c.text)));
  });

  it('fails when a hook script referenced from settings.json is missing', () => {
    const home = materializeHome({ defaultState: true });
    const settings = readJson(home.settingsFile);
    settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${home.stateDir.replace(/\\/g, '/')}/hooks/ghost.mjs"` }] }];
    writeJson(home.settingsFile, settings);
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && /ghost\.mjs/.test(c.text)));
  });

  it('fails when an installed hook script does not pass its self-test', () => {
    const home = materializeHome({ defaultState: true });
    writeText(path.join(home.stateDir, 'hooks', 'broken.mjs'), "console.log('FAIL: nothing works');\nprocess.exit(1);\n");
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1);
    const v = JSON.parse(r.stdout);
    assert.ok(v.checks.some((c) => !c.ok && /broken\.mjs/.test(c.text) && /FAIL: nothing works/.test(c.text)), JSON.stringify(v.checks));
  });
});

describe('kaizen nudge', () => {
  it('speaks once when nothing was ever measured, then stays silent', () => {
    const home = materializeHome();
    const first = cli(home, ['nudge']);
    assert.equal(first.status, 0);
    const msg = JSON.parse(first.stdout);
    assert.match(msg.systemMessage, /week/);
    assert.equal(cli(home, ['nudge']).stdout, '');
  });

  it('speaks Russian when the configured language is ru', () => {
    const home = materializeHome();
    writeJson(path.join(home.stateDir, 'config.json'), { lang: 'ru' });
    assert.match(JSON.parse(cli(home, ['nudge']).stdout).systemMessage, /[а-яё]{4,}/i);
  });

  it('is silent when the user turned it off', () => {
    const home = materializeHome();
    writeJson(path.join(home.stateDir, 'config.json'), { nudge: false });
    assert.equal(cli(home, ['nudge']).stdout, '');
  });

  it('announces new high-impact recommendations once after a fresh measurement', () => {
    const home = measured();
    const payload = json(cli(home, ['recommend', '--json']));
    const high = payload.recommendations.filter((r) => r.impact === 'high').length;
    assert.ok(high > 0);
    const first = cli(home, ['nudge']);
    assert.equal(first.status, 0);
    assert.equal(JSON.parse(first.stdout).systemMessage, interpolate(loadLocale('en').cli.nudge, { n: high }));
    assert.match(JSON.parse(first.stdout).systemMessage, new RegExp(`${high} new high-impact`));
    assert.equal(cli(home, ['nudge']).stdout, '');
  });

  it('reminds again when the last measurement is older than a week', () => {
    const home = measured();
    const file = path.join(home.stateDir, 'last-measure.json');
    const last = readJson(file);
    writeJson(file, { ...last, at: new Date(Date.now() - 10 * 86400000).toISOString() });
    assert.match(JSON.parse(cli(home, ['nudge']).stdout).systemMessage, /week/);
    assert.equal(cli(home, ['nudge']).stdout, '', 'but only once a week');
  });

  it('never fails, even when the state directory holds garbage', () => {
    const home = materializeHome();
    writeText(path.join(home.stateDir, 'last-measure.json'), 'not json');
    writeText(path.join(home.stateDir, 'recommendations.json'), '{ nope');
    const r = cli(home, ['nudge']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

/**
 * Copy the parts of the kit the CLI needs to `<tmp>/<name>/` and return {kit, run(args)} that runs the copy's entry point
 * with an empty, hermetic home. Used for commands that write into the kit itself and for unusual install paths.
 */
function copyKit(name = 'kit') {
  const kit = path.join(makeTempDir('kaizen-kit-'), name);
  for (const dir of ['scripts', 'locales', 'recipes', 'console']) copyTree(path.join(KIT_ROOT, dir), path.join(kit, dir));
  fs.copyFileSync(path.join(KIT_ROOT, 'package.json'), path.join(kit, 'package.json'));
  const root = makeTempDir('kaizen-empty-');
  const env = childEnv({ HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), KAIZEN_STATE_DIR: path.join(root, 'state') });
  const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(kit, 'scripts', 'kaizen.mjs'), ...args], { encoding: 'utf8', env, cwd: root, timeout: 60000, windowsHide: true });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  return { kit, run };
}

describe('running from an install path with spaces and non-ASCII characters', () => {
  it('prints the version (the CLI must recognise that it is the entry point)', () => {
    const r = copyKit('Kaizen Kit кайдзен').run(['--version']);
    assert.equal(r.stdout.trim(), pkg.version, `no output; stderr: ${r.stderr}`);
  });

  it('runs commands: help and doctor', () => {
    const { run } = copyKit('Kaizen Kit кайдзен');
    assert.match(run(['help']).stdout, /^claude-kaizen /);
    assert.equal(JSON.parse(run(['doctor']).stdout).kitVersion, pkg.version);
  });

  it('reports errors with a non-zero exit code from there too', () => {
    const r = copyKit('Kaizen Kit кайдзен').run(['recommend']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No measurement found/);
  });
});

describe('kaizen docs', () => {
  it('writes docs/recipes.md into the kit with every recipe and the metric table (run on a copy of the kit)', () => {
    const { kit, run } = copyKit();
    const r = run(['docs']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote .*recipes\.md/);
    const md = fs.readFileSync(path.join(kit, 'docs', 'recipes.md'), 'utf8');
    const catalog = readJson(path.join(KIT_ROOT, 'recipes', 'catalog.json'));
    for (const recipe of catalog.recipes) assert.ok(md.includes(`### \`${recipe.id}\``), recipe.id);
    assert.ok(md.includes('## Metrics recipes can test'));
    assert.ok(md.includes('| `friction.permissionPrompts` |'));
  });

  it('is in sync with the committed docs/recipes.md (regenerate with `node scripts/kaizen.mjs docs` after changing the catalog)', () => {
    const { kit, run } = copyKit();
    assert.equal(run(['docs']).status, 0);
    const generated = fs.readFileSync(path.join(kit, 'docs', 'recipes.md'), 'utf8').replace(/\r\n/g, '\n');
    const committed = fs.readFileSync(path.join(KIT_ROOT, 'docs', 'recipes.md'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(generated, committed);
  });
});

// ------------------------------------------------------------------ code-review regressions

describe('parseArgs: only value flags take the next argument', () => {
  it('boolean flags never swallow a positional argument', () => {
    assert.deepEqual(parseArgs(['apply', '--force', 'my-choices.json']), { _: ['apply', 'my-choices.json'], flags: { force: true } });
    assert.deepEqual(parseArgs(['undo', '--dry-run', '2026-10-31T10-00-00']), { _: ['undo', '2026-10-31T10-00-00'], flags: { 'dry-run': true } });
    assert.deepEqual(parseArgs(['status', '--json', 'x']), { _: ['status', 'x'], flags: { json: true } });
    assert.deepEqual(parseArgs(['recommend', '--all', 'x', '--last', 'y']), { _: ['recommend', 'x', 'y'], flags: { all: true, last: true } });
  });

  it('an unknown flag is a boolean too', () => {
    assert.deepEqual(parseArgs(['--whatever', 'x']), { _: ['x'], flags: { whatever: true } });
  });

  it('the value flags still take their value', () => {
    const { flags } = parseArgs(['--days', '7', '--project', 'p', '--lang', 'ru', '--scope', 'user', '--recipe', 'a,b', '--top', '3', '--add', 'f.json', '--mode', 'render', '--port', '0', '--out', 'o', '--timeout', '1', '--transport', 'artifact', '--param-file', 'a.b=c', '--import', '-']);
    assert.deepEqual(flags, { days: '7', project: 'p', lang: 'ru', scope: 'user', recipe: 'a,b', top: '3', add: 'f.json', mode: 'render', port: '0', out: 'o', timeout: '1', transport: 'artifact', 'param-file': 'a.b=c', import: '-' });
  });

  it('a value flag followed by another flag, or at the end, is true', () => {
    assert.deepEqual(parseArgs(['--scope', '--dry-run']).flags, { scope: true, 'dry-run': true });
    assert.deepEqual(parseArgs(['--import']).flags, { import: true });
  });

  it('apply --dry-run FILE plans the named file, not the default choices.json', () => {
    const home = measured();
    json(cli(home, ['recommend', '--json']));
    writeJson(path.join(home.stateDir, 'choices.json'), { version: 1, selected: [{ id: 'permissions.deny-secrets', scope: 'user', params: {} }], discuss: [], notes: '' });
    const mine = path.join(home.root, 'mine.json');
    writeJson(mine, { version: 1, selected: [{ id: 'settings.cleanup-period', scope: 'user', params: {} }], discuss: [], notes: '' });
    for (const argv of [['apply', '--dry-run', mine], ['apply', '--force', '--dry-run', mine], ['apply', mine, '--dry-run']]) {
      const r = cli(home, argv);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /cleanupPeriodDays/, argv.join(' '));
      assert.ok(!/permissions\.deny/.test(r.stdout), argv.join(' '));
    }
  });

  it('undo --dry-run ID previews the named batch, not the last one', () => {
    const home = measured();
    const first = '2026-10-01T10-00-00';
    const second = '2026-10-31T10-00-00';
    for (const [id, recipe] of [[first, 'settings.cleanup-period'], [second, 'permissions.deny-secrets']]) {
      writeJson(path.join(home.stateDir, 'applied', id, 'manifest.json'), { id, at: '2026-10-01T10:00:00.000Z', recipes: [{ id: recipe, scope: 'user', params: {}, actions: [{ type: 'settings.set', file: home.settingsFile, path: 'cleanupPeriodDays', previous: null, hadPrevious: false, value: 90 }], advice: false }] });
    }
    const r = cli(home, ['undo', '--dry-run', first]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(first), r.stdout);
    assert.ok(!r.stdout.includes(second), r.stdout);
  });

  it('undo --dry-run says what would be reverted, never "Reverted N change(s)", in English and Russian', () => {
    const home = measured();
    const id = '2026-10-31T10-00-00';
    writeJson(home.settingsFile, { ...readJson(home.settingsFile), cleanupPeriodDays: 90 });
    writeJson(path.join(home.stateDir, 'applied', id, 'manifest.json'), { id, at: '2026-10-31T10:00:00.000Z', recipes: [{ id: 'settings.cleanup-period', scope: 'user', params: {}, actions: [{ type: 'settings.set', file: home.settingsFile, path: 'cleanupPeriodDays', previous: null, hadPrevious: false, value: 90 }], advice: false }] });
    const before = snapshotDir(home.root);
    const en = cli(home, ['undo', '--dry-run']);
    assert.equal(en.status, 0, en.stderr);
    assert.ok(en.stdout.includes(t('cli.undo_dry', { n: 1, id })), en.stdout);
    assert.ok(!en.stdout.includes(prefixOf('cli.undo_done', { n: 1 })), en.stdout);
    const ru = cli(home, ['undo', '--dry-run', '--lang', 'ru']);
    assert.ok(ru.stdout.includes(tRu('cli.undo_dry', { n: 1, id })), ru.stdout);
    assert.ok(!ru.stdout.includes(prefixOf('cli.undo_done', { n: 1 }, 'ru')), ru.stdout);
    assert.deepEqual(snapshotDir(home.root), before);
  });
});

describe('skills: how undo and start talk about reverting', () => {
  const skill = (name) => fs.readFileSync(path.join(KIT_ROOT, 'skills', name, 'SKILL.md'), 'utf8');

  it('the undo skill offers only whole batches: no hand edit, which its tools could not do and the rules forbid', () => {
    const text = skill('undo');
    assert.ok(!/manual edit is acceptable|manual removal/i.test(text), 'no manual removal offered');
    assert.match(text, /Never edit `settings\.json`/);
    assert.match(text, /apply --recipe/);
    assert.ok(!/\b(Edit|Write)\b/.test(text.split('---')[1] || ''), 'allowed-tools has no Edit or Write');
  });

  it('the start skill closes by explaining that one run can leave several batches and how to undo them all', () => {
    const text = skill('start');
    assert.match(text, /several batches/);
    assert.match(text, /undo --all/);
    assert.match(text, /undo <id>/);
  });
});

describe('kaizen recommend --all', () => {
  it('does not overwrite recommendations.json (status and the nudge keep seeing the real recommendations)', () => {
    const home = measured();
    const normal = json(cli(home, ['recommend', '--json']));
    const file = path.join(home.stateDir, 'recommendations.json');
    const before = fs.readFileSync(file, 'utf8');
    const status = json(cli(home, ['status'])).recommendations;
    const all = json(cli(home, ['recommend', '--json', '--all']));
    assert.ok(all.recommendations.length > normal.recommendations.length);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(json(cli(home, ['status'])).recommendations, status);
    assert.equal(readJson(path.join(home.stateDir, 'recommendations.all.json')).recommendations.length, all.recommendations.length);
  });

  it('apply --recipe can use an id that only the --all listing has', () => {
    const home = measured();
    json(cli(home, ['recommend', '--json']));
    const all = json(cli(home, ['recommend', '--json', '--all']));
    const hiddenId = all.recommendations.find((r) => r.matched === false && r.kind === 'recipe').id;
    const r = cli(home, ['apply', '--recipe', hiddenId, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('unknown recipe'), r.stdout);
  });
});

describe('kaizen: custom recipes, --add and --param-file', () => {
  const rulesRecipe = {
    id: 'custom.house-rules',
    category: 'claude-md',
    impact: 'high',
    risk: 'low',
    title: { en: 'House rules', ru: 'Правила' },
    why: { en: 'w', ru: 'п' },
    evidence: { en: 'e', ru: 'д' },
    when: true,
    params: [{ name: 'rules', type: 'text', default: '', label: { en: 'Rules', ru: 'Правила' } }],
    actions: [{ type: 'claude-md.block', id: 'house-rules', content: '{params.rules}' }],
  };
  const withExtra = () => {
    const home = measured();
    const extra = path.join(home.root, 'extra.json');
    writeJson(extra, { recipes: [rulesRecipe] });
    return { home, extra };
  };

  it('recommend --add records the absolute path as extraFile, and apply finds the custom recipe without --add', () => {
    const { home, extra } = withExtra();
    const payload = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.equal(payload.extraFile, path.resolve(extra));
    assert.equal(readJson(path.join(home.stateDir, 'recommendations.json')).extraFile, path.resolve(extra));
    const rules = path.join(home.root, 'rules.md');
    writeText(rules, 'Always run the tests.\n\nNever commit to main.\n');
    const r = cli(home, ['apply', '--recipe', 'custom.house-rules', '--param-file', `custom.house-rules.rules=${rules}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('unknown recipe'), r.stdout);
    const md = fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('Always run the tests.\n\nNever commit to main.'), md);
  });

  it('recommend --all --add records the extraFile too, so apply finds the custom recipe afterwards without --add', () => {
    const { home, extra } = withExtra();
    const payload = json(cli(home, ['recommend', '--all', '--json', '--add', extra]));
    assert.equal(payload.extraFile, path.resolve(extra));
    assert.equal(fs.existsSync(path.join(home.stateDir, 'recommendations.json')), false, '--all must not write recommendations.json');
    const rules = path.join(home.root, 'rules.md');
    writeText(rules, 'Listed with --all.\n');
    const r = cli(home, ['apply', '--recipe', 'custom.house-rules', '--param-file', `custom.house-rules.rules=${rules}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('unknown recipe'), r.stdout);
    assert.ok(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8').includes('Listed with --all.'));
  });

  it('a CRLF --param-file is applied with LF line endings and undo --last removes the block', () => {
    const { home, extra } = withExtra();
    json(cli(home, ['recommend', '--json', '--add', extra]));
    const rules = path.join(home.root, 'rules.txt');
    fs.writeFileSync(rules, '- rule one\r\n- rule two\r\n', 'utf8');
    assert.equal(cli(home, ['apply', '--recipe', 'custom.house-rules', '--param-file', `custom.house-rules.rules=${rules}`]).status, 0);
    const claudeMd = path.join(home.configDir, 'CLAUDE.md');
    assert.ok(!fs.readFileSync(claudeMd, 'utf8').includes('\r'));
    const undone = cli(home, ['undo', '--last']);
    assert.equal(undone.status, 0, undone.stderr);
    assert.ok(!undone.stdout.includes('kept:'), undone.stdout);
    assert.ok(!fs.existsSync(claudeMd) || !fs.readFileSync(claudeMd, 'utf8').includes('kaizen:start'));
    assert.equal(json(cli(home, ['status'])).applied[0].undone, true);
  });

  it('a plain recommend (no --add) does not claim an extra file', () => {
    const { home, extra } = withExtra();
    json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.equal(json(cli(home, ['recommend', '--json'])).extraFile, undefined);
  });

  it('apply --add FILE works without recommend --add, and an unknown id is a visible warning', () => {
    const { home, extra } = withExtra();
    json(cli(home, ['recommend', '--json']));
    const rules = path.join(home.root, 'rules.md');
    writeText(rules, 'One rule.');
    const unknown = cli(home, ['apply', '--recipe', 'custom.house-rules', '--dry-run']);
    assert.equal(unknown.status, 1, unknown.stdout);
    assert.match(unknown.stderr, /Unknown recipe id\(s\): custom\.house-rules\. Nothing was applied\. Custom recipes need --add FILE/);
    const mixed = cli(home, ['apply', '--recipe', 'custom.house-rules,settings.cleanup-period', '--dry-run']);
    assert.equal(mixed.status, 0, mixed.stderr);
    assert.match(mixed.stdout, /! unknown recipe custom\.house-rules \(skipped\)/);
    const known = cli(home, ['apply', '--recipe', 'custom.house-rules', '--add', extra, '--param-file', `custom.house-rules.rules=${rules}`]);
    assert.equal(known.status, 0, known.stderr);
    assert.ok(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8').includes('One rule.'));
  });

  it('a recipe that skipped everything (empty text) stays open: it is recommended again, not "already applied"', () => {
    const { home, extra } = withExtra();
    json(cli(home, ['recommend', '--json', '--add', extra]));
    const empty = cli(home, ['apply', '--recipe', 'custom.house-rules']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /text parameter not filled in/);
    const again = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(again.recommendations.some((r) => r.id === 'custom.house-rules'));
    assert.ok(!again.alreadyApplied.some((a) => a.id === 'custom.house-rules'));
    const rules = path.join(home.root, 'rules.md');
    writeText(rules, 'Filled in.');
    assert.equal(cli(home, ['apply', '--recipe', 'custom.house-rules', '--param-file', `custom.house-rules.rules=${rules}`]).status, 0);
    const done = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(done.alreadyApplied.some((a) => a.id === 'custom.house-rules'));
  });

  it('expands ~ in --add (PowerShell and cmd hand it over literally)', () => {
    const { home, extra } = withExtra();
    const inHome = path.join(home.home, 'extra-in-home.json');
    fs.copyFileSync(extra, inHome);
    const payload = json(cli(home, ['recommend', '--json', '--add', '~/extra-in-home.json']));
    assert.ok(payload.recommendations.some((r) => r.id === 'custom.house-rules'));
    assert.equal(payload.extraFile, inHome);
  });
});

describe('kaizen choices --import', () => {
  const doc = { version: 1, selected: [{ id: 'settings.cleanup-period', scope: 'user', params: {} }, { id: 'hooks.guard-destructive', scope: 'user', params: { mode: 'ask' } }], discuss: ['claude-md.diet'], notes: 'tests are `make check`' };

  it('is listed in help', () => {
    assert.match(runCli(['help']).stdout, /choices\s+.*\n.*--import FILE\|-/);
  });

  it('stores a file as choices.json and prints a one-line JSON summary', () => {
    const home = materializeHome();
    const src = path.join(home.root, 'in.json');
    writeJson(src, doc);
    const r = cli(home, ['choices', '--import', src]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, file: path.join(home.stateDir, 'choices.json'), selected: 2, discuss: 1, notes: true });
    const saved = readJson(path.join(home.stateDir, 'choices.json'));
    assert.deepEqual(saved.selected, doc.selected);
    assert.equal(saved.version, 1);
  });

  it('reads stdin with "-"', () => {
    const home = materializeHome();
    const r = cli(home, ['choices', '--import', '-'], { input: JSON.stringify({ selected: [] }) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, file: path.join(home.stateDir, 'choices.json'), selected: 0, discuss: 0, notes: false });
  });

  it('exits non-zero with the validation error and writes nothing for invalid input', () => {
    const home = materializeHome();
    const bad = cli(home, ['choices', '--import', '-'], { input: JSON.stringify({ selected: [{ id: 'Bad Id' }] }) });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad recipe id/);
    const notJson = cli(home, ['choices', '--import', '-'], { input: 'not json' });
    assert.equal(notJson.status, 1);
    assert.match(notJson.stderr, /not valid JSON/);
    const missing = cli(home, ['choices', '--import', path.join(home.root, 'nope.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT|no such file/i);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'choices.json')));
  });

  it('refuses to run without --import', () => {
    const home = materializeHome();
    const r = cli(home, ['choices']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: choices --import/);
  });

  it('what it stores is what apply reads', () => {
    const home = measured();
    json(cli(home, ['recommend', '--json']));
    const r = cli(home, ['choices', '--import', '-'], { input: JSON.stringify(doc) });
    assert.equal(r.status, 0, r.stderr);
    const dry = cli(home, ['apply', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /cleanupPeriodDays/);
  });
});

describe('kaizen nudge and the journal', () => {
  it('does not announce recipes that were already applied as new', () => {
    const home = measured();
    const payload = json(cli(home, ['recommend', '--json']));
    const high = payload.recommendations.filter((r) => r.impact === 'high');
    assert.ok(high.length > 0);
    writeJson(path.join(home.stateDir, 'applied', '2026-10-30T10-00-00', 'manifest.json'), {
      id: '2026-10-30T10-00-00',
      at: '2026-10-30T10:00:00.000Z',
      recipes: high.map((r) => ({ id: r.id, scope: 'user', params: {}, actions: [{ type: 'file', file: path.join(home.root, 'x'), hash: 'h' }], advice: false })),
    });
    assert.equal(cli(home, ['nudge']).stdout, '');
  });

  it('still counts a high-impact recipe whose apply wrote nothing', () => {
    const home = measured();
    const payload = json(cli(home, ['recommend', '--json']));
    const high = payload.recommendations.filter((r) => r.impact === 'high');
    writeJson(path.join(home.stateDir, 'applied', '2026-10-30T10-00-00', 'manifest.json'), {
      id: '2026-10-30T10-00-00',
      at: '2026-10-30T10:00:00.000Z',
      recipes: high.map((r) => ({ id: r.id, scope: 'user', params: {}, actions: [], advice: false })),
    });
    assert.match(JSON.parse(cli(home, ['nudge']).stdout).systemMessage, new RegExp(`${high.length} new high-impact`));
  });
});

describe('kaizen verify: the interpreter of a hook', () => {
  it('fails when the node binary a Kaizen hook command pins no longer exists', () => {
    const home = materializeHome({ defaultState: true });
    writeText(path.join(home.stateDir, 'hooks', 'ok.mjs'), "console.log('ok');\n");
    const posix = (p) => p.replace(/\\/g, '/');
    const gone = posix(path.join(home.root, 'gone', 'node.exe'));
    const settings = readJson(home.settingsFile);
    settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${gone}" "${posix(home.stateDir)}/hooks/ok.mjs"` }] }];
    writeJson(home.settingsFile, settings);
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && c.text.includes(gone)), r.stdout);
  });

  it('passes when the pinned node exists', () => {
    const home = materializeHome({ defaultState: true });
    writeText(path.join(home.stateDir, 'hooks', 'ok.mjs'), "console.log('ok');\n");
    const posix = (p) => p.replace(/\\/g, '/');
    const settings = readJson(home.settingsFile);
    settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${posix(process.execPath)}" "${posix(home.stateDir)}/hooks/ok.mjs"` }] }];
    writeJson(home.settingsFile, settings);
    assert.equal(json(cli(home, ['verify', '--json'])).ok, true);
  });
});

describe('kaizen: the language chosen with --lang is remembered', () => {
  const rec = (home) => readJson(path.join(home.stateDir, 'recommendations.json'));

  it('after measure --lang ru and recommend --lang ru, console, verify, apply, undo and status are Russian without --lang', () => {
    const home = materializeHome({ projects: true, usageData: true });
    assert.equal(cli(home, ['measure', '--all', '--quiet', '--lang', 'ru']).status, 0);
    assert.equal(readJson(path.join(home.stateDir, 'measure.json')).uiLang, 'ru');
    const recs = json(cli(home, ['recommend', '--lang', 'ru', '--json']));
    assert.equal(recs.lang, 'ru');
    assert.equal(recs.uiLang, 'ru');

    const consoleRun = cli(home, ['console', '--mode', 'render', '--transport', 'static']);
    assert.equal(consoleRun.status, 0, consoleRun.stderr);
    const html = fs.readFileSync(consoleRun.stdout.trim(), 'utf8');
    assert.match(html, /const KAIZEN = \{"lang":"ru"/);
    assert.ok(html.includes(loadLocale('ru').console.submit), 'the page buttons are Russian');

    assert.ok(cli(home, ['verify']).stdout.includes(tRu('verify.header')));
    assert.ok(cli(home, ['apply', '--recipe', 'settings.cleanup-period', '--dry-run']).stdout.includes(tRu('cli.apply_dry', { n: 1 })));
    assert.ok(cli(home, ['undo']).stdout.includes(tRu('cli.undo_nothing')));
    assert.equal(json(cli(home, ['status'])).lang, 'ru');
    assert.ok(cli(home, ['help']).stdout.includes(tRu('cli.help_note')));
  });

  it('recommend without --lang keeps the language measure was given, and an explicit --lang still wins', () => {
    const home = materializeHome({ projects: true, usageData: true });
    assert.equal(cli(home, ['measure', '--all', '--quiet', '--lang', 'ru']).status, 0);
    assert.equal(json(cli(home, ['recommend', '--json'])).lang, 'ru');
    assert.ok(cli(home, ['verify', '--lang', 'en']).stdout.includes(t('verify.header')));
    assert.ok(cli(home, ['verify']).stdout.includes(tRu('verify.header')), 'a one-off --lang does not change the stored choice');
    // the latest explicit choice wins
    assert.equal(json(cli(home, ['recommend', '--lang', 'en', '--json'])).lang, 'en');
    assert.ok(cli(home, ['verify']).stdout.includes(t('verify.header')));
    assert.equal(cli(home, ['measure', '--all', '--quiet', '--lang', 'ru']).status, 0);
    assert.ok(cli(home, ['verify']).stdout.includes(tRu('verify.header')));
  });

  it('a re-measure without --lang keeps the earlier choice; config.json lang beats it', () => {
    const home = materializeHome({ projects: true, usageData: true });
    cli(home, ['measure', '--all', '--quiet', '--lang', 'ru']);
    cli(home, ['recommend', '--json']);
    assert.equal(cli(home, ['measure', '--all', '--quiet']).status, 0);
    assert.equal(readJson(path.join(home.stateDir, 'measure.json')).uiLang, 'ru');
    assert.equal(json(cli(home, ['status'])).lang, 'ru');
    writeJson(path.join(home.stateDir, 'config.json'), { lang: 'en' });
    assert.equal(json(cli(home, ['status'])).lang, 'en');
  });

  it('without any --lang nothing is stored and the detected language is used', () => {
    const home = measured();
    assert.equal(readJson(path.join(home.stateDir, 'measure.json')).uiLang, undefined);
    json(cli(home, ['recommend', '--json']));
    assert.equal(rec(home).uiLang, undefined);
  });

  it('recommend prints the "already applied" line and the advice tag in the chosen language', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'settings.cleanup-period']).status, 0);
    const ru = cli(home, ['recommend', '--lang', 'ru', '--all']).stdout;
    assert.match(ru, /Уже применено: .*settings\.cleanup-period/);
    assert.match(ru, /\(совет\)/);
    assert.doesNotMatch(ru, /\(advice\)|Already applied/);
    const en = cli(home, ['recommend', '--lang', 'en', '--all']).stdout;
    assert.match(en, /Already applied: .*settings\.cleanup-period/);
    assert.match(en, /\(advice\)/);
  });
});

describe('kaizen: expected errors are one clean line', () => {
  const lines = (s) => s.trim().split(/\r?\n/);

  it('a step run out of order prints a single localized line, and the stack only with KAIZEN_DEBUG=1', () => {
    const home = materializeHome();
    const file = path.join(home.stateDir, 'measure.json');
    const en = cli(home, ['recommend']);
    assert.equal(en.status, 1);
    assert.deepEqual(lines(en.stderr), [`kaizen: ${t('err.no_measure', { file })}`]);
    const ru = cli(home, ['recommend', '--lang', 'ru']);
    assert.equal(ru.status, 1);
    assert.deepEqual(lines(ru.stderr), [`kaizen: ${tRu('err.no_measure', { file })}`]);
    const debug = cli(home, ['recommend'], { env: { ...home.env, KAIZEN_DEBUG: '1' } });
    assert.equal(debug.status, 1);
    assert.match(debug.stderr, /\n\s+at /);
  });

  it('apply with no choices, a malformed --param and console without recommendations are single lines too', () => {
    const home = measured();
    for (const args of [['apply'], ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'mode=ask', '--dry-run'], ['console', '--mode', 'render']]) {
      const r = cli(home, args);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(lines(r.stderr).length, 1, r.stderr);
      assert.doesNotMatch(r.stderr, /\n\s+at /);
    }
    assert.match(cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'mode=ask', '--lang', 'ru']).stderr, /--param ожидает вид recipe\.id\.param=value, получено: mode=ask/);
  });

  it('a bad --days is refused before the scan runs', () => {
    const home = materializeHome({ projects: true });
    for (const bad of ['abc', '0', '-3', 'Infinity']) {
      const r = cli(home, ['measure', '--days', bad, '--quiet']);
      assert.equal(r.status, 1, bad);
      assert.deepEqual(lines(r.stderr), [`kaizen: ${t('err.bad_days', { value: bad })}`]);
    }
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'measure.json')));
    assert.match(cli(home, ['measure', '--days', 'abc', '--lang', 'ru']).stderr, /--days ожидает положительное число, получено: abc/);
    assert.equal(cli(home, ['measure', '--days', '7', '--quiet']).status, 0);
  });
});

describe('kaizen: unknown recipe ids and mistyped --param', () => {
  it('apply with only unknown ids exits 1 with a suggestion and leaves the journal and last-apply.json alone', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'settings.cleanup-period']).status, 0);
    const last = path.join(home.stateDir, 'last-apply.json');
    const before = fs.readFileSync(last, 'utf8');
    const batches = fs.readdirSync(path.join(home.stateDir, 'applied'));
    const r = cli(home, ['apply', '--recipe', 'hooks.guard-destruct']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown recipe id\(s\): hooks\.guard-destruct\. Nothing was applied\. Did you mean: hooks\.guard-destructive\?/);
    assert.equal(r.stdout, '');
    assert.equal(fs.readFileSync(last, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(home.stateDir, 'applied')), batches);
    const ru = cli(home, ['apply', '--recipe', 'hooks.guard-destruct', '--lang', 'ru']);
    assert.equal(ru.status, 1);
    assert.match(ru.stderr, /Неизвестные id рецептов: hooks\.guard-destruct\. Ничего не применено\./);
  });

  it('choices --import warns about ids unknown to the catalog and the extra recipes, but still stores the file', () => {
    const home = measured();
    const file = path.join(home.root, 'choices-in.json');
    const extra = path.join(home.root, 'extra.json');
    writeJson(extra, { recipes: [{ id: 'custom.mine' }] });
    writeJson(file, { selected: [{ id: 'hooks.nope' }, { id: 'settings.cleanup-period' }, { id: 'custom.mine' }] });
    const r = cli(home, ['choices', '--import', file, '--add', extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.trim(), t('cli.choices_unknown', { ids: 'hooks.nope' }));
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.unknown, ['hooks.nope']);
    assert.equal(readJson(path.join(home.stateDir, 'choices.json')).selected.length, 3);
    // without the extra file the custom id is unknown too
    assert.deepEqual(JSON.parse(cli(home, ['choices', '--import', file]).stdout).unknown, ['hooks.nope', 'custom.mine']);
    // known ids only: no warning, no "unknown" key
    writeJson(file, { selected: [{ id: 'settings.cleanup-period' }] });
    const clean = cli(home, ['choices', '--import', file]);
    assert.equal(clean.stderr, '');
    assert.equal(JSON.parse(clean.stdout).unknown, undefined);
  });

  it('a --param for a mistyped recipe or parameter is an error that lists what is valid', () => {
    const home = measured();
    const typo = cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'hooks.guard-destructive.moed=ask', '--dry-run']);
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /recipe hooks\.guard-destructive has no parameter moed\. Valid parameters: mode, protectedBranches\./);
    const typoRu = cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'hooks.guard-destructiv.mode=ask', '--dry-run', '--lang', 'ru']);
    assert.equal(typoRu.status, 1);
    assert.match(typoRu.stderr, /не входит в выбранные \(hooks\.guard-destructive\)/);
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'hooks.guard-destructive.mode=block', '--dry-run']).status, 1);
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive', '--param', 'hooks.guard-destructive.mode=ask', '--dry-run']).status, 0);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'applied')));
  });
});

describe('kaizen verify: Kaizen hooks are recognised wherever the state directory is', () => {
  const posix = (p) => p.replace(/\\/g, '/');

  it('reports a deleted hook script when KAIZEN_STATE_DIR is not called "kaizen"', () => {
    const home = measured(); // state dir: <root>/state
    assert.ok(!/kaizen[\\/]?$/i.test(home.stateDir));
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive']).status, 0);
    const ok = json(cli(home, ['verify', '--json']));
    assert.ok(ok.checks.some((c) => c.ok && /settings\.json: valid JSON \(1 Kaizen hook\(s\)\)/.test(c.text)), JSON.stringify(ok.checks));
    fs.rmSync(path.join(home.stateDir, 'hooks', 'guard-destructive.mjs'));
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && c.text.includes('guard-destructive.mjs')), r.stdout);
    const plain = cli(home, ['verify', '--lang', 'ru']);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /✗ файл хука, указанный в .*settings\.json, отсутствует: .*guard-destructive\.mjs/);
  });

  it('checks the status line script too', () => {
    const home = materializeHome({ defaultState: false });
    const settings = readJson(home.settingsFile);
    settings.statusLine = { type: 'command', command: `node "${posix(home.stateDir)}/statusline.mjs"` };
    writeJson(home.settingsFile, settings);
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && c.text.includes('statusline.mjs')), r.stdout);
    writeText(path.join(home.stateDir, 'statusline.mjs'), "console.log('Kaizen check');\n");
    const ok = JSON.parse(cli(home, ['verify', '--json']).stdout);
    assert.ok(ok.checks.some((c) => /\(1 Kaizen hook\(s\)\)/.test(c.text)), JSON.stringify(ok.checks));
  });

  it('knows a script the journal recorded even outside the state directory', () => {
    const home = materializeHome();
    const elsewhere = path.join(home.root, 'elsewhere', 'tools', 'x-hook.mjs');
    const settings = readJson(home.settingsFile);
    settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${posix(elsewhere)}"` }] }];
    writeJson(home.settingsFile, settings);
    // not ours as long as nobody recorded it
    assert.equal(json(cli(home, ['verify', '--json'])).ok, true);
    writeJson(path.join(home.stateDir, 'applied', '2026-10-31T10-00-00', 'manifest.json'), { id: '2026-10-31T10-00-00', recipes: [{ id: 'x', actions: [{ type: 'file', file: elsewhere }] }] });
    const r = cli(home, ['verify', '--json']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(JSON.parse(r.stdout).checks.some((c) => !c.ok && c.text.includes('x-hook.mjs')), r.stdout);
  });
});
