// scripts/lib/apply.mjs: every action handler, its undo, and the cmdApply / cmdUndo flows with the journal.
//
// Isolation: every test gets a fresh throw-away home (settings.json, CLAUDE.md, skills, agents, plugins and a
// ~/.claude.json copied from tests/fixtures) and its own KAIZEN_STATE_DIR. The environment variables are set before
// the module is imported and before every test; apply.mjs reads them at call time.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, recommend } from '../scripts/lib/recipes.mjs';
import { KIT_ROOT, buildFixtureMeasure, captureOutput, cleanupTempDirs, makeTempDir, materializeHome, prefixOf, readJson, setEnv, snapshotDir, t, toPosix, writeJson, writeText } from './helpers.mjs';

let apply;
let fixtureMeasure;
let ctx; // the home of the running test
let restoreEnv;
let originalCwd;

before(async () => {
  originalCwd = process.cwd();
  const boot = materializeHome();
  const restore = setEnv({ ...boot.env, CLAUDE_PROJECT_DIR: undefined });
  try {
    apply = await import('../scripts/lib/apply.mjs');
  } finally {
    restore();
  }
  ({ measure: fixtureMeasure } = await buildFixtureMeasure());
});

beforeEach(() => {
  ctx = materializeHome();
  restoreEnv = setEnv({ ...ctx.env, CLAUDE_PROJECT_DIR: undefined });
  // cmdApply falls back to the working directory as "the project": keep it away from the real repository
  process.chdir(ctx.root);
});

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnv();
});
after(() => cleanupTempDirs());

// ------------------------------------------------------------------ helpers

const handlers = () => apply.__test.handlers;
const appliedDir = () => path.join(ctx.stateDir, 'applied');
const samePath = (a, b) => toPosix(path.resolve(a)) === toPosix(path.resolve(b));
const readSettings = () => readJson(ctx.settingsFile);
const writeSettings = (data) => writeJson(ctx.settingsFile, data);
const read = (file) => fs.readFileSync(file, 'utf8');

function newCtx({ scope = 'user', projectDir = null, params = {} } = {}) {
  return apply.buildContext({ scope, projectDir, params });
}

function newIo(opts = {}) {
  return apply.__test.makeIo({ dry: false, force: false, measure: fixtureMeasure, batchDir: path.join(ctx.stateDir, 'applied', 'unit'), recipeId: 'unit.recipe', ...opts });
}

/** Run one handler the way cmdApply does and return {entry, io, ctx}. */
function run(type, action, { scope, projectDir, params, io } = {}) {
  const c = newCtx({ scope, projectDir, params });
  const i = io || newIo();
  return { entry: handlers()[type](action, c, i), io: i, ctx: c };
}

/** Undo one journal entry the way cmdUndo does. */
function undoEntry(entry, opts = {}) {
  const io = newIo({ force: true, measure: null, recipeId: null, ...opts });
  return { result: apply.__test.undoEntry(entry, io), io };
}

function seedState(measure = fixtureMeasure) {
  writeJson(path.join(ctx.stateDir, 'measure.json'), measure);
  const res = recommend(loadCatalog(), measure, { includeAll: true });
  writeJson(path.join(ctx.stateDir, 'recommendations.json'), { generatedAt: '2026-10-30T10:00:00.000Z', lang: 'en', recommendations: res.recommended, alreadyApplied: [], notApplicable: 0 });
}

async function runApply(flags, { measure = fixtureMeasure, lang = 'en', positional = [] } = {}) {
  const out = await captureOutput(() => apply.cmdApply({ _: ['apply', ...positional], flags }, { loadMeasure: () => measure, pickLang: () => lang }));
  return { manifest: out.result, stdout: out.stdout };
}

async function runUndo(flags = {}, positional = []) {
  const out = await captureOutput(() => apply.cmdUndo({ _: ['undo', ...positional], flags }, { pickLang: () => 'en' }));
  return { result: out.result, stdout: out.stdout };
}

const manifestIds = () => (fs.existsSync(appliedDir()) ? fs.readdirSync(appliedDir()).sort() : []);
const readManifest = (id) => readJson(path.join(appliedDir(), id, 'manifest.json'));

/** Freeze `new Date()` / Date.now() while fn runs (two applies in the same second are a real-world case). */
async function withFrozenDate(iso, fn) {
  const RealDate = Date;
  const fixed = RealDate.parse(iso);
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Every file below `root` as rel path -> parsed JSON (for *.json) or text. */
function readTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = null;
        walk(full, r);
      } else if (e.name.endsWith('.json')) out[r] = JSON.parse(fs.readFileSync(full, 'utf8'));
      else out[r] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root, '');
  return out;
}

// ------------------------------------------------------------------ small pure helpers

