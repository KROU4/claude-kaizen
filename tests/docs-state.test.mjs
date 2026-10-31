// What the instructions (skills, agents, AGENTS.md, README, FAQ) say about the state directory, undo and deleting the
// folder must match what the CLI does. Hermetic: child processes see a temp config dir and state dir.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT, cleanupTempDirs, materializeHome, readJson, runCli } from './helpers.mjs';

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

describe('state directory: instructions read the path the CLI reports, never a fixed ~/.claude/kaizen', () => {
  const files = ['agents/kaizen-analyst.md', 'agents/kaizen-smith.md', 'agents/kaizen-verifier.md', 'AGENTS.md', ...fs.readdirSync(path.join(KIT_ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`)];

  it('no instruction names a file under ~/.claude/kaizen/ (KAIZEN_STATE_DIR and CLAUDE_CONFIG_DIR move the folder)', () => {
    for (const f of files) assert.ok(!/~\/\.claude\/kaizen\//.test(read(...f.split('/'))), `${f} hard-codes a state path`);
  });

  it('start, measure and apply take the folder from `paths` and mention the override variable', () => {
    for (const f of ['skills/start/SKILL.md', 'skills/measure/SKILL.md', 'skills/apply/SKILL.md']) {
      const text = read(...f.split('/'));
      assert.match(text, /scripts\/kaizen\.mjs" paths/, f);
      assert.match(text, /KAIZEN_STATE_DIR/, f);
    }
    assert.match(read('AGENTS.md'), /`paths` → take `stateDir` and `measureMd`/);
    for (const f of ['agents/kaizen-analyst.md', 'agents/kaizen-smith.md']) assert.match(read(...f.split('/')), /never substitute `~\/\.claude\/kaizen`/, f);
  });

  it('the digest the skills read is where `measure --quiet` (silent) wrote it, also with KAIZEN_STATE_DIR set', () => {
    const home = materializeHome({ projects: true, usageData: true });
    const m = cli(home, ['measure', '--all', '--quiet']);
    assert.equal(m.stdout, '');
    const p = json(cli(home, ['paths']));
    assert.ok(fs.existsSync(p.measureMd) && fs.existsSync(p.measureJson));
    assert.match(fs.readFileSync(p.measureMd, 'utf8'), /^# /);
    assert.ok(!fs.existsSync(path.join(home.home, '.claude', 'kaizen', 'measure.md')) || path.resolve(p.measureMd) !== path.join(home.home, '.claude', 'kaizen', 'measure.md'));
  });
});

describe('start skill, mode B: only a submission of this run is applied', () => {
  const text = read('skills', 'start', 'SKILL.md');
  it('continues only after exit code 0 with an "ok":true line, and treats a timeout as no selection', () => {
    assert.match(text, /\*\*only if\*\* it exited with code 0 and printed a line with `"ok":true`/);
    assert.match(text, /`"timedOut":true`, exit code 3/);
    assert.match(text, /do not run `apply`/);
    assert.match(text, /choices\.previous\.json/);
  });
});

describe('undo skill: re-applying keeps the parameters, the backup path is real, several batches are explained', () => {
  const text = read('skills', 'undo', 'SKILL.md');

  it('re-applies with apply --from-batch, not a bare apply --recipe', () => {
    assert.match(text, /apply --from-batch <id> --recipe <ids to keep>/);
    assert.match(text, /a plain `apply --recipe <ids>` would fall back to the defaults/);
  });

  it('names the real folder of the backups a forced undo makes (applied/<id>/undo/<run>/backups/)', () => {
    assert.match(text, /applied\/<id>\/undo\/<run>\/backups\//);
    assert.ok(!/undo\/backups\//.test(text));
    const home = measured();
    const first = cli(home, ['apply', '--recipe', 'claude-md.corrections', '--param', 'claude-md.corrections.rules=- one rule']);
    assert.equal(first.status, 0, first.stderr);
    const id = json(cli(home, ['status'])).applied[0].id;
    const mdFile = path.join(home.configDir, 'CLAUDE.md');
    fs.writeFileSync(mdFile, fs.readFileSync(mdFile, 'utf8').replace('- one rule', '- one rule edited by hand'));
    assert.equal(cli(home, ['undo', id]).status, 0);
    assert.equal(cli(home, ['undo', id, '--force']).status, 0);
    const undoDir = path.join(home.stateDir, 'applied', id, 'undo');
    const runs = fs.readdirSync(undoDir);
    assert.ok(runs.some((r) => fs.existsSync(path.join(undoDir, r, 'backups'))), `backups sit in a folder per undo run: ${runs.join(', ')}`);
    assert.ok(!fs.existsSync(path.join(undoDir, 'backups')));
  });

  it('says one run can leave several batches; the AGENTS.md short version agrees instead of promising that undo --last reverts the run', () => {
    assert.match(text, /several batches/);
    assert.match(text, /undo --all/);
    const agents = read('AGENTS.md');
    assert.ok(!/6\. Explain `undo --last`\./.test(agents));
    assert.match(agents, /`undo --last` reverts only the newest one/);
    assert.match(agents, /`undo <id>` for each, newest first, or `undo --all`/);
    assert.match(agents, /apply --from-batch <id> --recipe/);
  });

  it('a run of two applies leaves two batches and `undo --last` reverts only the newest (what the docs warn about)', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'settings.cleanup-period']).status, 0);
    assert.equal(cli(home, ['apply', '--recipe', 'claude-md.corrections', '--param', 'claude-md.corrections.rules=- r']).status, 0);
    const ids = json(cli(home, ['status'])).applied.map((a) => a.id);
    assert.equal(ids.length, 2);
    assert.equal(cli(home, ['undo', '--last']).status, 0);
    const after = json(cli(home, ['status'])).applied;
    assert.deepEqual(after.map((a) => a.undone), [false, true], 'only the newest batch is undone');
    assert.equal(cli(home, ['undo', '--all']).status, 0);
    assert.ok(json(cli(home, ['status'])).applied.every((a) => a.undone));
  });
});

describe('docs: deleting the state folder', () => {
  const docs = { 'docs/faq.md': read('docs', 'faq.md'), 'README.md': read('README.md'), 'README.ru.md': read('README.ru.md') };

  it('nobody advises deleting it as a harmless reset', () => {
    assert.ok(!/installed hooks keep working until you `undo` them/.test(docs['docs/faq.md']));
    assert.ok(!/Delete the folder to forget everything/.test(docs['README.md']));
    assert.ok(!/Удалите папку, и Kaizen забудет всё/.test(docs['README.ru.md']));
  });

  it('says undo --all comes first and what breaks otherwise (the hook scripts and the journal live there)', () => {
    for (const [name, text] of Object.entries(docs)) assert.match(text, /undo --all/, name);
    assert.match(docs['docs/faq.md'], /`undo` can no longer find what to remove/);
    assert.match(docs['README.md'], /makes `undo` impossible/);
    assert.match(docs['README.ru.md'], /`undo` станет невозможен/);
  });

  it('it is true: with the folder gone the hook script is gone, settings.json still points to it and undo cannot remove the entry', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive']).status, 0);
    const script = path.join(home.stateDir, 'hooks', 'guard-destructive.mjs');
    const settings = () => JSON.stringify(readJson(home.settingsFile));
    assert.ok(fs.existsSync(script));
    assert.ok(settings().includes('guard-destructive.mjs'));
    fs.rmSync(home.stateDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(script), 'the hook script lived in the folder');
    assert.ok(settings().includes('guard-destructive.mjs'), 'settings.json still points to it');
    cli(home, ['undo', '--all']);
    assert.ok(settings().includes('guard-destructive.mjs'), 'the dangling entry stays: undo had no journal');
  });

  it('and the order the docs give works: undo --all first removes the entry, then the folder can go', () => {
    const home = measured();
    assert.equal(cli(home, ['apply', '--recipe', 'hooks.guard-destructive']).status, 0);
    assert.equal(cli(home, ['undo', '--all']).status, 0);
    assert.ok(!JSON.stringify(readJson(home.settingsFile)).includes('guard-destructive.mjs'));
  });
});
