// scripts/lib/paths.mjs and scripts/lib/platform.mjs: path arithmetic, JSON helpers and small platform probes.
// Environment variables are changed per test (HOME/USERPROFILE/CLAUDE_CONFIG_DIR/KAIZEN_STATE_DIR) and restored afterwards.
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configDir,
  encodeProjectDir,
  ensureDir,
  exists,
  expandHome,
  homeDir,
  kitRoot,
  projectsDir,
  readJsonSafe,
  settingsFiles,
  stateDir,
  toPosix,
  usageDataDir,
  writeJsonAtomic,
} from '../scripts/lib/paths.mjs';
import { claudeVersion, isWSL, nodeCommand, platformSummary, which } from '../scripts/lib/platform.mjs';
import { KIT_ROOT, cleanupTempDirs, makeTempDir, setEnv, writeText } from './helpers.mjs';

let restore;
let root;
beforeEach(() => {
  root = makeTempDir('kaizen-paths-');
  restore = setEnv({ HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: undefined, KAIZEN_STATE_DIR: undefined });
});
afterEach(() => restore());
after(() => cleanupTempDirs());

describe('homeDir, configDir and stateDir', () => {
  it('homeDir follows HOME / USERPROFILE', () => {
    assert.equal(path.resolve(homeDir()), path.resolve(root));
  });

  it('configDir defaults to ~/.claude', () => {
    assert.equal(configDir(), path.join(homeDir(), '.claude'));
  });

  it('configDir honours CLAUDE_CONFIG_DIR, read at call time', () => {
    const other = path.join(root, 'elsewhere');
    const undo = setEnv({ CLAUDE_CONFIG_DIR: other });
    assert.equal(configDir(), other);
    undo();
    assert.equal(configDir(), path.join(homeDir(), '.claude'));
  });

  it('stateDir defaults to <config dir>/kaizen and follows the config dir', () => {
    assert.equal(stateDir(), path.join(homeDir(), '.claude', 'kaizen'));
    const undo = setEnv({ CLAUDE_CONFIG_DIR: path.join(root, 'cfg') });
    assert.equal(stateDir(), path.join(root, 'cfg', 'kaizen'));
    undo();
  });

  it('KAIZEN_STATE_DIR wins over everything', () => {
    const undo = setEnv({ KAIZEN_STATE_DIR: path.join(root, 'state'), CLAUDE_CONFIG_DIR: path.join(root, 'cfg') });
    assert.equal(stateDir(), path.join(root, 'state'));
    undo();
  });

  it('projectsDir and usageDataDir sit under the config dir unless told otherwise', () => {
    assert.equal(projectsDir(), path.join(configDir(), 'projects'));
    assert.equal(usageDataDir(), path.join(configDir(), 'usage-data'));
    assert.equal(projectsDir('/x'), path.join('/x', 'projects'));
    assert.equal(usageDataDir('/x'), path.join('/x', 'usage-data'));
  });

  it('kitRoot is the repository root', () => {
    assert.equal(kitRoot(), KIT_ROOT);
    assert.ok(fs.existsSync(path.join(kitRoot(), 'package.json')));
  });
});

describe('expandHome and toPosix', () => {
  it('expands a leading ~ to the home directory', () => {
    assert.equal(expandHome('~'), homeDir());
    assert.equal(expandHome('~/notes/a.md'), path.join(homeDir(), 'notes', 'a.md'));
    assert.equal(expandHome('~\\notes\\a.md'), path.join(homeDir(), 'notes\\a.md'));
  });

  it('leaves everything else alone', () => {
    for (const value of ['/abs/path', 'relative/path', 'a~b', '~user/x', 'C:\\Users\\x']) assert.equal(expandHome(value), value);
    assert.equal(expandHome(''), '');
    assert.equal(expandHome(null), null);
    assert.equal(expandHome(undefined), undefined);
  });

  it('toPosix turns backslashes into slashes and stringifies', () => {
    assert.equal(toPosix('C:\\Users\\me\\x.txt'), 'C:/Users/me/x.txt');
    assert.equal(toPosix('/already/posix'), '/already/posix');
    assert.equal(toPosix(5), '5');
  });
});

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash, as Claude Code names project folders', () => {
    assert.equal(encodeProjectDir('C:\\work\\demo-app'), 'C--work-demo-app');
    assert.equal(encodeProjectDir('/home/dev/my.app'), '-home-dev-my-app');
    assert.equal(encodeProjectDir('C:\\Users\\Иван\\app'), 'C--Users------app'); // backslash + four Cyrillic letters + backslash
  });
});