describe('path helpers', () => {
  const T = () => apply.__test;

  it('getPath reads nested values and returns undefined for anything missing', () => {
    assert.equal(T().getPath({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
    assert.equal(T().getPath({ a: 1 }, 'a.b'), undefined);
    assert.equal(T().getPath({}, 'x.y.z'), undefined);
    assert.equal(T().getPath({ a: null }, 'a.b'), undefined);
  });

  it('setPath creates missing objects and overwrites scalars on the way', () => {
    const o = {};
    T().setPath(o, 'a.b.c', 5);
    assert.deepEqual(o, { a: { b: { c: 5 } } });
    T().setPath(o, 'a.b.d', 6);
    assert.deepEqual(o, { a: { b: { c: 5, d: 6 } } });
    const scalar = { a: 1 };
    T().setPath(scalar, 'a.b', 2);
    assert.deepEqual(scalar, { a: { b: 2 } });
  });

  it('deletePath removes only the leaf and tolerates missing parents', () => {
    const o = { a: { b: 1, c: 2 } };
    T().deletePath(o, 'a.b');
    assert.deepEqual(o, { a: { c: 2 } });
    assert.doesNotThrow(() => T().deletePath(o, 'x.y.z'));
  });

  it('hookIdentity combines the hook type and its command or prompt', () => {
    assert.equal(T().hookIdentity({ command: 'node x.mjs' }), 'command|node x.mjs');
    assert.equal(T().hookIdentity({ type: 'prompt', prompt: 'Check it' }), 'prompt|Check it');
    assert.equal(T().hookIdentity({}), 'command|');
  });

  it('sha is a stable 16-character hex digest', () => {
    assert.match(T().sha('abc'), /^[0-9a-f]{16}$/);
    assert.equal(T().sha('abc'), T().sha('abc'));
    assert.notEqual(T().sha('abc'), T().sha('abd'));
  });
});

describe('buildContext, fill and renderTemplate', () => {
  it('resolves the user-scope locations from CLAUDE_CONFIG_DIR and KAIZEN_STATE_DIR', () => {
    const c = newCtx();
    assert.equal(c.scope, 'user');
    assert.equal(c.kaizenHome, toPosix(ctx.stateDir));
    assert.equal(c.configDir, toPosix(ctx.configDir));
    assert.equal(c.skillsDir, toPosix(path.join(ctx.configDir, 'skills')));
    assert.equal(c.agentsDir, toPosix(path.join(ctx.configDir, 'agents')));
    assert.equal(c.claudeMd, toPosix(path.join(ctx.configDir, 'CLAUDE.md')));
    assert.ok(samePath(c.settingsFile, path.join(ctx.configDir, 'settings.json')));
    assert.ok(samePath(c.globalConfig, ctx.claudeJson));
    assert.equal(c.projectDir, '');
  });

  it('resolves the project-scope locations under the project directory', () => {
    const project = makeTempDir('kaizen-proj-');
    const c = newCtx({ scope: 'project', projectDir: project });
    assert.equal(c.projectDir, toPosix(path.resolve(project)));
    assert.ok(samePath(c.settingsFile, path.join(project, '.claude', 'settings.json')));
    assert.equal(c.claudeMd, toPosix(path.join(path.resolve(project), 'CLAUDE.md')));
    assert.equal(c.skillsDir, toPosix(path.join(path.resolve(project), '.claude', 'skills')));
  });

  it('refuses project scope without a project directory', () => {
    assert.throws(() => newCtx({ scope: 'project' }), /project scope requested but no project directory/);
  });

  it('quotes the Node path only when it contains spaces, and always uses forward slashes', () => {
    const c = newCtx();
    assert.ok(!c.node.includes('\\'));
    assert.equal(/\s/.test(process.execPath), c.node.startsWith('"'));
  });

  it('fill replaces known placeholders and {params.x}, leaving unknown ones alone', () => {
    const c = newCtx({ params: { name: 'demo', list: ['a', 'b'], empty: null } });
    assert.equal(apply.fill('{kaizenHome}/x/{params.name}', c), `${c.kaizenHome}/x/demo`);
    assert.equal(apply.fill('{params.list}', c), 'a,b');
    assert.equal(apply.fill('[{params.empty}][{params.missing}]', c), '[][]');
    assert.equal(apply.fill('{unknown} {params}', c), '{unknown} {params}');
    assert.equal(apply.fill(42, c), 42);
  });

  it('renderTemplate fills {{param}} placeholders, joins arrays and keeps unfilled ones', () => {
    assert.equal(apply.renderTemplate('{{a}} {{b}} {{c}} {{d}}', { a: 'x', b: ['1', '2'], c: undefined, d: null }), 'x 1,2 {{c}} {{d}}');
    assert.equal(apply.renderTemplate('no placeholders', {}), 'no placeholders');
  });
});

// ------------------------------------------------------------------ settings.hook

describe('settings.hook', () => {
  const action = (over = {}) => ({ type: 'settings.hook', event: 'PreToolUse', matcher: 'Bash', command: '{node} "{kaizenHome}/hooks/x.mjs"', timeout: 10, ...over });

  it('adds a hook group with the placeholders filled in and keeps the existing hooks', () => {
    const before = readSettings();
    const { entry, ctx: c } = run('settings.hook', action());
    const after = readSettings();
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${c.node} "${c.kaizenHome}/hooks/x.mjs"`, timeout: 10 }] }]);
    assert.deepEqual(after.hooks.PostToolUse, before.hooks.PostToolUse);
    assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
    assert.deepEqual(after.permissions, before.permissions);
    assert.equal(entry.type, 'settings.hook');
    assert.equal(entry.event, 'PreToolUse');
    assert.equal(entry.matcher, 'Bash');
    assert.ok(samePath(entry.file, ctx.settingsFile));
  });

  it('is idempotent: the second apply skips and leaves the file untouched', () => {
    run('settings.hook', action());
    const bytes = read(ctx.settingsFile);
    const { entry } = run('settings.hook', action());
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'hook already present');
    assert.equal(read(ctx.settingsFile), bytes);
    assert.equal(readSettings().hooks.PreToolUse.length, 1);
  });

  it('treats the same command under a matcher it already covers as already present', () => {
    run('settings.hook', action({ matcher: 'Bash|Edit' }));
    const { entry } = run('settings.hook', action({ matcher: 'Edit' }));
    assert.equal(entry.skipped, true);
    assert.equal(run('settings.hook', action({ matcher: undefined })).entry.skipped, true);
    assert.equal(readSettings().hooks.PreToolUse.length, 1);
  });

  it('adds only the matcher alternatives that are still missing for the same command, and undo removes only those', () => {
    const first = run('settings.hook', action({ matcher: 'compact|resume|fork' }));
    const second = run('settings.hook', action({ matcher: 'startup|resume|clear|compact|fork' }));
    assert.equal(second.entry.skipped, undefined);
    assert.equal(second.entry.matcher, 'startup|clear');
    const groups = readSettings().hooks.PreToolUse;
    assert.deepEqual(groups.map((g) => g.matcher), ['compact|resume|fork', 'startup|clear']);
    assert.equal(undoEntry(second.entry).result, 'ok');
    assert.deepEqual(readSettings().hooks.PreToolUse.map((g) => g.matcher), ['compact|resume|fork']);
    assert.equal(undoEntry(first.entry).result, 'ok');
    assert.equal(readSettings().hooks.PreToolUse, undefined);
  });

  it('a recipe whose matcher is a subset of an installed one adds nothing (no double firing)', () => {
    run('settings.hook', action({ matcher: 'startup|resume|clear|compact|fork' }));
    const { entry } = run('settings.hook', action({ matcher: 'compact|resume|fork' }));
    assert.equal(entry.skipped, true);
    assert.equal(readSettings().hooks.PreToolUse.length, 1);
  });

  it('writes matcher-less groups, async and if options when given', () => {
    run('settings.hook', action({ matcher: undefined, async: true, if: 'Bash(git push *)', event: 'Stop', command: 'echo done' }));
    const group = readSettings().hooks.Stop.at(-1);
    assert.equal(group.matcher, undefined);
    assert.deepEqual(group.hooks, [{ type: 'command', command: 'echo done', timeout: 10, async: true, if: 'Bash(git push *)' }]);
  });

  it('creates settings.json when it does not exist', () => {
    fs.rmSync(ctx.settingsFile);
    run('settings.hook', action());
    assert.deepEqual(Object.keys(readSettings()), ['hooks']);
  });

  it('writes nothing in dry-run mode but still describes the change', () => {
    const bytes = read(ctx.settingsFile);
    const io = newIo({ dry: true });
    const { entry } = run('settings.hook', action(), { io });
    assert.equal(entry.type, 'settings.hook');
    assert.equal(read(ctx.settingsFile), bytes);
    assert.equal(io.described.length, 1);
    assert.match(io.described[0], /add PreToolUse hook \[Bash\]/);
  });

  it('fails loudly on a corrupt settings.json and does not touch it', () => {
    writeText(ctx.settingsFile, '{ "hooks": ');
    assert.throws(() => run('settings.hook', action()), SyntaxError);
    assert.equal(read(ctx.settingsFile), '{ "hooks": ');
  });

  it('backs up the previous settings.json into the batch directory', () => {
    const bytes = read(ctx.settingsFile);
    run('settings.hook', action());
    const backups = path.join(ctx.stateDir, 'applied', 'unit', 'backups');
    const files = fs.readdirSync(backups);
    assert.equal(files.length, 1);
    assert.equal(read(path.join(backups, files[0])), bytes);
  });

  describe('undo', () => {
    it('removes exactly that hook and keeps the others', () => {
      const { entry } = run('settings.hook', action());
      const { result } = undoEntry(entry);
      assert.equal(result, 'ok');
      const s = readSettings();
      assert.equal(s.hooks.PreToolUse, undefined);
      assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'npx prettier --write');
      assert.equal(s.hooks.Stop.length, 1);
    });

    it('removes the hooks object when it was the only hook', () => {
      writeSettings({ permissions: { allow: [] } });
      const { entry } = run('settings.hook', action());
      undoEntry(entry);
      assert.deepEqual(readSettings(), { permissions: { allow: [] } });
    });

    it('leaves sibling hooks of the same event in place', () => {
      const first = run('settings.hook', action({ command: 'first' }));
      run('settings.hook', action({ command: 'second', matcher: 'Edit' }));
      undoEntry(first.entry);
      assert.deepEqual(readSettings().hooks.PreToolUse.map((g) => g.hooks[0].command), ['second']);
    });

    it('reports when the hook list or the hook is already gone', () => {
      const { entry } = run('settings.hook', action());
      undoEntry(entry);
      assert.equal(undoEntry(entry).result, 'hook list missing');
      writeSettings({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'other' }] }] } });
      assert.equal(undoEntry(entry).result, 'hook was already gone');
    });
  });
});

// ------------------------------------------------------------------ settings.set

describe('settings.set', () => {
  const action = (over = {}) => ({ type: 'settings.set', path: 'cleanupPeriodDays', value: 90, ...over });

  it('sets a key that did not exist and remembers that it did not', () => {
    const { entry } = run('settings.set', action());
    assert.equal(readSettings().cleanupPeriodDays, 90);
    assert.equal(entry.hadPrevious, false);
    assert.equal(entry.previous, null);
    assert.equal(entry.value, 90);
  });

  it('journals the previous value of a key that existed', () => {
    writeSettings({ ...readSettings(), cleanupPeriodDays: 30 });
    const { entry } = run('settings.set', action());
    assert.equal(readSettings().cleanupPeriodDays, 90);
    assert.equal(entry.hadPrevious, true);
    assert.equal(entry.previous, 30);
  });

  it('undo restores the previous value', () => {
    writeSettings({ ...readSettings(), cleanupPeriodDays: 30 });
    const { entry } = run('settings.set', action());
    assert.equal(undoEntry(entry).result, 'ok');
    assert.equal(readSettings().cleanupPeriodDays, 30);
  });

  it('undo deletes a key that did not exist before (it does not leave null behind)', () => {
    const { entry } = run('settings.set', action());
    assert.equal(undoEntry(entry).result, 'ok');
    assert.ok(!('cleanupPeriodDays' in readSettings()));
  });

  it('undo keeps a value the user changed after the apply', () => {
    const { entry } = run('settings.set', action());
    writeSettings({ ...readSettings(), cleanupPeriodDays: 14 });
    assert.equal(undoEntry(entry).result, 'kept: cleanupPeriodDays changed since apply');
    assert.equal(readSettings().cleanupPeriodDays, 14);
  });

  it('skips when the value is already what it should be', () => {
    run('settings.set', action());
    const bytes = read(ctx.settingsFile);
    const { entry } = run('settings.set', action());
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'already set');
    assert.equal(read(ctx.settingsFile), bytes);
  });

  it('creates nested objects for a dotted path', () => {
    run('settings.set', action({ path: 'a.b.c', value: true }));
    assert.deepEqual(readSettings().a, { b: { c: true } });
  });

  it('fills placeholders inside object values', () => {
    const { entry } = run('settings.set', action({ path: 'statusLine', value: { type: 'command', command: 'node "{kaizenHome}/statusline.mjs"', padding: 0 } }));
    assert.equal(readSettings().statusLine.command, `node "${toPosix(ctx.stateDir)}/statusline.mjs"`);
    assert.equal(entry.value.padding, 0);
  });

  it('writes nothing in dry-run mode', () => {
    const bytes = read(ctx.settingsFile);
    const io = newIo({ dry: true });
    run('settings.set', action(), { io });
    assert.equal(read(ctx.settingsFile), bytes);
    assert.match(io.described[0], /set cleanupPeriodDays = 90/);
  });

  it('writes to the project settings file for project scope', () => {
    const project = makeTempDir('kaizen-proj-');
    run('settings.set', action(), { scope: 'project', projectDir: project });
    assert.equal(readJson(path.join(project, '.claude', 'settings.json')).cleanupPeriodDays, 90);
    assert.ok(!('cleanupPeriodDays' in readSettings()));
  });
});

// ------------------------------------------------------------------ settings.append

describe('settings.append', () => {
  const action = (over = {}) => ({ type: 'settings.append', path: 'permissions.deny', values: ['Read(./.env)', 'Read(~/.ssh/**)'], ...over });

  it('appends the values to an existing list', () => {
    const { entry } = run('settings.append', action());
    assert.deepEqual(readSettings().permissions.deny, ['Read(./.env)', 'Read(~/.ssh/**)']);
    assert.deepEqual(entry.added, ['Read(./.env)', 'Read(~/.ssh/**)']);
  });

  it('adds only the values that are not already in the list', () => {
    const { entry } = run('settings.append', action({ path: 'permissions.allow', values: ['Bash(git diff:*)', 'Bash(git status:*)'] }));
    assert.deepEqual(readSettings().permissions.allow, ['Bash(git diff:*)', 'Read(./docs/**)', 'Bash(git status:*)']);
    assert.deepEqual(entry.added, ['Bash(git status:*)']);
  });

  it('undo removes exactly the added items and keeps a pre-existing duplicate', () => {
    const { entry } = run('settings.append', action({ path: 'permissions.allow', values: ['Bash(git diff:*)', 'Bash(git status:*)'] }));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.deepEqual(readSettings().permissions.allow, ['Bash(git diff:*)', 'Read(./docs/**)']);
  });

  it('undo keeps items the user added in the meantime', () => {
    const { entry } = run('settings.append', action());
    const s = readSettings();
    s.permissions.deny.push('Read(./secrets/**)');
    writeSettings(s);
    undoEntry(entry);
    assert.deepEqual(readSettings().permissions.deny, ['Read(./secrets/**)']);
  });

  it('skips when everything is already there', () => {
    run('settings.append', action());
    const { entry } = run('settings.append', action());
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'nothing new to add');
  });

  it('creates the list when it does not exist', () => {
    run('settings.append', action({ path: 'permissions.ask', values: ['Bash(rm *)'] }));
    assert.deepEqual(readSettings().permissions.ask, ['Bash(rm *)']);
  });

  it('replaces a non-array value with a new list', () => {
    writeSettings({ permissions: { deny: 'oops' } });
    run('settings.append', action());
    assert.deepEqual(readSettings().permissions.deny, ['Read(./.env)', 'Read(~/.ssh/**)']);
  });

  it('fills placeholders in the values', () => {
    run('settings.append', action({ values: ['Read({configDir}/secrets/**)'] }));
    assert.deepEqual(readSettings().permissions.deny, [`Read(${toPosix(ctx.configDir)}/secrets/**)`]);
  });

  describe('valuesFrom', () => {
    const measure = { tools: { suggestedAllowRules: [{ rule: 'Bash(git status:*)', count: 5 }, { rule: 'Bash(git diff:*)', count: 4 }, { rule: 'Bash(ls:*)', count: 3 }, { rule: 42 }, null] } };
    const from = (over = {}) => ({ type: 'settings.append', path: 'permissions.allow', valuesFrom: 'tools.suggestedAllowRules', field: 'rule', ...over });

    it('takes the named field of each item and ignores items that are not strings', () => {
      const { entry } = run('settings.append', from(), { io: newIo({ measure }) });
      assert.deepEqual(entry.added, ['Bash(git status:*)', 'Bash(ls:*)']);
      assert.deepEqual(readSettings().permissions.allow, ['Bash(git diff:*)', 'Read(./docs/**)', 'Bash(git status:*)', 'Bash(ls:*)']);
    });

    it('honours limit', () => {
      writeSettings({});
      const { entry } = run('settings.append', from({ limit: 2 }), { io: newIo({ measure }) });
      assert.deepEqual(entry.added, ['Bash(git status:*)', 'Bash(git diff:*)']);
    });

    it('accepts plain strings when no field is named, combined with literal values', () => {
      const m = { list: ['x', 'y'] };
      const { entry } = run('settings.append', { type: 'settings.append', path: 'tags', values: ['z'], valuesFrom: 'list' }, { io: newIo({ measure: m }) });
      assert.deepEqual(entry.added, ['z', 'x', 'y']);
    });

    it('skips when the measurement path does not exist', () => {
      const { entry } = run('settings.append', from({ valuesFrom: 'no.such.path' }), { io: newIo({ measure }) });
      assert.equal(entry.skipped, true);
    });
  });
});

// ------------------------------------------------------------------ claude-md.block

describe('claude-md.block', () => {
  const action = (over = {}) => ({ type: 'claude-md.block', id: 'read-before-edit', template: 'claude-md/read-before-edit.md', ...over });
  const claudeMd = () => path.join(ctx.configDir, 'CLAUDE.md');
  const START = '<!-- kaizen:start read-before-edit -->';
  const END = '<!-- kaizen:end read-before-edit -->';

  it('appends a marked block to the existing file after one blank line', () => {
    const original = read(claudeMd());
    const { entry } = run('claude-md.block', action());
    const text = read(claudeMd());
    assert.ok(text.startsWith(original.replace(/\s*$/, '')));
    const body = read(path.join(KIT_ROOT, 'recipes', 'templates', 'claude-md', 'read-before-edit.md')).trim();
    assert.ok(text.endsWith(`\n\n${START}\n${body}\n${END}\n`));
    assert.equal(entry.type, 'claude-md.block');
    assert.equal(entry.id, 'read-before-edit');
    assert.equal(entry.previousBlock, null);
    assert.equal(entry.existedBefore, true);
  });

  it('creates the file when it does not exist, without a leading blank line', () => {
    fs.rmSync(claudeMd());
    const { entry } = run('claude-md.block', action({ template: undefined, content: 'Rule one.' }));
    assert.equal(read(claudeMd()), `${START}\nRule one.\n${END}\n`);
    assert.equal(entry.existedBefore, false);
  });

  it('skips when the block is already there unchanged', () => {
    run('claude-md.block', action());
    const bytes = read(claudeMd());
    const { entry } = run('claude-md.block', action());
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'block unchanged');
    assert.equal(read(claudeMd()), bytes);
  });

  it('updates the block in place when its content changed (never a second block)', () => {
    run('claude-md.block', action({ template: undefined, content: 'Version one.' }));
    const { entry } = run('claude-md.block', action({ template: undefined, content: 'Version two.' }));
    const text = read(claudeMd());
    assert.equal(text.split(START).length - 1, 1);
    assert.ok(text.includes('Version two.'));
    assert.ok(!text.includes('Version one.'));
    assert.equal(entry.previousBlock, `${START}\nVersion one.\n${END}`);
  });

  it('keeps text with $-patterns ($&, $\', $`, $$) literal when it updates a block in place', () => {
    writeText(claudeMd(), 'Top.\n');
    run('claude-md.block', action({ template: undefined, content: 'Version one.' }));
    const tricky = "Use `$&`, `$'`, `$``, `$$` and $1 literally.";
    run('claude-md.block', action({ template: undefined, content: tricky }));
    assert.equal(read(claudeMd()), `Top.\n\n${START}\n${tricky}\n${END}\n`);
  });

  it('undo removes the block and leaves the rest of the file byte-identical', () => {
    const original = read(claudeMd());
    const { entry } = run('claude-md.block', action());
    assert.equal(undoEntry(entry).result, 'ok');
    assert.equal(read(claudeMd()), original);
  });

  it('undo does not reformat blank-line runs elsewhere in the file', () => {
    const original = '# Notes\n\nFirst section.\n\n\n\nSecond section after a wide gap.\n\n\nThird.\n';
    writeText(claudeMd(), original);
    const { entry } = run('claude-md.block', action());
    undoEntry(entry);
    assert.equal(read(claudeMd()), original);
  });

  it('undo restores the exact ending of the file: no trailing newline, extra blank lines, CRLF', () => {
    for (const original of ['# Notes\n\nNo newline at the end', '# Notes\n\n\n\n', '# Notes\r\n\r\nWindows endings\r\n', '\n\n']) {
      writeText(claudeMd(), original);
      const { entry } = run('claude-md.block', action({ template: undefined, content: 'Rule.' }));
      undoEntry(entry);
      assert.equal(read(claudeMd()), original, JSON.stringify(original));
    }
  });

  it('undo deletes a CLAUDE.md that the apply itself created instead of leaving a blank file', () => {
    fs.rmSync(claudeMd());
    const { entry } = run('claude-md.block', action({ template: undefined, content: 'Rule one.' }));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.ok(!fs.existsSync(claudeMd()));
  });

  it('undo keeps a CLAUDE.md that the user filled after the apply created it', () => {
    fs.rmSync(claudeMd());
    const { entry } = run('claude-md.block', action({ template: undefined, content: 'Rule one.' }));
    fs.appendFileSync(claudeMd(), '\nMy own notes.\n');
    undoEntry(entry);
    assert.equal(read(claudeMd()), '\nMy own notes.\n');
  });

  it('undo removes the block from the middle of a file the user kept editing', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action({ template: undefined, content: 'Rule.' }));
    fs.writeFileSync(claudeMd(), `${read(claudeMd())}\nAdded later by the user.\n`);
    undoEntry(entry);
    assert.equal(read(claudeMd()), 'Top.\n\nAdded later by the user.\n');
  });

  it('undo of an in-place update restores the previous version of the block', () => {
    writeText(claudeMd(), 'Top.\n');
    const first = run('claude-md.block', action({ template: undefined, content: 'Version one.' }));
    const second = run('claude-md.block', action({ template: undefined, content: 'Version two.' }));
    undoEntry(second.entry);
    assert.equal(read(claudeMd()), `Top.\n\n${START}\nVersion one.\n${END}\n`);
    undoEntry(first.entry);
    assert.equal(read(claudeMd()), 'Top.\n');
  });

  it('undo reports a missing file and a missing block', () => {
    const { entry } = run('claude-md.block', action());
    writeText(claudeMd(), 'The user replaced everything.\n');
    assert.equal(undoEntry(entry).result, 'block already gone');
    assert.equal(read(claudeMd()), 'The user replaced everything.\n');
    fs.rmSync(claudeMd());
    assert.equal(undoEntry(entry).result, 'file missing');
  });

  it('uses the recipe id as block id when the action has none', () => {
    const io = newIo({ recipeId: 'claude-md.diet' });
    run('claude-md.block', { type: 'claude-md.block', content: 'Short.' }, { io });
    assert.ok(read(claudeMd()).includes('<!-- kaizen:start claude-md.diet -->'));
  });

  it('fills {{param}} placeholders of the template and {params.x} of inline content', () => {
    run('claude-md.block', action({ id: 'inline', template: undefined, content: 'Rules:\n{params.rules}' }), { params: { rules: '- be brief' } });
    assert.ok(read(claudeMd()).includes('Rules:\n- be brief'));
  });

  it('refuses an empty block', () => {
    assert.throws(() => run('claude-md.block', action({ template: undefined, content: '   ' })), /empty content/);
  });

  it('skips inline content whose text parameter was not filled in', () => {
    const original = read(claudeMd());
    const { entry } = run('claude-md.block', action({ id: 'corr', template: undefined, content: '{params.rules}' }), { params: { rules: '  ' } });
    assert.equal(entry.skipped, true);
    assert.match(entry.reason, /text parameter not filled in/);
    assert.equal(read(claudeMd()), original);
  });

  it('writes to the project CLAUDE.md for project scope', () => {
    const project = makeTempDir('kaizen-proj-');
    run('claude-md.block', action({ template: undefined, content: 'Project rule.' }), { scope: 'project', projectDir: project });
    assert.ok(read(path.join(project, 'CLAUDE.md')).includes('Project rule.'));
  });

  it('writes nothing in dry-run mode', () => {
    const original = read(claudeMd());
    const io = newIo({ dry: true });
    run('claude-md.block', action(), { io });
    assert.equal(read(claudeMd()), original);
    assert.match(io.described[0], /add rules block "read-before-edit"/);
  });
});

// ------------------------------------------------------------------ file, skill, agent

describe('file action', () => {
  const action = (over = {}) => ({ type: 'file', template: 'hooks/guard-destructive.mjs', target: '{kaizenHome}/hooks/guard-destructive.mjs', ...over });
  const target = () => path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');

  it('writes the template under the state directory with the {{params}} filled in', () => {
    const { entry } = run('file', action(), { params: { mode: 'ask', protectedBranches: ['main', 'release'] } });
    const text = read(target());
    assert.ok(text.includes("const MODE_RAW = 'ask';"));
    assert.ok(text.includes("const BRANCHES_RAW = 'main,release';"));
    assert.ok(!/\{\{[a-zA-Z]+\}\}/.test(text), 'no placeholder may remain');
    assert.equal(entry.type, 'file');
    assert.ok(samePath(entry.file, target()));
    assert.equal(entry.existedBefore, false);
    assert.equal(entry.hash, apply.__test.sha(text));
  });

  it('leaves placeholders without a value in place so the script can fall back to its defaults', () => {
    run('file', action());
    assert.ok(read(target()).includes("const MODE_RAW = '{{mode}}';"));
  });

  it('skips when an identical file is already there', () => {
    run('file', action(), { params: { mode: 'deny' } });
    const { entry } = run('file', action(), { params: { mode: 'deny' } });
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'identical file exists');
  });

  it('overwrites its own earlier output under the state directory and backs the old version up', () => {
    run('file', action(), { params: { mode: 'deny' } });
    const { entry } = run('file', action(), { params: { mode: 'ask' } });
    assert.equal(entry.existedBefore, true);
    assert.ok(read(target()).includes("'ask'"));
    const backups = path.join(ctx.stateDir, 'applied', 'unit', 'backups');
    assert.equal(fs.readdirSync(backups).length, 1);
  });

  it('refuses to overwrite a file it did not create outside its own directory, unless forced', () => {
    const mine = path.join(ctx.configDir, 'agents', 'helper.md');
    const original = read(mine);
    const a = { type: 'file', target: mine, content: 'replacement' };
    const refused = run('file', a);
    assert.equal(refused.entry.skipped, true);
    assert.match(refused.entry.reason, /was not created by Kaizen/);
    assert.equal(read(mine), original);
    const forced = run('file', a, { io: newIo({ force: true }) });
    assert.equal(forced.entry.type, 'file');
    assert.equal(read(mine), 'replacement');
  });

  it('does overwrite a file outside the state directory when an earlier batch created it', () => {
    const mine = path.join(ctx.configDir, 'agents', 'kaizen-demo.md');
    const first = run('file', { type: 'file', target: mine, content: 'v1' });
    writeJson(path.join(appliedDir(), '2026-10-30T10-00-00', 'manifest.json'), { id: '2026-10-30T10-00-00', recipes: [{ id: 'demo', actions: [first.entry] }] });
    const second = run('file', { type: 'file', target: mine, content: 'v2' });
    assert.equal(second.entry.type, 'file');
    assert.equal(read(mine), 'v2');
  });

  it('does not treat a file as owned once its batch was undone', () => {
    const mine = path.join(ctx.configDir, 'agents', 'kaizen-demo.md');
    const first = run('file', { type: 'file', target: mine, content: 'v1' });
    writeJson(path.join(appliedDir(), '2026-10-30T10-00-00', 'manifest.json'), { id: '2026-10-30T10-00-00', undone: true, recipes: [{ id: 'demo', actions: [first.entry] }] });
    assert.equal(run('file', { type: 'file', target: mine, content: 'v2' }).entry.skipped, true);
  });

  it('creates missing parent directories', () => {
    const deep = path.join(ctx.stateDir, 'a', 'b', 'c.txt');
    run('file', { type: 'file', target: deep, content: 'x' });
    assert.equal(read(deep), 'x');
  });

  it('writes nothing in dry-run mode', () => {
    const io = newIo({ dry: true });
    run('file', action(), { io });
    assert.ok(!fs.existsSync(target()));
    assert.match(io.described[0], /create \(\d+ chars\)/);
  });

  describe('undo', () => {
    it('deletes the file when it is unchanged', () => {
      const { entry } = run('file', action());
      assert.equal(undoEntry(entry).result, 'ok');
      assert.ok(!fs.existsSync(target()));
    });

    it('keeps the file, and says so, when it was modified after the apply', () => {
      const { entry } = run('file', action());
      fs.appendFileSync(target(), '\n// my own change\n');
      const { result } = undoEntry(entry);
      assert.match(result, /^kept: .*modified since apply$/);
      assert.ok(read(target()).includes('my own change'));
    });

    it('reports a file that is already gone', () => {
      const { entry } = run('file', action());
      fs.rmSync(target());
      assert.equal(undoEntry(entry).result, 'file already removed');
    });
  });
});

describe('skill action', () => {
  const skillFile = (name) => path.join(ctx.configDir, 'skills', name, 'SKILL.md');

  it('normalizes the name and adds frontmatter when the content has none', () => {
    run('skill', { type: 'skill', name: '{params.name}', content: '{params.content}' }, { params: { name: ' My Routine! ', content: 'Step one.\nStep two.' } });
    assert.equal(read(skillFile('my-routine')), '---\nname: my-routine\ndescription: my routine\n---\n\nStep one.\nStep two.');
  });

  it('keeps frontmatter the content already has', () => {
    const content = '---\nname: deploy\ndescription: Deploys it\n---\n\nBody';
    run('skill', { type: 'skill', name: 'deploy', content });
    assert.equal(read(skillFile('deploy')), content);
  });

  it('refuses an empty name or empty content', () => {
    assert.throws(() => run('skill', { type: 'skill', name: '!!!', content: 'x' }), /empty name/);
    assert.throws(() => run('skill', { type: 'skill', name: 'ok', content: '   ' }), /empty content/);
  });

  it('skips when the content parameter was not filled in', () => {
    const { entry } = run('skill', { type: 'skill', name: 'x', content: '{params.content}' }, { params: { content: '' } });
    assert.equal(entry.skipped, true);
    assert.ok(!fs.existsSync(skillFile('x')));
  });

  it('undo deletes the file and the directory it created, but keeps a directory that has other files', () => {
    const a = run('skill', { type: 'skill', name: 'alone', content: 'Body' });
    assert.equal(undoEntry(a.entry).result, 'ok');
    assert.ok(!fs.existsSync(path.dirname(skillFile('alone'))));

    const b = run('skill', { type: 'skill', name: 'shared', content: 'Body' });
    writeText(path.join(path.dirname(skillFile('shared')), 'notes.md'), 'mine');
    assert.equal(undoEntry(b.entry).result, 'ok');
    assert.ok(!fs.existsSync(skillFile('shared')));
    assert.ok(fs.existsSync(path.join(path.dirname(skillFile('shared')), 'notes.md')));
  });

  it('does not overwrite an existing skill of the user', () => {
    const { entry } = run('skill', { type: 'skill', name: 'demo-skill', content: 'Replacement' });
    assert.equal(entry.skipped, true);
    assert.ok(read(skillFile('demo-skill')).includes('Synthetic skill'));
  });
});

describe('agent action', () => {
  it('writes the template as <agentsDir>/<name>.md and undo removes it', () => {
    const { entry } = run('agent', { type: 'agent', name: 'code-reviewer', template: 'agents/code-reviewer.md' });
    const file = path.join(ctx.configDir, 'agents', 'code-reviewer.md');
    assert.equal(read(file), read(path.join(KIT_ROOT, 'recipes', 'templates', 'agents', 'code-reviewer.md')));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(path.join(ctx.configDir, 'agents', 'helper.md')));
  });

  it('does not overwrite an agent the user already has', () => {
    const { entry } = run('agent', { type: 'agent', name: 'helper', content: 'x' });
    assert.equal(entry.skipped, true);
  });

  it('writes project agents under .claude/agents', () => {
    const project = makeTempDir('kaizen-proj-');
    run('agent', { type: 'agent', name: 'test-runner', template: 'agents/test-runner.md' }, { scope: 'project', projectDir: project });
    assert.ok(fs.existsSync(path.join(project, '.claude', 'agents', 'test-runner.md')));
  });
});

// ------------------------------------------------------------------ mcp.disable, plugins.disable, settings.hook.remove

describe('mcp.disable', () => {
  const action = (servers) => ({ type: 'mcp.disable', servers });
  const globalConfig = () => readJson(ctx.claudeJson);

  it('moves a server out of ~/.claude.json, journals its definition and keeps the other keys', () => {
    const original = globalConfig();
    const { entry } = run('mcp.disable', action(['dead-srv']));
    const after = globalConfig();
    assert.deepEqual(Object.keys(after.mcpServers), ['used-srv']);
    assert.equal(after.numStartups, original.numStartups);
    assert.equal(after.theme, original.theme);
    assert.deepEqual(entry.removed, [{ name: 'dead-srv', config: original.mcpServers['dead-srv'] }]);
  });

  it('backs up ~/.claude.json before changing it', () => {
    const original = read(ctx.claudeJson);
    run('mcp.disable', action(['dead-srv']));
    const backups = path.join(ctx.stateDir, 'applied', 'unit', 'backups');
    assert.equal(fs.readdirSync(backups).length, 1);
    assert.equal(read(path.join(backups, fs.readdirSync(backups)[0])), original);
  });

  it('undo puts the server back with its exact definition', () => {
    const original = globalConfig();
    const { entry } = run('mcp.disable', action(['dead-srv']));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.deepEqual(globalConfig(), original);
  });

  it('accepts a comma-separated string, ignores unknown names and skips when none match', () => {
    const { entry } = run('mcp.disable', action('{params.servers}'), { params: { servers: ['dead-srv', 'ghost'] } });
    assert.deepEqual(entry.removed.map((r) => r.name), ['dead-srv']);
    const none = run('mcp.disable', action(['ghost']));
    assert.equal(none.entry.skipped, true);
    assert.match(none.entry.reason, /servers not found/);
  });

  it('skips when no server is selected', () => {
    assert.equal(run('mcp.disable', action('{params.servers}'), { params: { servers: [] } }).entry.skipped, true);
    assert.equal(run('mcp.disable', action([])).entry.reason, 'no servers selected');
  });

  it('skips when ~/.claude.json does not exist', () => {
    fs.rmSync(ctx.claudeJson);
    assert.equal(run('mcp.disable', action(['dead-srv'])).entry.skipped, true);
    assert.ok(!fs.existsSync(ctx.claudeJson));
  });

  it('undo does not overwrite a server the user has configured again', () => {
    const { entry } = run('mcp.disable', action(['dead-srv']));
    const cfg = globalConfig();
    cfg.mcpServers['dead-srv'] = { type: 'stdio', command: 'other' };
    writeJson(ctx.claudeJson, cfg);
    assert.equal(undoEntry(entry).result, 'servers already present');
    assert.equal(globalConfig().mcpServers['dead-srv'].command, 'other');
  });

  it('writes nothing in dry-run mode', () => {
    const original = read(ctx.claudeJson);
    const io = newIo({ dry: true });
    const { entry } = run('mcp.disable', action(['dead-srv']), { io });
    assert.equal(entry.type, 'mcp.disable');
    assert.equal(read(ctx.claudeJson), original);
  });
});

describe('plugins.disable', () => {
  const action = (plugins) => ({ type: 'plugins.disable', plugins });

  it('turns plugins off in enabledPlugins and remembers what each one was', () => {
    const { entry } = run('plugins.disable', action(['idle@fixture-market', 'retired@fixture-market', 'new@market']));
    assert.deepEqual(readSettings().enabledPlugins, { 'demo@fixture-market': true, 'idle@fixture-market': false, 'retired@fixture-market': false, 'new@market': false });
    assert.deepEqual(entry.changed, [{ plugin: 'idle@fixture-market', previous: true }, { plugin: 'new@market', previous: null }]);
  });

  it('undo re-enables what was enabled, removes what had no entry, and leaves what was already off', () => {
    const { entry } = run('plugins.disable', action(['idle@fixture-market', 'retired@fixture-market', 'new@market']));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.deepEqual(readSettings().enabledPlugins, { 'demo@fixture-market': true, 'idle@fixture-market': true, 'retired@fixture-market': false });
  });

  it('skips when everything is already disabled or nothing is selected', () => {
    assert.equal(run('plugins.disable', action(['retired@fixture-market'])).entry.reason, 'already disabled');
    assert.equal(run('plugins.disable', action([])).entry.reason, 'no plugins selected');
  });

  it('accepts the comma-separated {params.plugins} form', () => {
    const { entry } = run('plugins.disable', action('{params.plugins}'), { params: { plugins: ['idle@fixture-market', 'demo@fixture-market'] } });
    assert.equal(entry.changed.length, 2);
  });

  it('writes nothing in dry-run mode', () => {
    const bytes = read(ctx.settingsFile);
    run('plugins.disable', action(['idle@fixture-market']), { io: newIo({ dry: true }) });
    assert.equal(read(ctx.settingsFile), bytes);
  });
});

describe('settings.hook.remove', () => {
  const action = (commands) => ({ type: 'settings.hook.remove', commands });

  it('removes the hook entries whose command matches, ignoring whitespace differences', () => {
    const { entry } = run('settings.hook.remove', action(['npx   prettier --write']));
    const s = readSettings();
    assert.equal(s.hooks.PostToolUse, undefined);
    assert.equal(s.hooks.Stop.length, 1);
    assert.equal(entry.removed.length, 1);
    assert.equal(entry.removed[0].event, 'PostToolUse');
    assert.equal(entry.removed[0].matcher, 'Edit|Write');
    assert.equal(entry.removed[0].hook.timeout, 30);
  });

  it('undo restores the hook with its matcher and options', () => {
    const before = readSettings();
    const { entry } = run('settings.hook.remove', action(['npx prettier --write']));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.deepEqual(readSettings().hooks.PostToolUse, before.hooks.PostToolUse);
  });

  it('accepts a newline-separated string and an array', () => {
    const { entry } = run('settings.hook.remove', action('{params.hooks}'), { params: { hooks: ['npx prettier --write', 'node "C:/Program Files/nodejs/node.exe" x.mjs'] } });
    assert.equal(entry.removed.length, 2);
    assert.deepEqual(readSettings().hooks ?? {}, {}, 'no hook event is left');
  });

  it('skips when no hook matches or nothing is selected', () => {
    assert.match(run('settings.hook.remove', action(['no such command'])).entry.reason, /not found in settings files/);
    assert.equal(run('settings.hook.remove', action([])).entry.reason, 'no hooks selected');
  });

  it('undo does not duplicate a hook that is already back', () => {
    const { entry } = run('settings.hook.remove', action(['npx prettier --write']));
    undoEntry(entry);
    assert.equal(undoEntry(entry).result, 'hooks already present');
    assert.equal(readSettings().hooks.PostToolUse.length, 1);
  });
});

// ------------------------------------------------------------------ cmdApply

describe('cmdApply', () => {
  it('applies the recipes listed in choices.json and prints one line per change', async () => {
    seedState();
    writeJson(path.join(ctx.stateDir, 'choices.json'), { version: 1, selected: [{ id: 'permissions.deny-secrets', scope: 'user', params: {} }, { id: 'settings.cleanup-period', scope: 'user', params: {} }], discuss: [], notes: '' });
    const { manifest, stdout } = await runApply({});
    const s = readSettings();
    assert.equal(s.cleanupPeriodDays, 90);
    assert.ok(s.permissions.deny.includes('Read(./.env)'));
    assert.match(stdout, /✓ .*settings\.json: append to permissions\.deny/);
    assert.match(stdout, /✓ .*set cleanupPeriodDays = 90/);
    assert.ok(stdout.includes(prefixOf('cli.apply_done', { n: 2 })), stdout);
    assert.match(stdout, /manifest\.json/);
    assert.deepEqual(manifest.recipes.map((r) => r.id), ['permissions.deny-secrets', 'settings.cleanup-period']);
  });

  it('writes a journal manifest with the documented structure', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period' });
    const ids = manifestIds();
    assert.equal(ids.length, 1);
    const m = readManifest(ids[0]);
    assert.equal(m.id, ids[0]);
    assert.ok(Number.isFinite(Date.parse(m.at)));
    assert.equal(m.kitVersion, loadCatalog().version);
    assert.equal(m.lang, 'en');
    assert.equal(m.dry, false);
    assert.equal(m.notes, '');
    assert.deepEqual(m.discuss, []);
    assert.equal(m.recipes.length, 1);
    const r = m.recipes[0];
    assert.equal(r.id, 'settings.cleanup-period');
    assert.equal(r.scope, 'user');
    assert.equal(r.advice, false);
    assert.deepEqual(r.params, {});
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].type, 'settings.set');
    assert.equal(r.actions[0].path, 'cleanupPeriodDays');
    assert.equal(r.actions[0].value, 90);
    assert.equal(r.actions[0].hadPrevious, false);
    const last = readJson(path.join(ctx.stateDir, 'last-apply.json'));
    assert.deepEqual(last, { id: ids[0], at: m.at, recipes: ['settings.cleanup-period'] });
  });

  it('keeps backups of every file it changed inside the batch directory', async () => {
    seedState();
    const before = read(ctx.settingsFile);
    await runApply({ recipe: 'settings.cleanup-period' });
    const [id] = manifestIds();
    const backups = path.join(appliedDir(), id, 'backups');
    const files = fs.readdirSync(backups);
    assert.equal(files.length, 1);
    assert.equal(read(path.join(backups, files[0])), before);
  });

  it('--recipe takes comma-separated ids and the default parameters from recommendations.json', async () => {
    seedState();
    const { manifest } = await runApply({ recipe: 'context.mcp-unused,settings.cleanup-period' });
    assert.deepEqual(manifest.recipes.map((r) => r.id), ['context.mcp-unused', 'settings.cleanup-period']);
    assert.deepEqual(manifest.recipes[0].params.servers, ['dead-srv']);
    assert.deepEqual(Object.keys(readJson(ctx.claudeJson).mcpServers), ['used-srv']);
  });

  it('--param recipe.id.name=value overrides a parameter, and a comma makes a list', async () => {
    seedState();
    const { manifest } = await runApply({ recipe: 'hooks.guard-destructive', param: 'hooks.guard-destructive.protectedBranches=main,release' });
    assert.deepEqual(manifest.recipes[0].params.protectedBranches, ['main', 'release']);
    const hook = path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
    assert.ok(read(hook).includes("const BRANCHES_RAW = 'main,release';"));
    assert.ok(read(hook).includes("const MODE_RAW = 'deny';"));
  });

  it('--param can set a scalar parameter of a hook template', async () => {
    seedState();
    await runApply({ recipe: 'hooks.guard-destructive', param: 'hooks.guard-destructive.mode=ask' });
    assert.ok(read(path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs')).includes("const MODE_RAW = 'ask';"));
  });

  it('a malformed --param is an error', async () => {
    seedState();
    await assert.rejects(() => runApply({ recipe: 'settings.cleanup-period', param: 'garbage' }), /--param expects recipe\.id\.param=value/);
  });

  it('--param for a recipe that is not selected is an error that names the selected recipes, and nothing is written', async () => {
    seedState();
    await assert.rejects(() => runApply({ recipe: 'settings.cleanup-period', param: 'hooks.guard-destructive.mode=ask' }), (e) => {
      assert.equal(e.name, 'UserError');
      assert.ok(e.message.includes('hooks.guard-destructive'), e.message);
      assert.ok(e.message.includes('settings.cleanup-period'), e.message);
      return true;
    });
    assert.ok(!fs.existsSync(path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs')));
    assert.deepEqual(manifestIds(), []);
  });

  it('--param with a mistyped recipe id or parameter name is an error listing the valid parameter names', async () => {
    seedState();
    await assert.rejects(() => runApply({ recipe: 'hooks.guard-destructive', param: 'hooks.guard-destructiv.mode=ask' }), /not among the selected recipes \(hooks\.guard-destructive\)/);
    await assert.rejects(() => runApply({ recipe: 'hooks.guard-destructive', param: 'hooks.guard-destructive.moed=ask' }), /no parameter moed\. Valid parameters: mode/);
    await assert.rejects(() => runApply({ recipe: 'settings.cleanup-period', param: 'settings.cleanup-period.days=7' }), /takes no parameters/);
    assert.deepEqual(manifestIds(), []);
    assert.ok(!fs.existsSync(path.join(ctx.stateDir, 'last-apply.json')));
  });

  it('--param with a value outside the options of a select is an error; a dynamic list is not checked', async () => {
    seedState();
    await assert.rejects(() => runApply({ recipe: 'hooks.guard-destructive', param: 'hooks.guard-destructive.mode=block' }), /block is not one of the allowed values for hooks\.guard-destructive\.mode: deny, ask/);
    await runApply({ recipe: 'context.mcp-unused', param: 'context.mcp-unused.servers=dead-srv' });
  });

  it('--param-file for a parameter the recipe does not declare is an error', async () => {
    seedState();
    const file = path.join(ctx.root, 'v.txt');
    writeText(file, 'x');
    await assert.rejects(() => runApply({ recipe: 'hooks.guard-destructive', 'param-file': `hooks.guard-destructive.nope=${file}` }), /no parameter nope\. Valid parameters: mode/);
  });

  it('installs a hook script and registers it in settings.json', async () => {
    seedState();
    const { manifest } = await runApply({ recipe: 'hooks.guard-destructive' });
    const file = path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
    assert.ok(fs.existsSync(file));
    const hooks = readSettings().hooks.PreToolUse;
    const group = hooks.find((g) => g.hooks.some((h) => h.command.includes('guard-destructive.mjs')));
    assert.ok(group, 'PreToolUse hook must be registered');
    assert.ok(group.matcher.includes('Bash'));
    assert.equal(typeof group.hooks[0].timeout, 'number');
    assert.ok(group.hooks[0].command.includes(toPosix(ctx.stateDir)), 'the hook points at the installed script by absolute path');
    assert.deepEqual(manifest.recipes[0].actions.map((a) => a.type), ['file', 'settings.hook']);
  });

  it('applies to the project when --scope project and --project are given', async () => {
    seedState();
    const project = makeTempDir('kaizen-proj-');
    await runApply({ recipe: 'claude-md.read-before-edit', scope: 'project', project });
    assert.ok(read(path.join(project, 'CLAUDE.md')).includes('kaizen:start read-before-edit'));
    assert.ok(!read(path.join(ctx.configDir, 'CLAUDE.md')).includes('kaizen:start'));
    assert.equal(readManifest(manifestIds()[0]).recipes[0].scope, 'project');
  });

  it('writes nothing in dry-run mode, prints the plan and does not create a journal', async () => {
    seedState();
    const before = snapshotDir(ctx.root);
    const { manifest, stdout } = await runApply({ recipe: 'hooks.guard-destructive,permissions.deny-secrets,context.mcp-unused', 'dry-run': true });
    assert.deepEqual(snapshotDir(ctx.root), before);
    assert.ok(!fs.existsSync(appliedDir()));
    assert.match(stdout, /→ .*add PreToolUse hook/);
    const planned = manifest.recipes.reduce((sum, r) => sum + r.actions.length, 0);
    assert.ok(planned >= 4, 'guard script, hook, deny rules and the MCP removal are planned');
    assert.ok(stdout.includes(t('cli.apply_dry', { n: planned })), stdout);
    assert.equal(manifest.dry, true);
  });

  it('skips actions that are already in place and says why', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period' });
    const { stdout, manifest } = await runApply({ recipe: 'settings.cleanup-period' });
    assert.match(stdout, /· settings\.cleanup-period: already set/);
    assert.deepEqual(manifest.recipes[0].actions, []);
  });

  it('skips an action whose own condition is not met', async () => {
    seedState();
    const m = structuredClone(fixtureMeasure);
    m.locale = { lang: 'ru', cyrillicShare: 0.9 };
    m.context.settingsLanguage = 'russian';
    m.context.claudeMdHints.language = false;
    const { stdout, manifest } = await runApply({ recipe: 'claude-md.language' }, { measure: m });
    assert.match(stdout, /· claude-md\.language: settings\.set skipped \(condition not met\)/);
    assert.deepEqual(manifest.recipes[0].actions.map((a) => a.type), ['claude-md.block']);
    assert.ok(!('language' in readSettings()));
  });

  it('reports an unknown recipe and carries on with the others', async () => {
    seedState();
    const { manifest, stdout } = await runApply({ recipe: 'no.such-recipe,settings.cleanup-period' });
    assert.match(stdout, /! unknown recipe no\.such-recipe \(skipped\)/);
    assert.deepEqual(manifest.recipes.map((r) => r.id), ['settings.cleanup-period']);
  });

  it('reports a failing action as an error line, keeps going and leaves the broken file alone', async () => {
    seedState();
    writeText(ctx.settingsFile, '{ broken');
    const { stdout, manifest } = await runApply({ recipe: 'settings.cleanup-period,claude-md.read-before-edit' });
    assert.match(stdout, /! settings\.cleanup-period: /);
    assert.equal(read(ctx.settingsFile), '{ broken');
    assert.ok(read(path.join(ctx.configDir, 'CLAUDE.md')).includes('kaizen:start read-before-edit'));
    assert.deepEqual(manifest.recipes.map((r) => [r.id, r.actions.length]), [['settings.cleanup-period', 0], ['claude-md.read-before-edit', 1]]);
  });

  it('records advice-only recipes in the journal without touching any file', async () => {
    seedState();
    const before = snapshotDir(ctx.configDir);
    const { manifest } = await runApply({ recipe: 'claude-md.diet' });
    assert.equal(manifest.recipes[0].advice, true);
    assert.deepEqual(manifest.recipes[0].actions, []);
    assert.deepEqual(snapshotDir(ctx.configDir), before);
    assert.equal(manifestIds().length, 1);
  });

  it('prints nothing to apply for an empty selection and writes no journal', async () => {
    writeJson(path.join(ctx.stateDir, 'choices.json'), { version: 1, selected: [], discuss: [], notes: '' });
    const { manifest, stdout } = await runApply({});
    assert.deepEqual(manifest, { applied: 0 });
    assert.ok(stdout.includes(t('cli.apply_nothing')), stdout);
    assert.ok(!fs.existsSync(appliedDir()));
  });

  it('stores the notes and the discuss list of the choices in the journal', async () => {
    seedState();
    writeJson(path.join(ctx.stateDir, 'choices.json'), { version: 1, selected: [{ id: 'settings.cleanup-period' }], discuss: ['claude-md.diet'], notes: 'tests are `make check`' });
    await runApply({});
    const m = readManifest(manifestIds()[0]);
    assert.equal(m.notes, 'tests are `make check`');
    assert.deepEqual(m.discuss, ['claude-md.diet']);
  });

  it('fails with a helpful message when there is no choices file and no --recipe', async () => {
    await assert.rejects(() => runApply({}), /No choices file at .*choices\.json/);
  });

  it('reads the choices from a file given as the first argument', async () => {
    seedState();
    const file = path.join(ctx.root, 'my-choices.json');
    writeJson(file, { version: 1, selected: [{ id: 'settings.cleanup-period' }], discuss: [], notes: '' });
    const { manifest } = await runApply({}, { positional: [file] });
    assert.deepEqual(manifest.recipes.map((r) => r.id), ['settings.cleanup-period']);
  });

  it('prints in the requested language', async () => {
    seedState();
    const { stdout, manifest } = await runApply({ recipe: 'settings.cleanup-period' }, { lang: 'ru' });
    assert.ok(stdout.includes(prefixOf('cli.apply_done', { n: 1 }, 'ru')), stdout);
    assert.notEqual(prefixOf('cli.apply_done', { n: 1 }, 'ru'), prefixOf('cli.apply_done', { n: 1 }, 'en'));
    assert.equal(manifest.lang, 'ru');
  });

  it('does not lose the first journal when two batches are applied within the same second', async () => {
    seedState();
    await withFrozenDate('2026-10-30T12:00:00.500Z', async () => {
      await runApply({ recipe: 'settings.cleanup-period' });
      await runApply({ recipe: 'permissions.deny-secrets' });
    });
    assert.equal(manifestIds().length, 2, 'each apply needs its own journal directory');
    const recipes = manifestIds().flatMap((id) => readManifest(id).recipes.map((r) => r.id)).sort();
    assert.deepEqual(recipes, ['permissions.deny-secrets', 'settings.cleanup-period']);
    const { result } = await runUndo({ all: true });
    assert.equal(result.undone, 2);
    assert.ok(!('cleanupPeriodDays' in readSettings()));
    assert.deepEqual(readSettings().permissions.deny, []);
  });
});

describe('loadChoices', () => {
  it('builds the selection from --recipe, taking scope and parameter values from recommendations.json', () => {
    seedState();
    const choices = apply.loadChoices({ _: ['apply'], flags: { recipe: 'context.mcp-unused, settings.cleanup-period' } });
    assert.equal(choices.source, 'cli');
    assert.deepEqual(choices.selected.map((s) => s.id), ['context.mcp-unused', 'settings.cleanup-period']);
    assert.deepEqual(choices.selected[0].params, { servers: ['dead-srv'] });
    assert.equal(choices.selected[0].scope, 'user');
  });

  it('uses --scope over the recommended scope, and "user" when the recipe is unknown', () => {
    seedState();
    const choices = apply.loadChoices({ _: ['apply'], flags: { recipe: 'permissions.deny-secrets,made.up', scope: 'project' } });
    assert.deepEqual(choices.selected.map((s) => s.scope), ['project', 'project']);
    const plain = apply.loadChoices({ _: ['apply'], flags: { recipe: 'made.up' } });
    assert.equal(plain.selected[0].scope, 'user');
    assert.deepEqual(plain.selected[0].params, {});
  });

  it('works without recommendations.json', () => {
    const choices = apply.loadChoices({ _: ['apply'], flags: { recipe: 'settings.cleanup-period' } });
    assert.deepEqual(choices.selected, [{ id: 'settings.cleanup-period', scope: 'user', params: {} }]);
  });

  it('validates a choices file like `choices --import` does', () => {
    const dir = makeTempDir('choices-file');
    const good = path.join(dir, 'good.json');
    writeJson(good, { selected: [{ id: 'settings.cleanup-period', scope: 'user' }], notes: 'hi' });
    const ok = apply.loadChoices({ _: ['apply', good], flags: {} });
    assert.deepEqual(ok.selected.map((s) => s.id), ['settings.cleanup-period']);
    assert.equal(ok.notes, 'hi');
    const badId = path.join(dir, 'bad-id.json');
    writeJson(badId, { selected: [{ id: '../../etc/passwd' }] });
    assert.throws(() => apply.loadChoices({ _: ['apply', badId], flags: {} }), /bad recipe id/);
    const badScope = path.join(dir, 'bad-scope.json');
    writeJson(badScope, { selected: [{ id: 'a.b', scope: 'everywhere' }] });
    assert.throws(() => apply.loadChoices({ _: ['apply', badScope], flags: {} }), /bad scope/);
    const notList = path.join(dir, 'not-list.json');
    writeJson(notList, { selected: 'settings.cleanup-period' });
    assert.throws(() => apply.loadChoices({ _: ['apply', notList], flags: {} }), /must be an array/);
  });
});

// ------------------------------------------------------------------ cmdUndo

describe('cmdUndo', () => {
  async function applyThree() {
    seedState();
    await withFrozenDate('2026-10-30T12:00:01.000Z', () => runApply({ recipe: 'settings.cleanup-period' }));
    await withFrozenDate('2026-10-30T12:00:02.000Z', () => runApply({ recipe: 'permissions.deny-secrets' }));
    await withFrozenDate('2026-10-30T12:00:03.000Z', () => runApply({ recipe: 'claude-md.read-before-edit' }));
    return manifestIds();
  }

  it('reverts the latest batch and marks it undone with its results', async () => {
    const ids = await applyThree();
    const { result, stdout } = await runUndo();
    assert.equal(result.undone, 1);
    assert.ok(!read(path.join(ctx.configDir, 'CLAUDE.md')).includes('kaizen:start'));
    assert.equal(readSettings().cleanupPeriodDays, 90, 'earlier batches stay applied');
    assert.ok(stdout.includes(t('cli.undo_done', { n: 1, id: ids[2] })), stdout);
    const m = readManifest(ids[2]);
    assert.equal(m.undone, true);
    assert.ok(Number.isFinite(Date.parse(m.undoneAt)));
    assert.deepEqual(m.undoResults.map((r) => [r.recipe, r.type, r.result]), [['claude-md.read-before-edit', 'claude-md.block', 'ok']]);
  });

  it('walks back batch by batch with repeated undo', async () => {
    await applyThree();
    await runUndo();
    await runUndo();
    assert.deepEqual(readSettings().permissions.deny, []);
    assert.equal(readSettings().cleanupPeriodDays, 90);
    await runUndo();
    assert.ok(!('cleanupPeriodDays' in readSettings()));
    const { stdout } = await runUndo();
    assert.ok(stdout.includes(t('cli.undo_nothing')), stdout);
  });

  it('reverts a specific batch by id', async () => {
    const ids = await applyThree();
    await runUndo({}, [ids[0]]);
    assert.ok(!('cleanupPeriodDays' in readSettings()));
    assert.ok(readSettings().permissions.deny.includes('Read(./.env)'));
    assert.ok(read(path.join(ctx.configDir, 'CLAUDE.md')).includes('kaizen:start read-before-edit'));
  });

  it('--all reverts every batch, newest first', async () => {
    const ids = await applyThree();
    const { result, stdout } = await runUndo({ all: true });
    assert.equal(result.undone, 3);
    const expected = [...ids].reverse().map((id) => t('cli.undo_done', { n: 1, id }));
    assert.deepEqual(stdout.split(/\r?\n/).filter((line) => expected.includes(line)), expected);
    assert.ok(!('cleanupPeriodDays' in readSettings()));
  });

  it('--dry-run describes the reverts without changing anything or marking batches undone', async () => {
    const ids = await applyThree();
    const before = snapshotDir(ctx.root);
    const { stdout } = await runUndo({ 'dry-run': true });
    assert.deepEqual(snapshotDir(ctx.root), before);
    assert.match(stdout, /→ .*remove rules block "read-before-edit"/);
    assert.equal(readManifest(ids[2]).undone, undefined);
    // a dry run must not claim that anything was reverted
    assert.ok(stdout.includes(t('cli.undo_dry', { n: 1, id: ids[2] })), stdout);
    assert.ok(!stdout.includes(prefixOf('cli.undo_done', { n: 1 })), stdout);
  });

  it('installs session-context for startup|clear even after precompact-handoff, and undo removes both cleanly', async () => {
    await withFrozenDate('2026-10-30T12:00:01.000Z', () => runApply({ recipe: 'hooks.precompact-handoff,hooks.session-context' }));
    const groups = readSettings().hooks.SessionStart.filter((g) => g.hooks.some((h) => h.command.includes('session-context.mjs')));
    assert.deepEqual(groups.map((g) => g.matcher), ['compact|resume|fork', 'startup|clear']);
    const covered = new Set(groups.flatMap((g) => g.matcher.split('|')));
    assert.deepEqual([...covered].sort(), ['clear', 'compact', 'fork', 'resume', 'startup']);
    await runUndo({ all: true });
    assert.equal(readSettings().hooks.SessionStart, undefined);
    assert.equal(readSettings().hooks.PreCompact, undefined);
  });

  it('does nothing when there is nothing to undo, and ignores an unknown id', async () => {
    const empty = await runUndo();
    assert.ok(empty.stdout.includes(t('cli.undo_nothing')), empty.stdout);
    assert.equal(empty.result.undone, 0);
    await applyThree();
    const unknown = await runUndo({}, ['1999-01-01T00-00-00']);
    assert.ok(unknown.stdout.includes(t('cli.undo_nothing')), unknown.stdout);
  });

  it('never reverts a batch twice', async () => {
    const ids = await applyThree();
    await runUndo({}, [ids[2]]);
    const again = await runUndo({}, [ids[2]]);
    assert.ok(again.stdout.includes(t('cli.undo_nothing')), again.stdout);
  });

  it('reports what it kept: a script the user edited stays, and the line says so', async () => {
    seedState();
    await runApply({ recipe: 'hooks.guard-destructive' });
    const hook = path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
    fs.appendFileSync(hook, '\n// tuned by hand\n');
    const { result, stdout } = await runUndo();
    assert.ok(fs.existsSync(hook), 'a modified script must survive undo');
    assert.match(stdout, /· hooks\.guard-destructive file: kept: .*modified since apply/);
    assert.equal(result.undone, 1, 'only the settings.hook entry was reverted');
    assert.ok(!JSON.stringify(readSettings().hooks.PreToolUse || []).includes('guard-destructive'));
    const m = readManifest(manifestIds()[0]);
    assert.ok(m.undoResults.some((r) => r.type === 'file' && /^kept:/.test(r.result)));
  });

  it('still reverts the original change after the same recipe was applied again (a no-op re-apply)', async () => {
    seedState();
    await withFrozenDate('2026-10-30T12:00:01.000Z', () => runApply({ recipe: 'settings.cleanup-period' }));
    await withFrozenDate('2026-10-30T12:00:05.000Z', () => runApply({ recipe: 'settings.cleanup-period' }));
    await runUndo();
    assert.ok(!('cleanupPeriodDays' in readSettings()), 'undo after a no-op re-apply must revert the real change');
  });
});

// ------------------------------------------------------------------ recipes that share one hook script

// hooks.session-context and hooks.precompact-handoff both write {kaizenHome}/hooks/session-context.mjs and both wire it
// to SessionStart (startup|resume|clear|compact|fork and compact|resume|fork). They are applied in separate batches in
// real use, and either one can be undone first.
describe('two recipes sharing session-context.mjs across separate batches', () => {
  const SC = 'hooks.session-context';
  const PH = 'hooks.precompact-handoff';
  const ALL_EVENTS = ['clear', 'compact', 'fork', 'resume', 'startup'];
  const scriptFile = () => path.join(ctx.stateDir, 'hooks', 'session-context.mjs');
  const handoffFile = () => path.join(ctx.stateDir, 'hooks', 'precompact-handoff.mjs');
  const stateHooks = () => (fs.existsSync(path.join(ctx.stateDir, 'hooks')) ? fs.readdirSync(path.join(ctx.stateDir, 'hooks')) : []);
  const sessionStart = () => ((readSettings().hooks || {}).SessionStart || []).filter((g) => g.hooks.some((h) => h.command.includes('session-context.mjs')));
  const covered = () => [...new Set(sessionStart().flatMap((g) => g.matcher.split('|')))].sort();
  const SC_PARAMS = ['hooks.session-context.includeGit=false', 'hooks.session-context.maxChars=4000'];
  let cleanSettings;

  beforeEach(() => {
    cleanSettings = readSettings();
  });

  const at = (n, flags) => withFrozenDate(`2026-10-30T12:00:0${n}.000Z`, () => runApply(flags));
  const batch = (n) => `2026-10-30T12-00-0${n}`;
  const assertPristine = () => {
    assert.deepEqual(readSettings(), cleanSettings);
    assert.deepEqual(stateHooks(), []);
  };

  it('apply session-context, apply precompact-handoff, undo the last batch: the script and the SessionStart hook stay', async () => {
    await at(1, { recipe: SC, param: SC_PARAMS });
    const mine = read(scriptFile());
    assert.match(mine, /const MAX_RAW = '4000'/);
    assert.match(mine, /const GIT_RAW = 'false'/);
    const second = await at(2, { recipe: PH });
    // the second recipe does not know the first one's parameters: it keeps the script as it is and says so
    assert.equal(read(scriptFile()), mine);
    assert.match(second.stdout, /session-context\.mjs: shared with hooks\.session-context/);
    const { stdout } = await runUndo();
    assert.equal(read(scriptFile()), mine, 'undoing the later batch must not delete or reset the script');
    assert.deepEqual(covered(), ALL_EVENTS);
    assert.ok(!fs.existsSync(handoffFile()));
    assert.equal(readSettings().hooks.PreCompact, undefined);
    assert.ok(!stdout.includes('--force'), stdout);
    assert.equal(readManifest(batch(2)).undone, true, 'nothing was left over, so the batch counts as undone');
    await runUndo();
    assertPristine();
  });

  it('apply session-context, apply precompact-handoff, undo the first batch by id: precompact-handoff keeps its script and coverage', async () => {
    await at(1, { recipe: SC, param: SC_PARAMS });
    const mine = read(scriptFile());
    await at(2, { recipe: PH });
    const { stdout } = await runUndo({}, [batch(1)]);
    assert.equal(read(scriptFile()), mine, 'the script is still needed by precompact-handoff');
    assert.deepEqual(covered(), ['compact', 'fork', 'resume'], 'only the part precompact-handoff asked for is left');
    assert.ok(!stdout.includes('--force'), stdout);
    assert.match(stdout, /session-context\.mjs.*still in use by hooks\.precompact-handoff/);
    assert.equal(readManifest(batch(1)).undone, true);
    // the remaining recipe now owns the script and the hook: undoing it cleans up everything
    await runUndo({}, [batch(2)]);
    assertPristine();
  });

  it('apply precompact-handoff, apply session-context, undo the last batch: the first recipe is back as it was', async () => {
    await at(1, { recipe: PH });
    const first = read(scriptFile());
    const groupsBefore = JSON.stringify(sessionStart());
    await at(2, { recipe: SC, param: SC_PARAMS });
    assert.match(read(scriptFile()), /const GIT_RAW = 'false'/, 'the explicit parameters of the second recipe win');
    assert.deepEqual(covered(), ALL_EVENTS);
    await runUndo();
    assert.equal(read(scriptFile()), first, 'the script of precompact-handoff comes back from the backup instead of being deleted');
    assert.equal(JSON.stringify(sessionStart()), groupsBefore);
    assert.ok(fs.existsSync(handoffFile()));
    await runUndo();
    assertPristine();
  });

  it('apply precompact-handoff, apply session-context, undo the first batch by id: session-context keeps the whole coverage', async () => {
    await at(1, { recipe: PH });
    await at(2, { recipe: SC, param: SC_PARAMS });
    const mine = read(scriptFile());
    const { stdout } = await runUndo({}, [batch(1)]);
    assert.equal(read(scriptFile()), mine, 'session-context.mjs is still run by the SessionStart hook of the second batch');
    assert.deepEqual(covered(), ALL_EVENTS, 'resume, compact and fork stay covered although their group belonged to the undone batch');
    assert.ok(!stdout.includes('--force'), stdout);
    assert.equal(readSettings().hooks.PreCompact, undefined);
    assert.ok(!fs.existsSync(handoffFile()));
    await runUndo({}, [batch(2)]);
    assertPristine();
  });

  it('the coverage handed over by an undo is removed again with the batch that took it over', async () => {
    await at(1, { recipe: PH });
    await at(2, { recipe: SC });
    await runUndo({}, [batch(1)]);
    assert.deepEqual(covered(), ALL_EVENTS);
    const taken = readManifest(batch(2)).recipes.flatMap((r) => r.actions).find((a) => a.type === 'settings.hook');
    assert.deepEqual(taken.matcher.split('|').sort(), ALL_EVENTS, 'the journal now says that this batch owns every alternative');
    await runUndo();
    assertPristine();
  });

  it('applying both recipes in one batch keeps the parameters of session-context in either order', async () => {
    await at(1, { recipe: `${SC},${PH}`, param: SC_PARAMS });
    assert.match(read(scriptFile()), /const GIT_RAW = 'false'/);
    assert.deepEqual(covered(), ALL_EVENTS);
    await runUndo({ all: true });
    assertPristine();
    await at(2, { recipe: `${PH},${SC}`, param: SC_PARAMS });
    assert.match(read(scriptFile()), /const GIT_RAW = 'false'/);
    await runUndo({ all: true });
    assertPristine();
  });

  it('undo --all and undo --dry-run handle the shared script in a multi-batch journal', async () => {
    await at(1, { recipe: SC, param: SC_PARAMS });
    await at(2, { recipe: PH });
    const before = snapshotDir(ctx.root);
    const dry = await runUndo({ all: true, 'dry-run': true });
    assert.deepEqual(snapshotDir(ctx.root), before, 'a dry run changes nothing');
    assert.ok(!dry.stdout.includes('--force'), dry.stdout);
    await runUndo({ all: true });
    assertPristine();
  });

  it('re-applying session-context with other parameters: undo gives the earlier parameters back, then removes the script', async () => {
    await at(1, { recipe: SC });
    const defaults = read(scriptFile());
    assert.match(defaults, /const GIT_RAW = 'true'/);
    await at(2, { recipe: SC, param: SC_PARAMS });
    assert.match(read(scriptFile()), /const GIT_RAW = 'false'/);
    assert.equal(sessionStart().length, 1, 'the hook is wired once');
    await runUndo();
    assert.equal(read(scriptFile()), defaults);
    assert.equal(sessionStart().length, 1, 'the first batch still owns the hook');
    await runUndo();
    assertPristine();
  });

  it('re-applying session-context with other parameters, undoing the first batch first, keeps the new script', async () => {
    await at(1, { recipe: SC });
    await at(2, { recipe: SC, param: SC_PARAMS });
    const newer = read(scriptFile());
    await runUndo({}, [batch(1)]);
    assert.equal(read(scriptFile()), newer);
    await runUndo({}, [batch(2)]);
    assertPristine();
  });

  it('re-applying precompact-handoff after session-context changes nothing and undoes cleanly', async () => {
    await at(1, { recipe: SC, param: SC_PARAMS });
    await at(2, { recipe: PH });
    const mine = read(scriptFile());
    const again = await at(3, { recipe: PH });
    assert.equal(read(scriptFile()), mine);
    // the second run found everything in place: it recorded nothing and must not shadow the batch that did the work
    assert.ok(again.manifest.recipes.every((r) => r.actions.length === 0), 'the repeat run records nothing');
    await runUndo();
    assert.equal(readManifest(batch(2)).undone, true, 'a plain undo reaches the batch that did the work');
    assert.equal(read(scriptFile()), mine, 'session-context still needs the script');
    await runUndo();
    assertPristine();
  });

  it('a script edited by the user is still kept, with and without a second recipe using it', async () => {
    await at(1, { recipe: SC });
    await at(2, { recipe: PH });
    fs.appendFileSync(scriptFile(), '\n// tuned by hand\n');
    const { stdout } = await runUndo({}, [batch(1)]);
    assert.match(stdout, /session-context\.mjs/);
    assert.ok(fs.existsSync(scriptFile()), 'an edited script must survive');
  });

  // ---- one rule for the shared file: it goes only when no entry in force refers to it; its content is the newest
  // ---- writer's; an edit is judged against the hash Kaizen wrote, never against what was on the disk at apply time

  const fileEntry = (n) => readManifest(batch(n)).recipes.flatMap((r) => r.actions).find((a) => a.type === 'file' && /session-context/.test(a.file));
  const KEPT = /kept: .*session-context.mjs modified since apply/;

  describe('a script edited by the user, then a second batch', () => {
    it('the second batch records the hash Kaizen wrote, not the edited text', async () => {
      await at(1, { recipe: SC });
      const written = fileEntry(1).hash;
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n');
      await at(2, { recipe: PH });
      assert.equal(fileEntry(2).shared, true);
      assert.equal(fileEntry(2).hash, written);
    });

    it('undoing the first batch keeps the edit, and so does undoing the second one afterwards', async () => {
      await at(1, { recipe: SC });
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n'); // between the two applies: the second one sees the edited text
      await at(2, { recipe: PH });
      const first = await runUndo({}, [batch(1)]);
      assert.match(first.stdout, /session-context\.mjs/);
      assert.match(first.stdout, /modified since apply|изменён/);
      assert.ok(read(scriptFile()).includes('USER EDIT'));
      assert.equal(readManifest(batch(1)).partiallyUndone, true, 'the edit stays protected: the batch is left partly undone');
      const second = await runUndo({}, [batch(2)]);
      assert.ok(fs.existsSync(scriptFile()), `the edited script must survive both undos\n${second.stdout}`);
      assert.ok(read(scriptFile()).includes('USER EDIT'));
    });

    it('--force finishes the job, and the edited script is backed up first', async () => {
      await at(1, { recipe: SC });
      await at(2, { recipe: PH });
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n');
      await runUndo({ force: true }, [batch(1)]);
      assert.ok(fs.existsSync(scriptFile()), 'precompact-handoff still uses it');
      await runUndo({ force: true }, [batch(2)]);
      assertPristine();
      const saved = readTree(path.join(appliedDir(), batch(2), 'undo'));
      assert.ok(Object.values(saved).some((text) => String(text).includes('USER EDIT')), 'the edit is in the undo backups');
    });
  });

  describe('a user hook added to a group of the shared SessionStart hook', () => {
    const userHook = { type: 'command', command: 'echo mine' };
    const sessionGroups = () => ((readSettings().hooks || {}).SessionStart || []);

    for (const order of ['before', 'after']) {
      it(`undo of both batches leaves only the user hook (added ${order} the first undo)`, async () => {
        await at(1, { recipe: PH });
        await at(2, { recipe: SC });
        const addHook = () => {
          const s = readSettings();
          s.hooks.SessionStart.find((g) => g.matcher === 'startup|clear').hooks.push(userHook);
          writeSettings(s);
        };
        if (order === 'before') addHook();
        await runUndo({}, [batch(1)]);
        if (order === 'after') addHook();
        const last = await runUndo({}, [batch(2)]);
        assert.ok(!last.stdout.includes('--force'), last.stdout);
        assert.deepEqual(sessionGroups(), [{ matcher: 'startup|clear', hooks: [userHook] }], 'no Kaizen hook is left, the user one is');
        assert.ok(!fs.existsSync(scriptFile()), 'the script is gone together with its last hook');
        assert.equal(readManifest(batch(2)).undone, true);
      });
    }

    it('a dry run of undo --all reports the same as the real run', async () => {
      await at(1, { recipe: PH });
      await at(2, { recipe: SC });
      const s = readSettings();
      s.hooks.SessionStart.find((g) => g.matcher === 'startup|clear').hooks.push(userHook);
      writeSettings(s);
      const dry = await runUndo({ all: true, 'dry-run': true });
      const real = await runUndo({ all: true });
      assert.equal(normalizeUndoOutput(dry.stdout), normalizeUndoOutput(real.stdout));
      assert.deepEqual(sessionGroups(), [{ matcher: 'startup|clear', hooks: [userHook] }]);
    });
  });

  describe('the same recipe applied again with other parameters', () => {
    const p = (n) => ['hooks.session-context.maxChars=' + n];

    it('undoing the first batch leaves the second one with its hook as well as its script', async () => {
      await at(1, { recipe: SC });
      await at(2, { recipe: SC, param: p(4000) });
      const hookEntries = readManifest(batch(2)).recipes.flatMap((r) => r.actions).filter((a) => a.type === 'settings.hook');
      assert.equal(hookEntries.length, 1, 'the second batch records that it relies on the hook');
      assert.equal(hookEntries[0].shared, true);
      await runUndo({}, [batch(1)]);
      assert.deepEqual(covered(), ALL_EVENTS, 'the hook still runs the script of the second batch');
      assert.match(read(scriptFile()), /const MAX_RAW = '4000'/);
      await runUndo({}, [batch(2)]);
      assertPristine();
    });

    it('a repeat that changed nothing still records nothing', async () => {
      await at(1, { recipe: SC });
      const again = await at(2, { recipe: SC });
      assert.ok(again.manifest.recipes.every((r) => r.actions.length === 0));
    });

    it('three applies, undone middle first and then the last: the first parameters are back, nothing needs --force', async () => {
      await at(1, { recipe: SC, param: p(1001) });
      await at(2, { recipe: SC, param: p(2002) });
      await at(3, { recipe: SC, param: p(3003) });
      assert.match(read(scriptFile()), /MAX_RAW = '3003'/);
      const mid = await runUndo({}, [batch(2)]);
      assert.match(read(scriptFile()), /MAX_RAW = '3003'/, 'the newest writer still owns the content');
      const last = await runUndo({}, [batch(3)]);
      assert.match(read(scriptFile()), /MAX_RAW = '1001'/, 'with both newer batches gone the first one\'s script is back');
      assert.equal(sessionStart().length, 1);
      const first = await runUndo({}, [batch(1)]);
      for (const out of [mid, last, first]) assert.ok(!out.stdout.includes('--force'), out.stdout);
      assertPristine();
      for (const n of [1, 2, 3]) assert.equal(readManifest(batch(n)).undone, true);
    });

    it('three applies undone in every order end in the pristine state', async () => {
      const orders = [[1, 2, 3], [3, 2, 1], [2, 1, 3], [2, 3, 1], [1, 3, 2], [3, 1, 2]];
      for (const order of orders) {
        fs.rmSync(appliedDir(), { recursive: true, force: true });
        await at(1, { recipe: SC, param: p(1001) });
        await at(2, { recipe: SC, param: p(2002) });
        await at(3, { recipe: SC, param: p(3003) });
        for (const n of order) {
          const { stdout } = await runUndo({}, [batch(n)]);
          assert.ok(!stdout.includes('--force'), `${order.join(',')}: ${stdout}`);
          if (n !== order[2]) {
            assert.ok(fs.existsSync(scriptFile()), `${order.join(',')}: the script is still in use after undoing ${n}`);
            assert.equal(sessionStart().length, 1, `${order.join(',')}: the hook is still wired after undoing ${n}`);
          }
        }
        assertPristine();
      }
    });
  });

  describe('undo --all --dry-run against the real run', () => {
    it('reports the same lines and counts as the real run, without a spurious "modified since apply"', async () => {
      await at(1, { recipe: PH });
      await at(2, { recipe: SC, param: SC_PARAMS });
      const before = snapshotDir(ctx.root);
      const dry = await runUndo({ all: true, 'dry-run': true });
      assert.deepEqual(snapshotDir(ctx.root), before, 'a dry run changes nothing');
      assert.ok(!KEPT.test(dry.stdout), dry.stdout);
      assert.ok(!dry.stdout.includes('--force'), dry.stdout);
      const real = await runUndo({ all: true });
      assert.equal(normalizeUndoOutput(dry.stdout), normalizeUndoOutput(real.stdout));
      assertPristine();
    });

    it('three applies of one recipe: dry run and real run agree', async () => {
      for (const [n, v] of [[1, 1001], [2, 2002], [3, 3003]]) await at(n, { recipe: SC, param: ['hooks.session-context.maxChars=' + v] });
      const dry = await runUndo({ all: true, 'dry-run': true });
      const real = await runUndo({ all: true });
      assert.equal(normalizeUndoOutput(dry.stdout), normalizeUndoOutput(real.stdout));
      assertPristine();
    });

    it('a script the user edited: the dry run says kept, just like the real run', async () => {
      await at(1, { recipe: SC });
      await at(2, { recipe: PH });
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n');
      const dry = await runUndo({ all: true, 'dry-run': true });
      const real = await runUndo({ all: true });
      assert.ok(KEPT.test(dry.stdout), dry.stdout);
      // only the real run writes the journal, so only it adds the hint about the partly undone batch
      assert.equal(normalizeUndoOutput(dry.stdout), normalizeUndoOutput(real.stdout.replace(/\n {2}! [\s\S]*$/, '\n')));
    });
  });

  describe('undo --force on entries of a shared script', () => {
    it('an entry that only relies on the script has nothing to revert: a user edit does not hold it back', async () => {
      await at(1, { recipe: SC, param: SC_PARAMS });
      await at(2, { recipe: PH });
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n');
      const { stdout } = await runUndo({}, [batch(2)]);
      assert.ok(!KEPT.test(stdout), stdout);
      assert.ok(!stdout.includes('--force'), stdout);
      assert.equal(readManifest(batch(2)).undone, true);
      assert.ok(read(scriptFile()).includes('USER EDIT'));
    });

    it('--force on the later writer puts the earlier recipe\'s script back instead of leaving the undone one', async () => {
      await at(1, { recipe: PH });
      const first = read(scriptFile());
      await at(2, { recipe: SC, param: SC_PARAMS });
      fs.appendFileSync(scriptFile(), '\n// USER EDIT\n');
      const plain = await runUndo({}, [batch(2)]);
      assert.ok(KEPT.test(plain.stdout), plain.stdout);
      assert.ok(read(scriptFile()).includes('USER EDIT'), 'without --force the edit is kept');
      const forced = await runUndo({ force: true }, [batch(2)]);
      assert.equal(read(scriptFile()), first, forced.stdout);
      assert.equal(readManifest(batch(2)).undone, true);
      await runUndo({}, [batch(1)]);
      assertPristine();
    });
  });
});

/** The lines of an undo run without the arrow / check mark and the dry-run / done wording, to compare a preview with the real run. */
function normalizeUndoOutput(stdout) {
  return stdout
    .replace(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d\d)?/g, 'ID')
    .replace(/Dry run: nothing reverted\. (\d+) change\(s\) from ID would be reverted\./g, 'N=$1 ID')
    .replace(/Reverted (\d+) change\(s\) from ID\./g, 'N=$1 ID')
    .replace(/^ {2}[→✓] /gm, '  ~ ');
}

// ------------------------------------------------------------------ catalog <-> apply consistency

describe('the recipe catalog against the apply engine', () => {
  const types = [...new Set(loadCatalog().recipes.flatMap((r) => (r.actions || []).map((a) => a.type)))].sort();

  it('has a handler for every action type used in the catalog', () => {
    const missing = types.filter((t) => typeof apply.__test.handlers[t] !== 'function');
    assert.deepEqual(missing, []);
  });

  it('applies and then fully undoes every recipe of the catalog: the configuration returns to its original state', async () => {
    seedState();
    const catalog = loadCatalog();
    const ids = catalog.recipes.filter((r) => (r.actions || []).length).map((r) => r.id);
    const before = { config: readTree(ctx.configDir), global: readJson(ctx.claudeJson) };
    const { manifest } = await runApply({ recipe: ids.join(',') });
    const changed = manifest.recipes.filter((r) => r.actions.length).map((r) => r.id);
    assert.ok(changed.length >= 10, `expected many recipes to apply, got: ${changed.join(', ')}`);
    assert.notDeepEqual(readTree(ctx.configDir), before.config, 'applying must change something');
    const { result } = await runUndo({ all: true });
    assert.ok(result.undone > 0);
    assert.deepEqual(readTree(ctx.configDir), before.config);
    assert.deepEqual(readJson(ctx.claudeJson), before.global);
  });

  it('round-trips each recipe on its own as well', async () => {
    seedState();
    const catalog = loadCatalog();
    const failures = [];
    for (const recipe of catalog.recipes.filter((r) => (r.actions || []).length)) {
      const before = { config: readTree(ctx.configDir), global: readJson(ctx.claudeJson) };
      await runApply({ recipe: recipe.id });
      await runUndo({ all: true });
      try {
        assert.deepEqual(readTree(ctx.configDir), before.config);
        assert.deepEqual(readJson(ctx.claudeJson), before.global);
      } catch (err) {
        failures.push(`${recipe.id}: ${String(err.message).split('\n')[0]}`);
        // restore a pristine home for the next recipe
        restoreEnv();
        ctx = materializeHome();
        restoreEnv = setEnv({ ...ctx.env, CLAUDE_PROJECT_DIR: undefined });
        seedState();
      }
    }
    assert.deepEqual(failures, []);
  });
});

// ------------------------------------------------------------------ code-review regressions

describe('list parameters keep their items (settings.hook.remove, mcp.disable, plugins.disable)', () => {
  it('settings.hook.remove removes every selected command, also the ones that start with a bare interpreter', () => {
    const commands = ['node "C:/x/hooks/a.mjs"', 'bash ~/.claude/hooks/b.sh', 'python3 /opt/hooks/c.py', 'npx eslint --fix', 'uv run lint', 'pwsh -File d.ps1'];
    writeSettings({ hooks: { PostToolUse: commands.map((command) => ({ hooks: [{ type: 'command', command }] })) } });
    const { entry } = run('settings.hook.remove', { type: 'settings.hook.remove', commands: '{params.hooks}' }, { params: { hooks: commands } });
    assert.equal(entry.removed.length, commands.length);
    assert.deepEqual(readSettings().hooks ?? {}, {});
  });

  it('a literal string is split on newlines only, so commas inside a command survive', () => {
    writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo a, b' }] }, { hooks: [{ type: 'command', command: 'bash c.sh' }] }] } });
    const { entry } = run('settings.hook.remove', { type: 'settings.hook.remove', commands: 'echo a, b\nbash c.sh' });
    assert.equal(entry.removed.length, 2);
  });

  it('mcp.disable takes a parameter array as it is', () => {
    const { entry } = run('mcp.disable', { type: 'mcp.disable', servers: '{params.servers}' }, { params: { servers: ['dead-srv', 'used-srv'] } });
    assert.deepEqual(entry.removed.map((r) => r.name), ['dead-srv', 'used-srv']);
  });
});

describe('mcp.disable: servers outside the user scope', () => {
  const action = (servers) => ({ type: 'mcp.disable', servers });
  const proj = () => path.join(ctx.root, 'proj');
  const seedLocal = () => {
    const cfg = readJson(ctx.claudeJson);
    cfg.projects = { [toPosix(proj())]: { mcpServers: { 'local-srv': { type: 'stdio', command: 'node', args: ['local.mjs'] } } } };
    writeJson(ctx.claudeJson, cfg);
    return cfg;
  };

  it('removes a local-scope server of the project, journals it and puts it back on undo', () => {
    const original = seedLocal();
    const { entry, io } = run('mcp.disable', action(['dead-srv', 'local-srv']), { projectDir: proj() });
    assert.deepEqual(entry.removed.map((r) => [r.name, r.where || 'user']), [['dead-srv', 'user'], ['local-srv', 'local']]);
    const after = readJson(ctx.claudeJson);
    assert.deepEqual(after.projects[toPosix(proj())].mcpServers, {});
    assert.ok(!('dead-srv' in after.mcpServers));
    assert.deepEqual(io.notes, []);
    assert.equal(undoEntry(entry).result, 'ok');
    assert.deepEqual(readJson(ctx.claudeJson), original);
  });

  it('says which selected servers it did not remove instead of dropping them silently', () => {
    const { entry, io } = run('mcp.disable', action(['dead-srv', 'ghost']));
    assert.deepEqual(entry.removed.map((r) => r.name), ['dead-srv']);
    assert.ok(io.notes.some((n) => /not removed.*ghost/.test(n)), io.notes.join('|'));
  });

  it('names the missing servers in the skip reason', () => {
    const { entry } = run('mcp.disable', action(['ghost', 'phantom']));
    assert.equal(entry.skipped, true);
    assert.match(entry.reason, /servers not found.*ghost, phantom/);
  });

  it('leaves a server of the shared .mcp.json alone and tells the user', () => {
    writeJson(path.join(proj(), '.mcp.json'), { mcpServers: { 'team-srv': { command: 'node' } } });
    const before = read(path.join(proj(), '.mcp.json'));
    const { entry, io } = run('mcp.disable', action(['dead-srv', 'team-srv']), { projectDir: proj() });
    assert.deepEqual(entry.removed.map((r) => r.name), ['dead-srv']);
    assert.ok(io.notes.some((n) => /team-srv/.test(n) && /\.mcp\.json/.test(n)), io.notes.join('|'));
    assert.equal(read(path.join(proj(), '.mcp.json')), before);
  });

  it('cmdApply prints those notes under the recipe', async () => {
    seedState();
    const { stdout } = await runApply({ recipe: 'context.mcp-unused', param: 'context.mcp-unused.servers=dead-srv,ghost' });
    assert.match(stdout, /· context\.mcp-unused: not removed .*ghost/);
  });
});

describe('claude-md.block undo respects edits made after apply', () => {
  const action = (over = {}) => ({ type: 'claude-md.block', id: 'language', content: 'Answer in Russian.', ...over });
  const claudeMd = () => path.join(ctx.configDir, 'CLAUDE.md');

  it('journals a hash of the block and removes an untouched block', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action());
    assert.match(entry.hash, /^[0-9a-f]{16}$/);
    assert.equal(undoEntry(entry).result, 'ok');
    assert.equal(read(claudeMd()), 'Top.\n');
  });

  it('keeps the block (and says so) when the user edited it', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action());
    const edited = read(claudeMd()).replace('Answer in Russian.', 'Answer in Russian.\nUse formal address.');
    writeText(claudeMd(), edited);
    const { result } = undoEntry(entry);
    assert.match(result, /^kept: .*CLAUDE\.md block "language" modified since apply/);
    assert.equal(read(claudeMd()), edited);
  });

  it('is not fooled by CRLF line endings the editor wrote', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action());
    writeText(claudeMd(), read(claudeMd()).replace(/\n/g, '\r\n'));
    assert.equal(undoEntry(entry).result, 'ok');
  });

  it('still undoes journals written before the hash existed', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action());
    delete entry.hash;
    writeText(claudeMd(), read(claudeMd()).replace('Answer in Russian.', 'Edited.'));
    assert.equal(undoEntry(entry).result, 'ok');
  });
});

