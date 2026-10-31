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
import { KIT_ROOT, childEnv, cleanupTempDirs, copyTree, makeTempDir, materializeHome, prefixOf, readJson, runCli, snapshotDir, t, writeJson, writeText } from './helpers.mjs';

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
