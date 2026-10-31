// Shared helpers for the Kaizen test suite. Not a test file (no ".test." in the name),
// so the runner never executes it directly.
//
// Rules the suite follows:
//  - fixtures under tests/fixtures are synthetic and read-only; anything a test mutates is copied to a temp dir first
//  - the real ~/.claude is never read; every child process gets an explicit, hermetic environment
//  - temp dirs are removed in `after` hooks via cleanupTempDirs()
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(TESTS_DIR, '..');
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');
export const CLI = path.join(KIT_ROOT, 'scripts', 'kaizen.mjs');

export const SESSION_IDS = {
  a: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b: '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  c: '33333333-cccc-4ccc-8ccc-cccccccccccc',
};

export const PROJECTS_FIXTURE = path.join(FIXTURES, 'projects');
export const USAGE_DATA_FIXTURE = path.join(FIXTURES, 'usage-data');
export const TRANSCRIPTS = {
  a: path.join(PROJECTS_FIXTURE, 'C--work-demo-app', 'session-a.jsonl'),
  b: path.join(PROJECTS_FIXTURE, 'C--work-demo-app', 'session-b.jsonl'),
  c: path.join(PROJECTS_FIXTURE, 'C--work-other', 'session-c.jsonl'),
};

export const toPosix = (p) => String(p).replace(/\\/g, '/');

// ------------------------------------------------------------------ temp dirs

const created = [];

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function makeTempDir(prefix = 'kaizen-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  while (created.length) removeDir(created.pop());
}

/** Recursive copy; `textReplace` ({needle: replacement}) is applied to *.json files only. */
export function copyTree(src, dst, { textReplace = null } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      copyTree(from, to, { textReplace });
    } else if (textReplace && /\.json$/i.test(e.name)) {
      let text = fs.readFileSync(from, 'utf8');
      for (const [needle, replacement] of Object.entries(textReplace)) text = text.split(needle).join(replacement);
      fs.writeFileSync(to, text, 'utf8');
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Build a throw-away "user home" from the fixtures:
 *   <root>/home/.claude.json          global config with the two MCP servers
 *   <root>/home/.claude/              CLAUDE_CONFIG_DIR (settings, CLAUDE.md, skills, agents, plugins, [projects], [usage-data])
 *   <root>/state                      KAIZEN_STATE_DIR
 * `env` holds the four variables a process needs to see this home instead of the real one.
 */
export function materializeHome({ projects = false, usageData = false } = {}) {
  const root = makeTempDir('kaizen-home-');
  const home = path.join(root, 'home');
  const configDir = path.join(home, '.claude');
  const stateDir = path.join(root, 'state');
  copyTree(path.join(FIXTURES, 'claude-home'), configDir, { textReplace: { '{{FIXTURES}}': toPosix(FIXTURES) } });
  fs.copyFileSync(path.join(FIXTURES, 'claude.json'), path.join(home, '.claude.json'));
  if (projects) copyTree(PROJECTS_FIXTURE, path.join(configDir, 'projects'));
  if (usageData) copyTree(USAGE_DATA_FIXTURE, path.join(configDir, 'usage-data'));
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    home,
    configDir,
    stateDir,
    claudeJson: path.join(home, '.claude.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir, KAIZEN_STATE_DIR: stateDir },
  };
}

// ------------------------------------------------------------------ environment

/** Set (or delete, with undefined/null) process.env entries; returns a function that restores them. */
export function setEnv(vars) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Environment for a child process: nothing Claude/Kaizen-related leaks in, PATH holds only the Node binary's directory. */
export function childEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|KAIZEN|ANTHROPIC)/i.test(key) || /^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.PATH = path.dirname(process.execPath);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** Run `node scripts/kaizen.mjs ...args` synchronously. */
export function runCli(args, { env = {}, cwd, input, timeout = 60000 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: childEnv(env),
    cwd: cwd || os.tmpdir(),
    input,
    timeout,
    windowsHide: true,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

/** Capture what `fn` writes to stdout/stderr (strings only; anything else passes through untouched). */
export async function captureOutput(fn) {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  const make = (orig, sink) =>
    function patched(chunk, ...rest) {
      if (typeof chunk === 'string') {
        sink(chunk);
        const cb = rest.find((x) => typeof x === 'function');
        if (cb) cb();
        return true;
      }
      return orig.call(this, chunk, ...rest);
    };
  process.stdout.write = make(origOut, (s) => (stdout += s));
  process.stderr.write = make(origErr, (s) => (stderr += s));
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ------------------------------------------------------------------ files

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** Sorted "relative/path:sha1" entries (directories end with "/") - compare two snapshots to prove nothing was written. */
export function snapshotDir(dir) {
  const out = [];
  const walk = (current, rel) => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(current, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        walk(full, r);
      } else {
        out.push(`${r}:${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Parse a JSONL fixture the way a reader would: skip lines that are not JSON objects. */
export function parseJsonlFile(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* invalid line: skipped on purpose */
    }
  }
  return out;
}

/** Drop later lines that repeat an earlier uuid (what a resumed session replays). */
export function dedupeByUuid(lines) {
  const seen = new Set();
  return lines.filter((o) => {
    if (!o.uuid) return true;
    if (seen.has(o.uuid)) return false;
    seen.add(o.uuid);
    return true;
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The measurement of the synthetic fixtures: real scanTranscripts + real inventory() of a throw-away home
 * + readInsights of tests/fixtures/usage-data. Environment variables are restored before returning.
 */
export async function buildFixtureMeasure({ windowDays = 30 } = {}) {
  const home = materializeHome();
  const restore = setEnv({ ...home.env, CLAUDE_PROJECT_DIR: undefined });
  try {
    const { scanTranscripts } = await import('../scripts/lib/transcripts.mjs');
    const { inventory } = await import('../scripts/lib/inventory.mjs');
    const { readInsights } = await import('../scripts/lib/insights.mjs');
    const { buildMeasure } = await import('../scripts/lib/metrics.mjs');
    const scan = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE });
    const inv = inventory({ projectDir: null });
    const insights = readInsights(USAGE_DATA_FIXTURE);
    const measure = buildMeasure({
      sessions: scan.sessions,
      inventory: inv,
      insights,
      env: { windowDays, since: '2026-10-01T00:00:00.000Z', configDir: home.configDir, projectDir: null, platform: { platform: 'test', node: process.version }, claudeVersion: null, kitVersion: '0.0.0-test' },
      scan,
    });
    return { measure, sessions: scan.sessions, scan, inventory: inv, insights, home };
  } finally {
    restore();
  }
}