describe('claude-md.block with CRLF text (a --param-file saved on Windows)', () => {
  const claudeMd = () => path.join(ctx.configDir, 'CLAUDE.md');
  const action = () => ({ type: 'claude-md.block', id: 'rules', content: '- rule one\r\n- rule two\r\n' });
  const BLOCK = '<!-- kaizen:start rules -->\n- rule one\n- rule two\n<!-- kaizen:end rules -->';

  it('writes the body with LF line endings and journals the hash of exactly that text', () => {
    writeText(claudeMd(), 'Top.\n');
    const { entry } = run('claude-md.block', action());
    assert.ok(read(claudeMd()).includes(BLOCK), JSON.stringify(read(claudeMd())));
    assert.ok(!read(claudeMd()).includes('\r'));
    assert.equal(entry.hash, apply.__test.sha(BLOCK));
    assert.equal(undoEntry(entry).result, 'ok');
    assert.equal(read(claudeMd()), 'Top.\n');
  });

  it('treats a lone CR like a line break too', () => {
    writeText(claudeMd(), 'Top.\n');
    run('claude-md.block', { ...action(), content: '- rule one\r- rule two' });
    assert.ok(read(claudeMd()).includes(BLOCK));
  });

  it('a re-apply of the same CRLF text is "block unchanged", even when the editor converted the file to CRLF', () => {
    writeText(claudeMd(), 'Top.\n');
    run('claude-md.block', action());
    writeText(claudeMd(), read(claudeMd()).replace(/\n/g, '\r\n'));
    const { entry } = run('claude-md.block', action());
    assert.equal(entry.skipped, true);
    assert.equal(entry.reason, 'block unchanged');
  });

  it('still undoes a journal whose hash was taken on the raw CRLF block (written before the body was normalised)', () => {
    const raw = BLOCK.replace(/\n/g, '\r\n');
    writeText(claudeMd(), `Top.\n\n${raw}\n`);
    const entry = { type: 'claude-md.block', file: claudeMd(), id: 'rules', existedBefore: true, previousBlock: null, tail: '\n', hash: apply.__test.sha(raw) };
    assert.equal(undoEntry(entry).result, 'ok');
    assert.equal(read(claudeMd()), 'Top.\n');
  });

  it('apply --param-file with CRLF text, then undo --last, removes the block and marks the batch undone', async () => {
    seedState();
    const extra = path.join(ctx.root, 'extra.json');
    writeJson(extra, {
      recipes: [{
        id: 'custom.house-rules',
        category: 'claude-md',
        impact: 'medium',
        title: { en: 'House rules', ru: 'Правила' },
        why: { en: 'w', ru: 'п' },
        evidence: { en: 'e', ru: 'д' },
        when: true,
        params: [{ name: 'rules', type: 'text', default: '', label: { en: 'Rules', ru: 'Правила' } }],
        actions: [{ type: 'claude-md.block', id: 'house-rules', content: '{params.rules}' }],
      }],
    });
    const rules = path.join(ctx.root, 'rules.txt');
    fs.writeFileSync(rules, '- rule one\r\n- rule two\r\n', 'utf8');
    await runApply({ recipe: 'custom.house-rules', add: extra, 'param-file': `custom.house-rules.rules=${rules}` });
    assert.ok(read(claudeMd()).includes('- rule one\n- rule two\n<!-- kaizen:end house-rules -->'), JSON.stringify(read(claudeMd())));
    const { stdout } = await runUndo();
    assert.ok(stdout.includes(prefixOf('cli.undo_done', { n: 1 })), stdout);
    assert.ok(!fs.existsSync(claudeMd()) || !read(claudeMd()).includes('kaizen:start'));
    const m = readManifest(manifestIds()[0]);
    assert.equal(m.undone, true);
    assert.equal(m.partiallyUndone, undefined);
  });
});

