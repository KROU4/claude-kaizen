// The instructions in agents/*.md and skills/*/SKILL.md must match what the engine really writes and what the
// `claude` CLI really checks. These tests pin the claims that were wrong once: the shape of the manifest, what
// `claude plugin validate` accepts, and how drafts of the analyst reach `apply`.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT, cleanupTempDirs, makeTempDir, materializeHome, runCli, writeJson } from './helpers.mjs';

after(() => cleanupTempDirs());

const read = (...p) => fs.readFileSync(path.join(KIT_ROOT, ...p), 'utf8');
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

describe('kaizen-analyst: drafts travel as custom.* recipes in the extra recipes file', () => {
  const text = read('agents', 'kaizen-analyst.md');
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);

  it('does not hand drafts over as paramDefaults (dropped when the catalog recipe is not recommended)', () => {
    assert.ok(!/"paramDefaults"\s*:\s*\{\s*\n?\s*"claude-md\.corrections"/.test(text));
    assert.match(text, /at most 3 skills/);
    assert.ok(example.recipes.every((r) => /^custom\./.test(r.id)));
    assert.ok(example.recipes.some((r) => r.actions[0].type === 'claude-md.block'));
    assert.ok(example.recipes.some((r) => r.actions[0].type === 'skill'));
  });

  it('the example file is accepted by recommend --add even when no catalog threshold is met, and several skills apply together', () => {
    const home = measured();
    const skill = example.recipes.find((r) => r.actions[0].type === 'skill');
    const second = JSON.parse(JSON.stringify(skill).replaceAll('deploy-check', 'review-pr'));
    const extra = path.join(home.root, 'extra-recipes.json');
    writeJson(extra, { ...example, recipes: [...example.recipes, second] });

    const ids = example.recipes.map((r) => r.id).concat(second.id);
    const recs = json(cli(home, ['recommend', '--json', '--add', extra])).recommendations.map((r) => r.id);
    for (const id of ids) assert.ok(recs.includes(id), `${id} is offered: ${recs.join(', ')}`);

    const rules = example.recipes.find((r) => r.actions[0].type === 'claude-md.block').id;
    const picked = [rules, skill.id, second.id].join(',');
    const dry = cli(home, ['apply', '--recipe', picked, '--add', extra, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    const real = cli(home, ['apply', '--recipe', picked, '--add', extra, '--json']);
    assert.equal(real.status, 0, real.stderr);
    for (const name of ['deploy-check', 'review-pr']) assert.ok(fs.existsSync(path.join(home.configDir, 'skills', name, 'SKILL.md')), `${name} was created`);
    assert.match(fs.readFileSync(path.join(home.configDir, 'CLAUDE.md'), 'utf8'), /kaizen:start corrections/);
  });
});

describe('kaizen-verifier: checks match the manifest that apply writes', () => {
  const text = read('agents', 'kaizen-verifier.md');

  it('skills and agents are recorded as `file` entries, and the verifier says so', () => {
    const home = measured();
    const extra = path.join(home.root, 'extra-recipes.json');
    writeJson(extra, {
      recipes: [
        { id: 'custom.s', category: 'skills', impact: 'low', title: { en: 's', ru: 's' }, why: { en: 'w', ru: 'w' }, evidence: { en: 'e', ru: 'e' }, when: true, actions: [{ type: 'skill', name: 'one', content: '---\nname: one\ndescription: d\n---\n\nbody\n' }, { type: 'agent', name: 'kz-agent', content: '---\nname: kz-agent\ndescription: d\n---\n\nbody\n' }] },
      ],
    });
    json(cli(home, ['recommend', '--json', '--add', extra]));
    const applied = cli(home, ['apply', '--recipe', 'custom.s', '--add', extra, '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const manifest = JSON.parse(applied.stdout.slice(applied.stdout.indexOf('{\n')));
    const types = manifest.recipes.flatMap((r) => r.actions.map((a) => a.type));
    assert.deepEqual(types, ['file', 'file'], 'no entry of type skill or agent exists');
    assert.ok(!/`skill` or `agent` action/.test(text), 'check 4 must not look for skill/agent entries');
    assert.match(text, /`file` entr(?:y|ies) whose path ends in `SKILL\.md` inside a `skills\/<name>\/` folder/);
    assert.match(text, /ends in `\.md` inside an `agents\/` folder/);
    // the rule must not depend on the separator: apply records these two kinds with the platform's (`\` on Windows)
    assert.match(text, /treat `\\` and `\/` as the same separator/);
    const toRuleShape = (file) => file.replace(/\\/g, '/');
    const files = manifest.recipes.flatMap((r) => r.actions.map((a) => a.file));
    assert.ok(files.some((f) => /\/skills\/one\/SKILL\.md$/.test(toRuleShape(f))), files.join('\n'));
    assert.ok(files.some((f) => /\/agents\/kz-agent\.md$/.test(toRuleShape(f))), files.join('\n'));
  });

  it('settings.hook.remove is checked for absence, not presence', () => {
    assert.match(text, /settings\.hook\.remove[^\n]*\n?[^\n]*\*\*absent\*\*/);
    assert.match(text, /never report a removed hook as missing/);
  });

  it('plugins.disable is checked against enabledPlugins', () => {
    assert.match(text, /enabledPlugins\[<plugin>\] === false/);
  });
});

describe('claude plugin validate is used where it works', () => {
  const instructions = ['agents/kaizen-verifier.md', 'skills/start/SKILL.md', 'skills/apply/SKILL.md'].map((f) => read(...f.split('/'))).join('\n');

  it('no instruction points it at a skill folder or a bare skills/agents folder', () => {
    assert.ok(!/plugin validate <its directory>/.test(instructions));
    assert.ok(!/on the parent skills\/agents directory/.test(instructions));
    assert.ok(!/Bash\(claude plugin validate/.test(read('skills', 'start', 'SKILL.md')), 'start no longer runs it itself');
    assert.match(read('agents', 'kaizen-verifier.md'), /scratch/);
  });

  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  const scratch = (agent) => {
    const dir = makeTempDir('kaizen-validate-');
    const w = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    w('skills/probe/SKILL.md', '---\nname: probe\ndescription: probe\n---\n\nbody\n');
    w('agents/helper.md', agent);
    return dir;
  };
  const validate = (dir) => spawnSync('claude', ['plugin', 'validate', dir, '--strict'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 60000 });

  it('a scratch folder with skills/ and agents/ accepts good files and rejects a broken agent', { skip: claude.status !== 0 && 'claude CLI is not installed' }, () => {
    const good = validate(scratch('---\nname: helper\ndescription: does a thing\n---\n\nbody\n'));
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const bad = validate(scratch('no frontmatter at all\n'));
    assert.notEqual(bad.status, 0, 'a broken agent file fails');
    assert.match(bad.stdout + bad.stderr, /helper\.md/);
  });
});

describe('start: analyst drafts replace the catalog recipes of the same job', () => {
  const text = read('skills', 'start', 'SKILL.md');
  it('says to offer custom.corrections-rules and custom.skill-* and to check every id comes back', () => {
    assert.match(text, /custom\.corrections-rules/);
    assert.match(text, /custom\.skill-/);
    assert.match(text, /each custom id the analyst reported is in the output/);
  });
  it('keeps smith for the case where no analyst draft exists', () => {
    assert.match(text, /no analyst draft covers them/);
  });
  it('checks recommendations[].id, not alreadyApplied, and says what to do with a custom id found only there', () => {
    assert.match(text, /in `recommendations\[\]\.id` specifically/);
    assert.match(text, /only under `alreadyApplied`/);
    assert.match(text, /apply --recipe <id> --add <state>\/extra-recipes\.json/);
  });
});

describe('analyst: custom ids are stable and a rewritten file re-offers them', () => {
  it('tells the analyst to keep the ids and write the file fresh', () => {
    assert.match(read('agents', 'kaizen-analyst.md'), /Keep the same ids on every run/);
  });
});

describe('apply skill: custom recipes always get --add with the named file', () => {
  const text = read('skills', 'apply', 'SKILL.md');
  it('names the extra recipes file and does not leave it to Kaizen to remember the path', () => {
    assert.match(text, /add `--add <state>\/extra-recipes\.json`/);
    assert.ok(!/usually reloads on its own/.test(text));
  });
  it('keeps the file in the refresh of step 1 and the listing of step 2, which would otherwise erase the remembered path', () => {
    const step1 = /^1\. .*$/m.exec(text)[0];
    assert.match(step1, /recommend --json[^\n]*--add <state>\/extra-recipes\.json/);
    assert.match(/^2\. .*$/m.exec(text)[0], /recommend --all --json` \(with the same `--add`/);
  });
  it('the sequence the skill prescribes keeps a custom recipe applicable', () => {
    const home = measured();
    const extra = path.join(home.configDir, 'kaizen', 'extra-recipes.json');
    writeJson(extra, { recipes: [{ id: 'custom.house-rules', category: 'claude-md', impact: 'high', title: { en: 'h', ru: 'h' }, why: { en: 'w', ru: 'w' }, evidence: { en: 'e', ru: 'e' }, when: true, actions: [{ type: 'claude-md.block', id: 'house-rules', content: '- one rule\n' }] }] });
    json(cli(home, ['recommend', '--json', '--add', extra]));
    json(cli(home, ['recommend', '--json', '--add', extra]));
    json(cli(home, ['recommend', '--all', '--json', '--add', extra]));
    const dry = cli(home, ['apply', '--recipe', 'custom.house-rules', '--add', extra, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!dry.stdout.includes('unknown recipe'), dry.stdout);
  });
});

