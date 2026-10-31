// Kaizen status line (not a hook): one compact line for Claude Code's statusLine command, for example
//   Opus │ ctx 42% ████░░░░░░ │ $1.23 │ ⎇ feat/login │ 5h 32% · 7d 12%
// Sections whose data is missing or switched off are left out; the model name is always printed. The context
// percentage is green below 50, yellow below 80 and red from 80 (plain text when NO_COLOR is set). The branch
// comes from worktree.branch, otherwise from `git -C <current_dir> rev-parse --abbrev-ref HEAD` (1 s timeout).
// Registered as: settings.json "statusLine": { "type": "command", "command": "<node> <this file>" }.
// Parameters (substituted by Kaizen at install time): showCost, showRateLimits, showGit (true|false).
// Remove: delete the "statusLine" key from settings.json, or run `kaizen undo`.
// Self-test: node statusline.mjs --selftest
import { spawnSync } from 'node:child_process';

const COST_RAW = '{{showCost}}';
const LIMITS_RAW = '{{showRateLimits}}';
const GIT_RAW = '{{showGit}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const flag = (raw) => unset(raw) || !/^(?:false|0|no|off)$/i.test(raw.trim());
const CFG = { cost: flag(COST_RAW), limits: flag(LIMITS_RAW), git: flag(GIT_RAW) };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function gitBranch(dir) {
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 1000, windowsHide: true });
  let r = git('rev-parse', '--abbrev-ref', 'HEAD');
  // A repository without commits has no HEAD to resolve; its branch name is still readable.
  if (r.status !== 0 && !/not a git repository/i.test(String(r.stderr))) r = git('symbolic-ref', '--short', '-q', 'HEAD');
  const b = r.status === 0 ? String(r.stdout).trim() : '';
  return b === 'HEAD' ? 'detached' : b;
}

function render(input, cfg = CFG, branchOf = gitBranch, color = !process.env.NO_COLOR) {
  const parts = [(input.model && (input.model.display_name || input.model.id)) || 'Claude'];
  const used = num(input.context_window && input.context_window.used_percentage);
  if (used !== null) {
    const pct = Math.min(100, Math.max(0, Math.round(used)));
    const filled = Math.round(pct / 10);
    const code = pct < 50 ? '32' : pct < 80 ? '33' : '31';
    parts.push(`ctx ${color ? `\u001b[${code}m${pct}%\u001b[0m` : `${pct}%`} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`);
  }
  const cost = num(input.cost && input.cost.total_cost_usd);
  if (cfg.cost && cost !== null) parts.push(`$${cost.toFixed(2)}`);
  if (cfg.git) {
    const dir = (input.workspace && input.workspace.current_dir) || input.cwd;
    const branch = (input.worktree && input.worktree.branch) || (typeof dir === 'string' && dir ? branchOf(dir) : '');
    if (branch) parts.push(`⎇ ${branch}`);
  }
  if (cfg.limits) {
    const limits = input.rate_limits || {};
    const five = num(limits.five_hour && limits.five_hour.used_percentage);
    const seven = num(limits.seven_day && limits.seven_day.used_percentage);
    const shown = [five !== null && `5h ${Math.round(five)}%`, seven !== null && `7d ${Math.round(seven)}%`].filter(Boolean);
    if (shown.length) parts.push(shown.join(' · '));
  }
  return parts.join(' │ ').replace(/[\r\n]+/g, ' ');
}

function selftest() {
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const on = { cost: true, limits: true, git: true };
  const noGit = () => { throw new Error('git must not be called'); };
  const full = {
    model: { display_name: 'Opus' }, context_window: { used_percentage: 42 }, cost: { total_cost_usd: 1.234 }, workspace: { current_dir: '/w/p' },
    worktree: { branch: 'feat/login' }, rate_limits: { five_hour: { used_percentage: 31.6 }, seven_day: { used_percentage: 12 } },
  };
  const line = render(full, on, noGit, true);
  check('full line', plain(line) === 'Opus │ ctx 42% ████░░░░░░ │ $1.23 │ ⎇ feat/login │ 5h 32% · 7d 12%', plain(line));
  check('single line', !/[\r\n]/.test(line), 'contains a newline');
  const colorOf = (pct) => render({ context_window: { used_percentage: pct } }, on, () => '', true).match(/\u001b\[(\d+)m/)?.[1];
  check('colors by threshold', colorOf(49) === '32' && colorOf(50) === '33' && colorOf(79) === '33' && colorOf(80) === '31' && colorOf(100) === '31', [49, 50, 79, 80, 100].map(colorOf).join(','));
  check('NO_COLOR gives plain text', !render(full, on, noGit, false).includes('\u001b'), 'escape codes present');
  check('empty input still prints the model', render({}, on, () => '') === 'Claude', render({}, on, () => ''));
  check('nulls are skipped', plain(render({ model: { display_name: 'Sonnet' }, context_window: { used_percentage: null }, cost: { total_cost_usd: null }, rate_limits: null }, on, () => '')) === 'Sonnet', 'unexpected sections');
  check('sections can be switched off', plain(render(full, { cost: false, limits: false, git: false }, noGit)) === 'Opus │ ctx 42% ████░░░░░░', plain(render(full, { cost: false, limits: false, git: false }, noGit)));
  check('branch from git when no worktree', plain(render({ model: { display_name: 'Opus' }, workspace: { current_dir: '/w/p' } }, on, (d) => (d === '/w/p' ? 'main' : ''))) === 'Opus │ ⎇ main', 'branch missing');
  check('only one rate limit', plain(render({ rate_limits: { seven_day: { used_percentage: 80 } } }, on, () => '')) === 'Claude │ 7d 80%', 'unexpected limits');
  check('percentage is clamped', plain(render({ context_window: { used_percentage: 250 } }, on, () => '')) === 'Claude │ ctx 100% ██████████', 'not clamped');
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) { process.exitCode = selftest(); return; }
  const chunks = [];
  if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
  let input = {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
    if (v && typeof v === 'object') input = v;
  } catch { /* empty or invalid input: treat as {} */ }
  process.stdout.write(render(input) + '\n');
}

process.on('uncaughtException', () => { process.stdout.write('Claude\n'); process.exit(0); });
main().catch(() => { process.stdout.write('Claude\n'); });