describe('cmdUndo: entries that were kept', () => {
  const hookFile = () => path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
  const applyAndEditHook = async () => {
    seedState();
    await runApply({ recipe: 'hooks.guard-destructive' });
    fs.appendFileSync(hookFile(), '\n// tuned by hand\n');
  };

  it('does not mark the batch undone: it stays in the journal for the kept entry and says how to finish', async () => {
    await applyAndEditHook();
    const { stdout } = await runUndo();
    const m = readManifest(manifestIds()[0]);
    assert.notEqual(m.undone, true);
    assert.equal(m.partiallyUndone, true);
    assert.ok(Number.isFinite(Date.parse(m.partiallyUndoneAt)));
    const entries = m.recipes[0].actions;
    assert.equal(entries.find((e) => e.type === 'settings.hook').undone, true, 'the reverted entry is marked');
    assert.equal(entries.find((e) => e.type === 'file').undone, undefined, 'the kept entry stays open');
    assert.match(stdout, /only partly undone/);
    assert.match(stdout, /undo \d{4}-[\d-T]+ --force/);
    assert.ok(stdout.includes(path.join(appliedDir(), manifestIds()[0], 'backups')), stdout);
  });

  it('a second undo retries only the kept entry and leaves the already reverted ones alone', async () => {
    await applyAndEditHook();
    await runUndo();
    const again = await runUndo();
    assert.equal(again.result.undone, 0);
    assert.doesNotMatch(again.stdout, /settings\.hook/, 'the reverted hook entry must not be reported again');
    assert.match(again.stdout, /file: kept: .*modified since apply/);
    assert.ok(fs.existsSync(hookFile()));
    assert.equal(readManifest(manifestIds()[0]).partiallyUndone, true);
  });

  it('--force reverts the kept entry too, saves the edited file first, and then the batch is undone', async () => {
    await applyAndEditHook();
    await runUndo();
    const edited = read(hookFile());
    const forced = await runUndo({ force: true });
    assert.equal(forced.result.undone, 1);
    assert.ok(!fs.existsSync(hookFile()));
    const m = readManifest(manifestIds()[0]);
    assert.equal(m.undone, true);
    assert.equal(m.partiallyUndone, undefined);
    assert.doesNotMatch(forced.stdout, /only partly undone/);
    const undoDir = path.join(appliedDir(), manifestIds()[0], 'undo');
    // every undo run has its own folder of backups
    const runs = fs.readdirSync(undoDir);
    assert.equal(runs.length, 2, 'the partial run and the --force run each have a folder');
    const saved = runs.map((r) => path.join(undoDir, r, 'backups')).filter((d) => fs.existsSync(d));
    assert.ok(saved.some((dir) => fs.readdirSync(dir).some((f) => /guard-destructive\.mjs$/.test(f) && read(path.join(dir, f)) === edited)), 'the edited script must be backed up');
  });

  it('--force also takes a CLAUDE.md block that was edited after apply', async () => {
    seedState();
    const claudeMd = path.join(ctx.configDir, 'CLAUDE.md');
    await runApply({ recipe: 'claude-md.read-before-edit' });
    writeText(claudeMd, read(claudeMd).replace(/(<!-- kaizen:start read-before-edit -->\n)/, '$1Edited by hand.\n'));
    const kept = await runUndo();
    assert.match(kept.stdout, /block "read-before-edit" modified since apply/);
    assert.ok(read(claudeMd).includes('kaizen:start read-before-edit'));
    assert.equal(readManifest(manifestIds()[0]).partiallyUndone, true);
    await runUndo({ force: true });
    assert.ok(!fs.existsSync(claudeMd) || !read(claudeMd).includes('kaizen:start'));
    assert.equal(readManifest(manifestIds()[0]).undone, true);
  });

  it('--dry-run changes nothing in the journal, not even for kept entries', async () => {
    await applyAndEditHook();
    await runUndo({ 'dry-run': true });
    const m = readManifest(manifestIds()[0]);
    assert.equal(m.partiallyUndone, undefined);
    assert.equal(m.recipes[0].actions.some((e) => e.undone), false);
  });

  it('a kept file stays owned by Kaizen while its batch is only partly undone', async () => {
    await applyAndEditHook();
    await runUndo();
    assert.ok(apply.__test.makeIo({ dry: true, force: false, measure: null, batchDir: ctx.root, recipeId: null }).ownedFiles.has(path.resolve(hookFile())));
  });
});

