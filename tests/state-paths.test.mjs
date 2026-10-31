// How skills and agents find the state directory (`kaizen.mjs paths`), `apply --from-batch` (re-apply a journaled batch
// with its own parameters, used by the undo skill) and the terminal-mode choices template of the start skill.
// Hermetic: every child process sees a temp config dir and state dir.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT, cleanupTempDirs, makeTempDir, materializeHome, readJson, runCli, writeJson, writeText } from './helpers.mjs';

after(() => cleanupTempDirs());

const cli = (home, args, opts = {}) => runCli(args, { env: home.env, ...opts });
const json = (r) => {
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const measured = () => {
  const home = materializeHome({ projects: true, usageData: true });
  const r = cli(home, ['measure', '--all', '--quiet']);
  assert.equal(r.status, 0, r.stderr);
  return home;
};
const batchIds = (home) => json(cli(home, ['status'])).applied.map((a) => a.id);

describe('kaizen paths', () => {
  it('prints the state directory from KAIZEN_STATE_DIR and the files in it', () => {
    const home = materializeHome();
    const p = json(cli(home, ['paths']));
    assert.equal(path.resolve(p.stateDir), path.resolve(home.stateDir));
    assert.equal(path.resolve(p.configDir), path.resolve(home.configDir));
    assert.equal(path.resolve(p.measureMd), path.join(home.stateDir, 'measure.md'));
    assert.equal(path.resolve(p.extraRecipes), path.join(home.stateDir, 'extra-recipes.json'));
    assert.equal(path.resolve(p.drafts), path.join(home.stateDir, 'drafts'));
    assert.equal(path.resolve(p.hooks), path.join(home.stateDir, 'hooks'));
    assert.equal(path.resolve(p.applied), path.join(home.stateDir, 'applied'));
    assert.equal(path.resolve(p.choicesImport), path.join(home.stateDir, 'choices.import.json'));
  });

  it('prints absolute paths even when KAIZEN_STATE_DIR and CLAUDE_CONFIG_DIR are relative', () => {
    const home = materializeHome();
    const env = { ...home.env, KAIZEN_STATE_DIR: 'rel-state', CLAUDE_CONFIG_DIR: 'rel-config' };
    const p = json(cli(home, ['paths'], { env, cwd: home.root }));
    const real = fs.realpathSync(home.root);
    for (const [key, value] of Object.entries(p)) assert.ok(path.isAbsolute(value), `${key} is not absolute: ${value}`);
    assert.equal(fs.realpathSync(path.dirname(p.stateDir)), real);
    assert.equal(path.basename(p.stateDir), 'rel-state');
    assert.equal(path.basename(p.configDir), 'rel-config');
    assert.equal(path.dirname(p.measureMd), p.stateDir);
  });

  it('follows CLAUDE_CONFIG_DIR alone: <config dir>/kaizen, not a fixed ~/.claude/kaizen', () => {
    const home = materializeHome({ defaultState: true });
    const p = json(cli(home, ['paths']));
    assert.equal(path.resolve(p.stateDir), path.join(home.configDir, 'kaizen'));
  });

  it('measureMd is exactly where `measure --quiet` (which prints nothing) writes the digest', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const before = json(cli(home, ['paths']));
    assert.ok(!fs.existsSync(before.measureMd));
    const r = cli(home, ['measure', '--all', '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(json(cli(home, ['paths'])).measureMd), 'the digest is at the path `paths` reported');
  });

  it('writes nothing and is listed in the help', () => {
    const home = materializeHome();
    const empty = makeTempDir('kaizen-nostate-');
    const env = { ...home.env, KAIZEN_STATE_DIR: path.join(empty, 'not-created') };
    json(runCli(['paths'], { env }));
    assert.ok(!fs.existsSync(path.join(empty, 'not-created')), 'asking for the paths does not create the folder');
    assert.match(runCli(['help']).stdout, /^ {2}paths\s/m);
  });
});

describe('apply --from-batch', () => {
  const setup = () => {
    const home = measured();
    const rules = path.join(home.root, 'rules.md');
    writeText(rules, 'Always run tests.\n');
    const first = cli(home, [
      'apply',
      '--recipe', 'hooks.guard-destructive,claude-md.corrections,settings.cleanup-period',
      '--param', 'hooks.guard-destructive.mode=ask',
      '--param', 'hooks.guard-destructive.protectedBranches=release',
      '--param-file', `claude-md.corrections.rules=${rules}`,
    ]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const [id] = batchIds(home);
    return { home, id };
  };
  const hookScript = (home) => fs.readFileSync(path.join(home.stateDir, 'hooks', 'guard-destructive.mjs'), 'utf8');

  it('re-applies the kept recipes of an undone batch with the parameters they had (a bare `apply --recipe` loses them)', () => {
    const { home, id } = setup();
    assert.match(hookScript(home), /MODE_RAW = 'ask'/);
    assert.equal(cli(home, ['undo', id]).status, 0);
    assert.ok(!fs.existsSync(path.join(home.stateDir, 'hooks', 'guard-destructive.mjs')) || !/MODE_RAW = 'ask'/.test(hookScript(home)), 'undone');

    const dry = cli(home, ['apply', '--from-batch', id, '--recipe', 'hooks.guard-destructive,claude-md.corrections', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.equal(batchIds(home).length, 1, 'a dry run adds no batch');

    const again = cli(home, ['apply', '--from-batch', id, '--recipe', 'hooks.guard-destructive,claude-md.corrections']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    const script = hookScript(home);
    assert.match(script, /MODE_RAW = 'ask'/, 'mode survives');
    assert.match(script, /BRANCHES_RAW = 'release'/, 'branches survive');
    assert.match(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8'), /Always run tests\./, 'drafted rules survive');

    const ids = batchIds(home);
    assert.equal(ids.length, 2);
    const fresh = readJson(path.join(home.stateDir, 'applied', ids[1], 'manifest.json'));
    assert.deepEqual(fresh.recipes.map((r) => r.id).sort(), ['claude-md.corrections', 'hooks.guard-destructive']);
    assert.ok(!fresh.recipes.some((r) => r.id === 'settings.cleanup-period'), 'the dropped recipe stays dropped');
    assert.deepEqual(fresh.recipes.find((r) => r.id === 'hooks.guard-destructive').params, { mode: 'ask', protectedBranches: 'release' });
  });

  it('the plain re-apply the skill used to prescribe does lose them (why --from-batch exists)', () => {
    const { home, id } = setup();
    assert.equal(cli(home, ['undo', id]).status, 0);
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive']).status, 0);
    assert.match(hookScript(home), /MODE_RAW = 'deny'/);
  });

  it('without --recipe it re-applies every recipe of the batch that changed something, and keeps the scope', () => {
    const { home, id } = setup();
    assert.equal(cli(home, ['undo', id]).status, 0);
    const r = cli(home, ['apply', '--from-batch', id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const fresh = readJson(path.join(home.stateDir, 'applied', batchIds(home)[1], 'manifest.json'));
    assert.deepEqual(fresh.recipes.map((x) => x.id).sort(), ['claude-md.corrections', 'hooks.guard-destructive', 'settings.cleanup-period']);
    assert.deepEqual(fresh.recipes.map((x) => x.scope), readJson(path.join(home.stateDir, 'applied', id, 'manifest.json')).recipes.map((x) => x.scope));
  });

  it('does not touch choices.json (the console or import selection stays what it was)', () => {
    const { home, id } = setup();
    writeJson(path.join(home.stateDir, 'choices.json'), { version: 1, selected: [{ id: 'settings.cleanup-period' }], discuss: [], notes: 'kept' });
    cli(home, ['undo', id]);
    assert.equal(cli(home, ['apply', '--from-batch', id, '--recipe', 'settings.cleanup-period']).status, 0);
    assert.equal(readJson(path.join(home.stateDir, 'choices.json')).notes, 'kept');
  });

  it('re-applies project-scope recipes into the project the batch was applied in, wherever it is run from', () => {
    const home = measured();
    const projA = path.join(home.root, 'projA');
    const projB = path.join(home.root, 'projB');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    const first = cli(home, ['apply', '--recipe', 'permissions.accept-edits,settings.cleanup-period', '--scope', 'project', '--project', projA]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const [id] = batchIds(home);
    const fileA = path.join(projA, '.claude', 'settings.json');
    assert.ok(fs.existsSync(fileA), 'the first batch wrote project A');
    assert.equal(cli(home, ['undo', id]).status, 0);
    const before = fs.existsSync(fileA) ? fs.readFileSync(fileA, 'utf8') : null;

    const again = cli(home, ['apply', '--from-batch', id, '--recipe', 'permissions.accept-edits'], { cwd: projB });
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.notEqual(fs.existsSync(fileA) ? fs.readFileSync(fileA, 'utf8') : null, before, 'project A got the settings back');
    assert.match(fs.readFileSync(fileA, 'utf8'), /acceptEdits/);
    assert.ok(!fs.existsSync(path.join(projB, '.claude', 'settings.json')), 'the folder it ran from is untouched');
    const fresh = readJson(path.join(home.stateDir, 'applied', batchIds(home)[1], 'manifest.json'));
    assert.equal(path.resolve(fresh.projectDir), path.resolve(projA));
  });

  it('an explicit --project wins over the project of the batch', () => {
    const home = measured();
    const projA = path.join(home.root, 'projA');
    const projC = path.join(home.root, 'projC');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projC, { recursive: true });
    assert.equal(cli(home, ['apply', '--recipe', 'permissions.accept-edits', '--scope', 'project', '--project', projA]).status, 0);
    const [id] = batchIds(home);
    assert.equal(cli(home, ['undo', id]).status, 0);
    assert.equal(cli(home, ['apply', '--from-batch', id, '--project', projC]).status, 0);
    assert.ok(fs.existsSync(path.join(projC, '.claude', 'settings.json')));
    assert.ok(!/acceptEdits/.test(fs.existsSync(path.join(projA, '.claude', 'settings.json')) ? fs.readFileSync(path.join(projA, '.claude', 'settings.json'), 'utf8') : ''));
  });

  const stateFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

  it('writes nothing into the state directory on a dry run, nor leaves choices.from-batch.json after a real one', () => {
    const { home, id } = setup();
    assert.equal(cli(home, ['undo', id]).status, 0);
    const before = stateFiles(home.stateDir);
    const dry = cli(home, ['apply', '--from-batch', id, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.deepEqual(stateFiles(home.stateDir), before, 'a dry run leaves the state directory as it was');
    assert.equal(cli(home, ['apply', '--from-batch', id]).status, 0);
    assert.ok(!stateFiles(home.stateDir).some((f) => /choices.from-batch/.test(f)));
  });

  it('localizes its errors (--lang ru) from the locale files, with en/ru parity', () => {
    const { home, id } = setup();
    const noId = cli(home, ['apply', '--from-batch', '--lang', 'ru']);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /требует id пакета/);
    assert.match(cli(home, ['apply', '--from-batch', 'nope', '--lang', 'ru']).stderr, /нет манифеста/);
    assert.match(cli(home, ['apply', '--from-batch', id, '--recipe', 'hooks.protect-secrets', '--lang', 'ru']).stderr, /нет рецепта hooks.protect-secrets/);
    assert.match(cli(home, ['apply', 'choices.json', '--from-batch', id, '--lang', 'ru']).stderr, /нельзя сочетать/);
    for (const lang of ['en', 'ru']) {
      const err = readJson(path.join(KIT_ROOT, 'locales', `${lang}.json`)).err;
      for (const k of ['from_batch_no_id', 'from_batch_with_file', 'from_batch_no_manifest', 'from_batch_no_recipe']) assert.ok(typeof err[k] === 'string' && err[k], `${lang}.err.${k}`);
    }
  });

  it('fails clearly for an unknown batch, a recipe the batch does not have, a missing id and a FILE', () => {
    const { home, id } = setup();
    const noBatch = cli(home, ['apply', '--from-batch', '2000-01-01T00-00-00']);
    assert.equal(noBatch.status, 1);
    assert.match(noBatch.stderr, /--from-batch: no manifest at .*manifest\.json/);
    const noRecipe = cli(home, ['apply', '--from-batch', id, '--recipe', 'hooks.protect-secrets']);
    assert.equal(noRecipe.status, 1);
    assert.match(noRecipe.stderr, /has no recipe hooks\.protect-secrets/);
    const noId = cli(home, ['apply', '--from-batch']);
    assert.equal(noId.status, 1);
    assert.match(noId.stderr, /needs a batch id/);
    const withFile = cli(home, ['apply', 'choices.json', '--from-batch', id]);
    assert.equal(withFile.status, 1);
    assert.match(withFile.stderr, /cannot be combined/);
    assert.equal(batchIds(home).length, 1, 'nothing was applied');
  });
});

describe('start skill: the terminal-mode choices template', () => {
  const start = fs.readFileSync(path.join(KIT_ROOT, 'skills', 'start', 'SKILL.md'), 'utf8');
  const template = JSON.parse(/\*\*C\. Terminal\*\*[\s\S]*?```json\n([\s\S]*?)\n```/.exec(start)[1]);

  it('does not force a scope: items without one take the recipe default (project for five recipes)', () => {
    for (const item of template.selected) assert.ok(!('scope' in item), JSON.stringify(item));
    assert.match(start, /Leave `scope` out of an item unless the user chose one/);
  });

  it('copying the template for recipes whose default scope is project installs them in the project, not in ~/.claude', () => {
    const home = measured();
    const project = makeTempDir('kaizen-project-');
    const ids = ['permissions.accept-edits', 'hooks.verify-before-stop', 'permissions.allowlist-readonly', 'hooks.format-on-edit', 'agents.test-runner'];
    const catalog = readJson(path.join(KIT_ROOT, 'recipes', 'catalog.json')).recipes;
    for (const id of ids) assert.equal(catalog.find((r) => r.id === id).defaultScope, 'project', id);
    const doc = { ...template, selected: ids.map((id) => ({ ...template.selected[0], id })), discuss: [] };
    const file = path.join(home.root, 'choices.import.json');
    writeJson(file, doc);
    assert.equal(cli(home, ['choices', '--import', file]).status, 0);
    const userSettingsBefore = fs.readFileSync(home.settingsFile, 'utf8');
    const r = cli(home, ['apply', '--project', project], { env: { ...home.env, CLAUDE_PROJECT_DIR: project } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(home.settingsFile, 'utf8'), userSettingsBefore, 'the global settings.json is untouched');
    const projectSettings = readJson(path.join(project, '.claude', 'settings.json'));
    assert.equal(projectSettings.permissions.defaultMode, 'acceptEdits');
    assert.ok(projectSettings.hooks.Stop, 'the Stop hook is project-scoped');
  });
});
