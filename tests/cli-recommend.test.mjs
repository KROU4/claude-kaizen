// `kaizen recommend` with an extra-recipes file: what --top does to paramDefaults, and how a re-drafted custom.* recipe
// is offered again after the first draft was applied. Hermetic: every child process sees a temp home and state dir.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTempDirs, materializeHome, readJson, runCli, sleep, t, writeJson } from './helpers.mjs';

after(() => cleanupTempDirs());

const cli = (home, args) => runCli(args, { env: home.env });
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

describe('recommend --top and paramDefaults', () => {
  const setup = () => {
    const home = measured();
    const full = json(cli(home, ['recommend', '--json'])).recommendations;
    const ranked = full.map((r, i) => ({ id: r.id, rank: i, param: r.params[0] && r.params[0].name })).filter((x) => x.param);
    const target = ranked.find((x) => x.rank >= 2) || ranked[ranked.length - 1];
    assert.ok(target && target.rank >= 1, 'the fixture has a recommended recipe with a parameter below the first place');
    const extra = path.join(home.root, 'extra.json');
    writeJson(extra, { recipes: [], paramDefaults: { [target.id]: { [target.param]: 'FROM_DEFAULTS' } } });
    return { home, target, extra };
  };

  it('warns when a recipe with defaults is cut off by --top, and the saved file does not contain it', () => {
    const { home, target, extra } = setup();
    const r = cli(home, ['recommend', '--json', '--lang', 'en', '--add', extra, '--top', String(target.rank)]);
    const payload = json(r);
    assert.ok(!payload.recommendations.some((x) => x.id === target.id), 'cut off by --top');
    assert.ok(r.stderr.includes(t('cli.param_defaults_dropped', { ids: target.id })), r.stderr);
    assert.ok(!readJson(path.join(home.stateDir, 'recommendations.json')).recommendations.some((x) => x.id === target.id));
  });

  it('is quiet and writes the defaults when the recipe is inside the --top slice', () => {
    const { home, target, extra } = setup();
    const r = cli(home, ['recommend', '--json', '--lang', 'en', '--add', extra, '--top', String(target.rank + 1)]);
    const payload = json(r);
    assert.equal(r.stderr, '');
    const rec = payload.recommendations.find((x) => x.id === target.id);
    assert.equal(rec.params.find((p) => p.name === target.param).value, 'FROM_DEFAULTS');
    const noTop = cli(home, ['recommend', '--json', '--lang', 'en', '--add', extra]);
    assert.equal(noTop.stderr, '');
  });
});

describe('a custom recipe the analyst drafted again', () => {
  const recipe = (rule) => ({
    id: 'custom.corrections-rules',
    category: 'claude-md',
    impact: 'high',
    risk: 'low',
    title: { en: 'Standing rules', ru: 'Правила' },
    why: { en: 'w', ru: 'п' },
    evidence: { en: 'e', ru: 'д' },
    when: true,
    actions: [{ type: 'claude-md.block', id: 'corrections', content: `## Lessons\n\n- ${rule}\n` }],
  });
  const ids = (list) => list.map((r) => r.id);

  it('is offered again after the extra recipes file was rewritten, and only until the new draft is applied', async () => {
    const home = measured();
    const extra = path.join(home.root, 'extra-recipes.json');
    const claudeMd = path.join(home.configDir, 'CLAUDE.md');
    writeJson(extra, { recipes: [recipe('rule ONE')] });
    await sleep(50);

    assert.ok(ids(json(cli(home, ['recommend', '--json', '--add', extra])).recommendations).includes('custom.corrections-rules'));
    assert.equal(cli(home, ['apply', '--recipe', 'custom.corrections-rules', '--add', extra]).status, 0);
    assert.match(fs.readFileSync(claudeMd, 'utf8'), /rule ONE/);
    await sleep(50);

    // same file, same draft: applied
    const same = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(!ids(same.recommendations).includes('custom.corrections-rules'));
    assert.ok(ids(same.alreadyApplied).includes('custom.corrections-rules'));

    // the analyst runs again and rewrites the file under the same id
    writeJson(extra, { recipes: [recipe('rule TWO (refreshed)')] });
    await sleep(50);
    const fresh = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(ids(fresh.recommendations).includes('custom.corrections-rules'), 'offered again');
    assert.ok(!ids(fresh.alreadyApplied).includes('custom.corrections-rules'));
    assert.ok(ids(json(cli(home, ['recommend', '--json', '--all', '--add', extra])).recommendations).includes('custom.corrections-rules'));

    // applying it replaces the block and closes the recipe again
    const applied = cli(home, ['apply', '--recipe', 'custom.corrections-rules', '--add', extra]);
    assert.equal(applied.status, 0, applied.stderr);
    const md = fs.readFileSync(claudeMd, 'utf8');
    assert.match(md, /rule TWO \(refreshed\)/);
    assert.ok(!md.includes('rule ONE'), md);
    await sleep(50);
    const done = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(!ids(done.recommendations).includes('custom.corrections-rules'));
    assert.ok(ids(done.alreadyApplied).includes('custom.corrections-rules'));
  });

  it('does not touch catalog recipes: an applied catalog id stays applied when the extra file is rewritten', async () => {
    const home = measured();
    const extra = path.join(home.root, 'extra-recipes.json');
    const first = json(cli(home, ['recommend', '--json']));
    const id = first.recommendations.find((r) => r.kind === 'recipe' && r.params.length === 0).id;
    assert.equal(cli(home, ['apply', '--recipe', id]).status, 0);
    await sleep(50);
    writeJson(extra, { recipes: [recipe('x')] });
    const again = json(cli(home, ['recommend', '--json', '--add', extra]));
    assert.ok(ids(again.alreadyApplied).includes(id));
    assert.ok(!ids(again.recommendations).includes(id));
  });
});