describe('backups of a batch', () => {
  it('keep the file as it was before the batch when a second recipe touches the same file', async () => {
    seedState();
    const original = read(ctx.settingsFile);
    await runApply({ recipe: 'settings.cleanup-period,permissions.deny-secrets' });
    const [id] = manifestIds();
    const dir = path.join(appliedDir(), id, 'backups');
    const copies = fs.readdirSync(dir).filter((f) => /settings\.json$/.test(f));
    assert.equal(copies.length, 1);
    assert.equal(read(path.join(dir, copies[0])), original);
  });
});

describe('cmdApply: scope', () => {
  for (const scope of ['local', 'projekt', 'Project', true]) {
    it(`refuses scope ${JSON.stringify(scope)} before writing anything`, async () => {
      seedState();
      const before = snapshotDir(ctx.root);
      await assert.rejects(runApply({ recipe: 'settings.cleanup-period', scope }), /bad scope/);
      assert.deepEqual(snapshotDir(ctx.root), before);
    });
  }

  it('refuses a scope from choices.json too', async () => {
    seedState();
    writeJson(path.join(ctx.stateDir, 'choices.json'), { version: 1, selected: [{ id: 'settings.cleanup-period', scope: 'local', params: {} }], discuss: [], notes: '' });
    await assert.rejects(runApply({}), /bad scope "local" for settings\.cleanup-period/);
    assert.ok(!fs.existsSync(appliedDir()));
  });

  it('warns when the scope is not one the recipe lists, and still applies', async () => {
    seedState();
    const proj = path.join(ctx.root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const { stdout } = await runApply({ recipe: 'settings.cleanup-period', scope: 'project', project: proj });
    assert.match(stdout, /! settings\.cleanup-period: scope project is not one of the scopes this recipe lists/);
  });
});

describe('cmdApply: recipes that wrote nothing are not recorded as applied', () => {
  it('keeps them out of last-apply.json (the manifest still shows what was skipped)', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period' });
    await runApply({ recipe: 'settings.cleanup-period,permissions.deny-secrets' });
    const last = readJson(path.join(ctx.stateDir, 'last-apply.json'));
    assert.deepEqual(last.recipes, ['permissions.deny-secrets']);
    assert.deepEqual(readManifest(last.id).recipes.map((r) => r.id), ['settings.cleanup-period', 'permissions.deny-secrets']);
  });
});

