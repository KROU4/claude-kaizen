// scripts/lib/platform.mjs: finding executables, opening a browser, the Node command pinned into hooks, claudeVersion.
// Nothing here starts a real browser: openers are looked up on a PATH that holds only a throw-away directory.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findOnPath, nodeCommand, openInBrowser } from '../scripts/lib/platform.mjs';
import { KIT_ROOT, childEnv, cleanupTempDirs, makeTempDir, setEnv, writeText } from './helpers.mjs';

after(() => cleanupTempDirs());

const isWin = process.platform === 'win32';

/** Run fn with process.execPath replaced (it is a plain writable property). */
function withExecPath(value, fn) {
  const original = process.execPath;
  process.execPath = value;
  try {
    return fn();
  } finally {
    process.execPath = original;
  }
}

describe('findOnPath', () => {
  it('finds an executable in a PATH directory and returns null for a missing one', () => {
    const dir = makeTempDir('kaizen-path-');
    const name = isWin ? 'fake-opener.cmd' : 'fake-opener';
    const file = path.join(dir, name);
    writeText(file, isWin ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
    if (!isWin) fs.chmodSync(file, 0o755);
    const undo = setEnv({ PATH: dir, Path: dir });
    try {
      assert.equal(String(findOnPath('fake-opener')).toLowerCase(), file.toLowerCase()); // PATHEXT may be upper case on Windows
      assert.equal(findOnPath('no-such-opener-0a1b2c'), null);
    } finally {
      undo();
    }
  });

  it('ignores a file that is not executable (POSIX) and empty PATH entries', () => {
    const dir = makeTempDir('kaizen-path-');
    writeText(path.join(dir, 'plain-file'), 'data');
    if (!isWin) fs.chmodSync(path.join(dir, 'plain-file'), 0o644);
    const undo = setEnv({ PATH: `${path.delimiter}${dir}${path.delimiter}`, Path: `${path.delimiter}${dir}${path.delimiter}` });
    try {
      if (!isWin) assert.equal(findOnPath('plain-file'), null);
      assert.equal(findOnPath('absent'), null);
    } finally {
      undo();
    }
  });
});

describe('openInBrowser', { skip: isWin ? 'the Windows opener (cmd start) always exists and would open a real browser' : false }, () => {
  it('returns false when no opener is installed (spawn reports ENOENT only after returning, so PATH is checked first)', () => {
    const empty = makeTempDir('kaizen-nopath-');
    const undo = setEnv({ PATH: empty });
    try {
      assert.equal(openInBrowser('http://127.0.0.1:1/'), false);
    } finally {
      undo();
    }
  });

  it('returns true when the opener exists', () => {
    const dir = makeTempDir('kaizen-opener-');
    const openers = process.platform === 'darwin' ? ['open'] : ['xdg-open', 'cmd.exe'];
    for (const name of openers) {
      const file = path.join(dir, name);
      writeText(file, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(file, 0o755);
    }
    const undo = setEnv({ PATH: dir });
    try {
      assert.equal(openInBrowser('http://127.0.0.1:1/'), true);
    } finally {
      undo();
    }
  });
});

describe('nodeCommand', () => {
  const makeLink = (target, link) => {
    try {
      fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  };

  it('pins the real installation when node was started through an fnm per-shell junction', (t) => {
    const root = makeTempDir('kaizen-fnm-');
    const real = path.join(root, 'node-versions', 'v99.0.0', 'installation');
    fs.mkdirSync(real, { recursive: true });
    const exeName = isWin ? 'node.exe' : 'node';
    writeText(path.join(real, exeName), 'binary');
    const shellDir = path.join(root, 'fnm_multishells');
    fs.mkdirSync(shellDir, { recursive: true });
    const link = path.join(shellDir, '1234_1700000000000');
    if (!makeLink(real, link)) return t.skip('cannot create a link here');
    const cmd = withExecPath(path.join(link, exeName), () => nodeCommand());
    assert.equal(fs.realpathSync.native(cmd.replace(/^"|"$/g, '')), fs.realpathSync.native(path.join(real, exeName)));
    assert.ok(!/fnm_multishells/i.test(cmd), cmd);
  });

  it('keeps the path of other launchers as it is (a stable symlink is better than the version it points to)', (t) => {
    const root = makeTempDir('kaizen-stable-');
    const real = path.join(root, 'v20.1.0');
    fs.mkdirSync(real, { recursive: true });
    const exeName = isWin ? 'node.exe' : 'node';
    writeText(path.join(real, exeName), 'binary');
    const link = path.join(root, 'nodejs');
    if (!makeLink(real, link)) return t.skip('cannot create a link here');
    const exe = path.join(link, exeName);
    assert.equal(withExecPath(exe, () => nodeCommand()), /\s/.test(exe) ? `"${exe}"` : exe);
  });

  it('falls back to the given path when it cannot be resolved', () => {
    const exe = path.join(makeTempDir('kaizen-gone-'), 'fnm_multishells', '1_2', 'node.exe');
    assert.equal(withExecPath(exe, () => nodeCommand()), /\s/.test(exe) ? `"${exe}"` : exe);
  });
});

describe('claudeVersion', () => {
  it('raises no deprecation warning (Node 24 deprecates passing args together with shell: true)', () => {
    const script = `import(${JSON.stringify(new URL('../scripts/lib/platform.mjs', import.meta.url).href)}).then((m) => { m.claudeVersion(); console.log('done'); });`;
    const r = spawnSync(process.execPath, ['--pending-deprecation', '--throw-deprecation', '--input-type=module', '-e', script], { encoding: 'utf8', env: childEnv(), cwd: KIT_ROOT, timeout: 30000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!/DEP0190|DeprecationWarning/.test(r.stderr), r.stderr);
    assert.match(r.stdout, /done/);
  });
});
