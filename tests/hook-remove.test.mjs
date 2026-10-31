// settings.hook.remove: removing failing hook entries from settings.json and restoring them on undo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp;
let apply;
let settingsFile;

const SETTINGS = {
  hooks: {
    PostToolUse: [
      { hooks: [{ type: 'command', command: 'node "C:/x/hooks/post-tool-use.mjs"' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node "C:/x/hooks/format.mjs"', timeout: 20 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/hooks/stop.mjs"' }] }],
  },
  permissions: { allow: ['Bash(git status *)'] },
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-hook-remove-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.KAIZEN_STATE_DIR = path.join(tmp, 'state');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(SETTINGS, null, 2) + '\n');
  apply = await import('../scripts/lib/apply.mjs');
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('settings.hook.remove removes exactly the selected commands and undo restores them', () => {
  const { handlers, makeIo, undoEntry } = apply.__test;
  const ctx = apply.buildContext({ scope: 'user', projectDir: null, params: { hooks: ['node "C:/x/hooks/post-tool-use.mjs"', 'node "C:/x/hooks/stop.mjs"'] } });
  const io = makeIo({ dry: false, force: false, measure: null, batchDir: path.join(tmp, 'batch'), recipeId: 'hooks.disable-failing' });
  const entry = handlers['settings.hook.remove']({ type: 'settings.hook.remove', commands: '{params.hooks}' }, ctx, io);
  assert.equal(entry.type, 'settings.hook.remove');
  assert.equal(entry.removed.length, 2);

  const after1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(after1.hooks.Stop, undefined, 'empty event removed');
  assert.equal(after1.hooks.PostToolUse.length, 1, 'only the formatter group stays');
  assert.equal(after1.hooks.PostToolUse[0].matcher, 'Edit|Write');
  assert.deepEqual(after1.permissions, SETTINGS.permissions, 'unrelated keys untouched');

  // dry run on an already-clean file reports nothing to do
  const io2 = makeIo({ dry: true, force: false, measure: null, batchDir: path.join(tmp, 'batch2'), recipeId: 'x' });
  const again = handlers['settings.hook.remove']({ type: 'settings.hook.remove', commands: 'node "C:/x/hooks/stop.mjs"' }, ctx, io2);
  assert.equal(again.skipped, true);

  // undo puts both entries back (matcher-less groups) and leaves the formatter alone
  const io3 = makeIo({ dry: false, force: true, measure: null, batchDir: path.join(tmp, 'undo'), recipeId: null });
  assert.equal(undoEntry(entry, io3), 'ok');
  const restored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(restored.hooks.Stop.length, 1);
  assert.equal(restored.hooks.Stop[0].hooks[0].command, 'node "C:/x/hooks/stop.mjs"');
  assert.equal(restored.hooks.PostToolUse.length, 2);
  const cmds = restored.hooks.PostToolUse.flatMap((g) => g.hooks.map((h) => h.command)).sort();
  assert.deepEqual(cmds, ['node "C:/x/hooks/format.mjs"', 'node "C:/x/hooks/post-tool-use.mjs"']);
  // a second undo is a no-op
  assert.equal(undoEntry(entry, io3), 'hooks already present');
});