describe('exists, ensureDir, readJsonSafe, writeJsonAtomic', () => {
  it('exists reports files and directories, and false for anything else', () => {
    assert.equal(exists(root), true);
    assert.equal(exists(path.join(root, 'nope')), false);
    assert.equal(exists(undefined), false);
  });

  it('ensureDir creates nested directories, is idempotent and returns the path', () => {
    const dir = path.join(root, 'a', 'b', 'c');
    assert.equal(ensureDir(dir), dir);
    assert.equal(ensureDir(dir), dir);
    assert.ok(fs.statSync(dir).isDirectory());
  });

  it('readJsonSafe parses a file, and returns the fallback for a missing or corrupt one', () => {
    const good = path.join(root, 'good.json');
    writeText(good, '{"a":1}');
    assert.deepEqual(readJsonSafe(good), { a: 1 });
    assert.equal(readJsonSafe(path.join(root, 'missing.json')), null);
    assert.deepEqual(readJsonSafe(path.join(root, 'missing.json'), { fallback: true }), { fallback: true });
    const bad = path.join(root, 'bad.json');
    writeText(bad, '{ nope');
    assert.equal(readJsonSafe(bad), null);
    assert.deepEqual(readJsonSafe(bad, []), []);
  });

  it('writeJsonAtomic writes pretty JSON with a trailing newline, creating parent directories', () => {
    const file = path.join(root, 'deep', 'er', 'data.json');
    writeJsonAtomic(file, { a: 1, b: [1, 2] });
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n');
  });

  it('writeJsonAtomic replaces an existing file and leaves no temporary file behind', () => {
    const file = path.join(root, 'data.json');
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    assert.deepEqual(readJsonSafe(file), { v: 2 });
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('data.json')), ['data.json']);
  });
});

describe('settingsFiles', () => {
  it('lists the user file alone without a project', () => {
    assert.deepEqual(settingsFiles(null, '/cfg'), [{ scope: 'user', file: path.join('/cfg', 'settings.json') }]);
  });

  it('adds project and local files, lowest precedence first', () => {
    assert.deepEqual(settingsFiles('/proj', '/cfg'), [
      { scope: 'user', file: path.join('/cfg', 'settings.json') },
      { scope: 'project', file: path.join('/proj', '.claude', 'settings.json') },
      { scope: 'local', file: path.join('/proj', '.claude', 'settings.local.json') },
    ]);
  });

  it('uses the current config dir by default', () => {
    assert.equal(settingsFiles(null)[0].file, path.join(configDir(), 'settings.json'));
  });
});

describe('platform helpers', () => {
  it('nodeCommand is the running Node binary, quoted when its path has spaces', () => {
    const cmd = nodeCommand();
    if (/\s/.test(process.execPath)) assert.equal(cmd, `"${process.execPath}"`);
    else assert.equal(cmd, process.execPath);
  });

  it('platformSummary describes the runtime', () => {
    const s = platformSummary();
    assert.equal(s.platform, process.platform);
    assert.equal(s.node, process.version);
    assert.equal(s.arch, process.arch);
    assert.equal(s.release, os.release());
    assert.equal(typeof s.wsl, 'boolean');
    assert.ok(s.shell === null || typeof s.shell === 'string');
  });

  it('isWSL is false outside Linux', () => {
    if (process.platform !== 'linux') assert.equal(isWSL(), false);
    else assert.equal(typeof isWSL(), 'boolean');
  });

  it('which finds nothing for a program that does not exist', () => {
    assert.equal(which('kaizen-no-such-program-0a1b2c3d'), null);
  });

  it('which returns an existing path for a program on PATH, or null', () => {
    const found = which('node');
    if (found) assert.ok(fs.existsSync(found), found);
    else assert.equal(found, null);
  });

  it('claudeVersion returns a string or null and never throws (PATH reduced to the Node directory, so no installed claude is run)', () => {
    const undo = setEnv({ PATH: path.dirname(process.execPath) });
    try {
      const v = claudeVersion();
      assert.ok(v === null || (typeof v === 'string' && v.length > 0));
    } finally {
      undo();
    }
  });
});