describe('cmdApply: --param-file', () => {
  const customFile = () => path.join(ctx.root, 'extra.json');
  const custom = () => ({
    id: 'custom.house-rules',
    category: 'claude-md',
    impact: 'medium',
    title: { en: 'House rules', ru: 'Правила' },
    why: { en: 'w', ru: 'п' },
    evidence: { en: 'e', ru: 'д' },
    when: true,
    params: [{ name: 'rules', type: 'text', default: '', label: { en: 'Rules', ru: 'Правила' } }],
    actions: [{ type: 'claude-md.block', id: 'house-rules', content: '{params.rules}' }],
  });

  it('uses the file content as the value, multi-line and with commas, and strips a BOM', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    const rules = path.join(ctx.root, 'rules.md');
    fs.writeFileSync(rules, '\uFEFFRule one, with a comma.\n\nRule two: "quoted" \\ backslash.\n', 'utf8');
    await runApply({ recipe: 'custom.house-rules', add: customFile(), 'param-file': `custom.house-rules.rules=${rules}` });
    const text = read(path.join(ctx.configDir, 'CLAUDE.md'));
    assert.ok(text.includes('Rule one, with a comma.\n\nRule two: "quoted" \\ backslash.'), text);
    assert.ok(!text.includes('\uFEFF'));
  });

  it('rejects an unreadable file, a recipe that is not selected and a malformed spec', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    const missing = path.join(ctx.root, 'missing.md');
    await assert.rejects(runApply({ recipe: 'custom.house-rules', add: customFile(), 'param-file': `custom.house-rules.rules=${missing}` }), /--param-file custom\.house-rules\.rules: cannot read/);
    const rules = path.join(ctx.root, 'r.md');
    writeText(rules, 'x');
    await assert.rejects(runApply({ recipe: 'custom.house-rules', add: customFile(), 'param-file': `other.recipe.rules=${rules}` }), /not among the selected recipes/);
    await assert.rejects(runApply({ recipe: 'custom.house-rules', add: customFile(), 'param-file': 'garbage' }), /--param-file expects/);
  });

  it('a plain --param still splits on commas', async () => {
    seedState();
    const { manifest } = await runApply({ recipe: 'context.mcp-unused', param: 'context.mcp-unused.servers=dead-srv,ghost' });
    assert.deepEqual(manifest.recipes[0].params.servers, ['dead-srv', 'ghost']);
  });
});

