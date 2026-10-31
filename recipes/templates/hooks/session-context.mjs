// Kaizen hook: session-context
// What it does: at session start injects a short briefing as additionalContext: project folder, git branch,
//   recent commits, how many files are modified/untracked (counts plus up to 5 names), and the handoff left by
//   precompact-handoff (~/.claude/kaizen/handoffs/<session_id>.md, shown once and then deleted) or a hand-written
//   <project>/.claude/kaizen-handoff.md (kept). Prints nothing when there is nothing useful to say.
// Registered for: SessionStart, matcher "startup|resume|clear|compact".
// Parameters (substituted by Kaizen at install time): maxChars (default 1500), includeGit (true|false).
// Remove: delete the SessionStart entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node session-context.mjs --selftest
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RAW = '{{maxChars}}';
const GIT_RAW = '{{includeGit}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const MAX_CHARS = Math.min(9000, Math.max(200, Number(unset(MAX_RAW) ? 1500 : MAX_RAW) || 1500));
const INCLUDE_GIT = unset(GIT_RAW) || !/^(?:false|0|no|off)$/i.test(GIT_RAW.trim());
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function git(args, cwd) {
  // core.quotePath=false keeps non-ASCII (e.g. Cyrillic) file names readable instead of octal escapes.
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 1 << 20 });
  return r.status === 0 ? String(r.stdout) : null;
}

// Per-session handoff (consumed: deleted after reading) plus the optional project-level file (kept).
function takeHandoff(payload, cwd, dir) {
  const sid = String(payload.session_id || '').replace(/[^\w-]/g, '');
  const files = [{ f: path.join(cwd, '.claude', 'kaizen-handoff.md'), consume: false }];
  if (sid) files.unshift({ f: path.join(dir, 'kaizen', 'handoffs', `${sid}.md`), consume: true });
  const out = [];
  for (const { f, consume } of files) {
    try {
      const text = fs.readFileSync(f, 'utf8').trim();
      if (text) out.push(text);
      if (consume) fs.unlinkSync(f);
    } catch { /* file absent or unreadable */ }
  }
  return out.join('\n\n');
}

function build(payload, o = {}) {
  const run = o.git || git;
  const max = o.max || MAX_CHARS;
  const cwd = payload.cwd || process.cwd();
  const parts = [];
  if (o.includeGit ?? INCLUDE_GIT) {
    const status = run(['status', '--porcelain', '-b'], cwd);
    if (status !== null) {
      const lines = status.split('\n').filter(Boolean);
      const files = lines.slice(1).map((l) => l.slice(3));
      const log = (run(['log', '--oneline', '-5'], cwd) || '').trim();
      parts.push(`Git: ${(lines[0] || '').replace(/^## /, '')}`);
      parts.push(files.length ? `Working tree: ${files.length} modified/untracked file(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}` : 'Working tree: clean');
      if (log) parts.push(`Recent commits:\n${log}`);
    }
  }
  const handoff = takeHandoff(payload, cwd, o.configDir || configDir());
  if (handoff) parts.push(`Handoff saved before the last context reset:\n${handoff}`);
  if (!parts.length) return null;
  const text = `Session context for ${path.basename(cwd)} (Kaizen):\n${parts.join('\n')}`;
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-ctx-'));
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const cwd = path.join(tmp, 'demo');
  const handoffFile = path.join(tmp, 'kaizen', 'handoffs', 'abc-123.md');
  const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const stub = (args) => (args[0] === 'status' ? '## main...origin/main [ahead 1]\n M a.js\n?? b.js\n?? c.js\n?? d.js\n?? e.js\n?? f.js\n' : 'abc1234 first\ndef5678 second\n');
  const base = { configDir: tmp, includeGit: false, max: 5000 }; // independent of the installed parameters
  try {
    write(handoffFile, '## Recent prompts\n1. fix the login bug\n');
    const first = build({ session_id: 'abc-123', cwd }, base);
    check('handoff is injected', !!first && first.includes('fix the login bug') && first.includes('demo'), JSON.stringify(first));
    check('handoff is consumed once', !fs.existsSync(handoffFile) && build({ session_id: 'abc-123', cwd }, base) === null, 'file still there or reinjected');
    write(path.join(cwd, '.claude', 'kaizen-handoff.md'), 'Remember: use pnpm');
    const proj = build({ session_id: 'zzz', cwd }, base);
    check('project handoff is kept', !!proj && proj.includes('use pnpm') && fs.existsSync(path.join(cwd, '.claude', 'kaizen-handoff.md')), JSON.stringify(proj));
    const sneaky = build({ session_id: '../../etc/passwd', cwd: path.join(tmp, 'other') }, base);
    check('session id is sanitised', sneaky === null, JSON.stringify(sneaky));
    const g = build({ cwd }, { ...base, includeGit: true, git: stub });
    check('git summary', !!g && g.includes('main...origin/main [ahead 1]') && g.includes('6 modified/untracked file(s): a.js, b.js, c.js, d.js, e.js, ...') && g.includes('abc1234 first'), JSON.stringify(g));
    check('truncated to maxChars', build({ cwd }, { ...base, includeGit: true, git: stub, max: 120 }).length === 120, 'wrong length');
    check('not a repo and no handoff -> silent', build({ cwd: path.join(tmp, 'x') }, { ...base, includeGit: true, git: () => null }) === null, 'expected null');
    check('clean tree', build({ cwd }, { ...base, includeGit: true, git: (a) => (a[0] === 'status' ? '## main\n' : '') }).includes('Working tree: clean'), 'expected clean');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) { try { process.exitCode = selftest(); } catch (e) { console.log('FAIL selftest crashed: ' + e.message); process.exitCode = 1; } return; }
  const chunks = [];
  if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
  let payload = {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
    if (v && typeof v === 'object') payload = v;
  } catch { /* empty or invalid input: treat as {} */ }
  const text = build(payload);
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) + '\n');
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