describe('cmdApply: extra (custom) recipes', () => {
  const customFile = () => path.join(ctx.root, 'extra.json');
  const custom = () => ({
    id: 'custom.cleanup',
    category: 'settings',
    impact: 'low',
    title: { en: 'Custom cleanup', ru: 'Своя очистка' },
    why: { en: 'w', ru: 'п' },
    evidence: { en: 'e', ru: 'д' },
    when: true,
    actions: [{ type: 'settings.set', path: 'cleanupPeriodDays', value: 14 }],
  });

  it('applies a custom recipe from --add', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    await runApply({ recipe: 'custom.cleanup', add: customFile() });
    assert.equal(readSettings().cleanupPeriodDays, 14);
  });

  it('finds the extra file recorded in recommendations.json when --add is not given', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    const recFile = path.join(ctx.stateDir, 'recommendations.json');
    writeJson(recFile, { ...readJson(recFile), extraFile: customFile() });
    await runApply({ recipe: 'custom.cleanup' });
    assert.equal(readSettings().cleanupPeriodDays, 14);
  });

  it('finds the extra file recorded in recommendations.all.json (recommend --all --add) when recommendations.json has none', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    const allFile = path.join(ctx.stateDir, 'recommendations.all.json');
    writeJson(allFile, { ...readJson(path.join(ctx.stateDir, 'recommendations.json')), extraFile: customFile() });
    await runApply({ recipe: 'custom.cleanup' });
    assert.equal(readSettings().cleanupPeriodDays, 14);
  });

  it('prefers the extra file of recommendations.json over the one of recommendations.all.json', async () => {
    seedState();
    writeJson(customFile(), { recipes: [custom()] });
    const recFile = path.join(ctx.stateDir, 'recommendations.json');
    writeJson(recFile, { ...readJson(recFile), extraFile: customFile() });
    const other = path.join(ctx.root, 'other.json');
    writeJson(other, { recipes: [{ ...custom(), id: 'custom.other' }] });
    writeJson(path.join(ctx.stateDir, 'recommendations.all.json'), { ...readJson(recFile), extraFile: other });
    const { stdout } = await runApply({ recipe: 'custom.cleanup,custom.other' });
    assert.match(stdout, /! unknown recipe custom\.other \(skipped\)/);
    assert.equal(readSettings().cleanupPeriodDays, 14);
  });

  it('prints a visible warning for an unknown id, with a hint for custom ones', async () => {
    seedState();
    const { stdout } = await runApply({ recipe: 'custom.cleanup,settings.cleanup-period' });
    assert.match(stdout, /! unknown recipe custom\.cleanup \(skipped\) - custom recipes need --add FILE/);
    assert.equal(readSettings().cleanupPeriodDays, 90);
  });

  it('ignores a recorded extra file that is gone, but fails on a --add file that cannot be read', async () => {
    seedState();
    const recFile = path.join(ctx.stateDir, 'recommendations.json');
    writeJson(recFile, { ...readJson(recFile), extraFile: path.join(ctx.root, 'gone.json') });
    const { stdout } = await runApply({ recipe: 'settings.cleanup-period' });
    assert.ok(stdout.includes(prefixOf('cli.apply_done', { n: 1 })), stdout);
    await assert.rejects(runApply({ recipe: 'settings.cleanup-period', add: path.join(ctx.root, 'gone.json') }), /--add: cannot read/);
  });
});

describe('loadChoices reads recommendations.all.json for ids the normal file does not have', () => {
  it('takes the parameter values from the --all listing', () => {
    seedState();
    const rec = readJson(path.join(ctx.stateDir, 'recommendations.json'));
    const hidden = rec.recommendations.find((r) => r.id === 'settings.cleanup-period');
    writeJson(path.join(ctx.stateDir, 'recommendations.json'), { ...rec, recommendations: rec.recommendations.filter((r) => r.id !== hidden.id) });
    writeJson(path.join(ctx.stateDir, 'recommendations.all.json'), { ...rec, recommendations: [{ ...hidden, scope: 'project', params: [{ name: 'days', value: 7 }] }] });
    const choices = apply.loadChoices({ _: ['apply'], flags: { recipe: 'settings.cleanup-period' } });
    assert.deepEqual(choices.selected[0].params, { days: 7 });
  });
});

describe('cmdApply: unknown recipe ids', () => {
  const lastApply = () => path.join(ctx.stateDir, 'last-apply.json');

  it('fails when every selected id is unknown: no journal batch, last-apply.json untouched, close matches suggested', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period' });
    const before = read(lastApply());
    const ids = manifestIds();
    await assert.rejects(() => runApply({ recipe: 'hooks.guard-destruct' }), (e) => {
      assert.equal(e.name, 'UserError');
      assert.ok(e.message.includes('hooks.guard-destruct'), e.message);
      assert.ok(e.message.includes('hooks.guard-destructive'), `suggests the close match: ${e.message}`);
      return true;
    });
    assert.deepEqual(manifestIds(), ids);
    assert.equal(read(lastApply()), before);
  });

  it('also fails on --dry-run, and the message is localized', async () => {
    seedState();
    await assert.rejects(() => runApply({ recipe: 'no.such-recipe', 'dry-run': true }, { lang: 'ru' }), /Неизвестные id рецептов: no\.such-recipe\. Ничего не применено\./);
    assert.deepEqual(manifestIds(), []);
    assert.ok(!fs.existsSync(lastApply()));
  });

  it('a mixed list still skips the unknown id with a warning', async () => {
    seedState();
    const { stdout, manifest } = await runApply({ recipe: 'no.such-recipe,settings.cleanup-period' });
    assert.ok(stdout.includes(t('apply.unknown_recipe', { id: 'no.such-recipe' })), stdout);
    assert.equal(manifest.recipes.length, 1);
    assert.equal(manifestIds().length, 1);
  });
});

describe('cmdApply and cmdUndo speak the chosen language', () => {
  const undoIn = async (lang, flags = {}, positional = []) => {
    const out = await captureOutput(() => apply.cmdUndo({ _: ['undo', ...positional], flags }, { pickLang: () => lang }));
    return out.stdout;
  };

  it('prints the plan lines of apply --dry-run and the skip reasons in Russian', async () => {
    seedState();
    const dry = await runApply({ recipe: 'permissions.deny-secrets', 'dry-run': true }, { lang: 'ru' });
    assert.match(dry.stdout, /→ .*settings\.json: дополнить permissions\.deny: Read\(\.\/\.env\)/);
    assert.doesNotMatch(dry.stdout, /append to/);
    await runApply({ recipe: 'settings.cleanup-period' });
    const again = await runApply({ recipe: 'settings.cleanup-period' }, { lang: 'ru' });
    assert.match(again.stdout, /settings\.cleanup-period: уже задано/);
  });

  it('prints file plan lines and the unknown-recipe warning in Russian', async () => {
    seedState();
    const { stdout } = await runApply({ recipe: 'no.such,hooks.guard-destructive' }, { lang: 'ru' });
    assert.match(stdout, /! неизвестный рецепт no\.such \(пропущен\)/);
    assert.match(stdout, /guard-destructive\.mjs: создать \(\d+ симв\.\)/);
    assert.match(stdout, /добавить хук PreToolUse/);
  });

  it('prints the undo plan and the kept results in Russian, and english stays english', async () => {
    seedState();
    await runApply({ recipe: 'hooks.guard-destructive' });
    const hook = path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
    writeText(hook, read(hook) + '\n// edited\n');
    const ru = await undoIn('ru');
    assert.match(ru, /✓ .*settings\.json: убрать хук PreToolUse/);
    assert.match(ru, /file: оставлено: .* изменён после apply/);
    assert.match(ru, /Изменений оставлено на месте: 1 \(см\. «оставлено»\/«ошибка» выше\)/);
    const en = await undoIn('en');
    assert.match(en, /file: kept: .*modified since apply/);
    const gone = await undoIn('ru', { force: true });
    assert.match(gone, /guard-destructive\.mjs: удалить/);
  });
});

describe('cmdUndo: the backups the partial-undo message talks about', () => {
  const undoDirOf = (id) => path.join(appliedDir(), id, 'undo');

  it('names the undo folder without claiming a backups folder that does not exist', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period' });
    writeSettings({ ...readSettings(), cleanupPeriodDays: 7 });
    const id = manifestIds()[0];
    const { stdout } = await runUndo();
    assert.match(stdout, /changed since apply/);
    assert.ok(!fs.existsSync(path.join(undoDirOf(id), 'backups')), 'nothing was backed up by this run');
    assert.ok(!stdout.includes(path.join(undoDirOf(id), 'backups')), stdout);
    assert.ok(stdout.includes(`backed up first, in a new folder under ${undoDirOf(id)}`), stdout);
    // the "before apply" line points at a folder that does exist (settings.json was copied there by apply)
    assert.ok(fs.existsSync(path.join(appliedDir(), id, 'backups')));
    assert.ok(stdout.includes(t('cli.undo_partial_before', { before: path.join(appliedDir(), id, 'backups') })), stdout);
  });

  it('does not print the "before apply" line when apply backed nothing up', async () => {
    seedState();
    await runApply({ recipe: 'hooks.guard-destructive' });
    const id = manifestIds()[0];
    fs.rmSync(path.join(appliedDir(), id, 'backups'), { recursive: true, force: true });
    const hook = path.join(ctx.stateDir, 'hooks', 'guard-destructive.mjs');
    writeText(hook, read(hook) + '\n// edited\n');
    const { stdout } = await runUndo();
    assert.match(stdout, /only partly undone/);
    assert.ok(!stdout.includes(prefixOf('cli.undo_partial_before', {})), stdout);
  });

  it('a --force run after a partial undo saves the edits made in between (every run has its own backups)', async () => {
    seedState();
    await runApply({ recipe: 'settings.cleanup-period,permissions.accept-edits', scope: 'user' });
    const id = manifestIds()[0];
    writeSettings({ ...readSettings(), cleanupPeriodDays: 11 });
    await runUndo(); // accept-edits is reverted (settings.json is saved), cleanupPeriodDays is kept
    assert.equal(readSettings().cleanupPeriodDays, 11);
    writeSettings({ ...readSettings(), cleanupPeriodDays: 22 });
    await runUndo({ force: true }, [id]);
    assert.ok(!('cleanupPeriodDays' in readSettings()));
    const saved = fs.readdirSync(undoDirOf(id)).flatMap((run) => {
      const dir = path.join(undoDirOf(id), run, 'backups');
      return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => readJson(path.join(dir, f))) : [];
    });
    assert.ok(saved.some((s) => s.cleanupPeriodDays === 11), 'the state before the partial undo is kept');
    assert.ok(saved.some((s) => s.cleanupPeriodDays === 22), 'the state before the --force run is kept too');
  });
});
