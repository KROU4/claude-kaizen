// Kaizen hook: guard-destructive
// What it does: denies (or asks about) destructive shell commands: rm -rf / ~ $HOME . * or any top-level path,
//   git reset --hard, git clean -f, git checkout -- ., force-push to a protected branch, git branch -D, SQL
//   DROP/TRUNCATE, del /s, rmdir /s, Remove-Item -Recurse on roots, format, mkfs, dd onto a device, chmod -R /.
//   Everything else passes silently (rm -rf node_modules, dist/, ./tmp/foo, push --force-with-lease to a feature branch).
// Registered for: PreToolUse, matcher "Bash" (tool_name "PowerShell" is handled too).
// Parameters (substituted by Kaizen at install time): mode (deny|ask), protectedBranches (comma list).
// Remove: delete the PreToolUse entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node guard-destructive.mjs --selftest
import { spawnSync } from 'node:child_process';

const MODE_RAW = '{{mode}}';
const BRANCHES_RAW = '{{protectedBranches}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const MODE = !unset(MODE_RAW) && MODE_RAW.trim() === 'ask' ? 'ask' : 'deny';
const BRANCH_LIST = (unset(BRANCHES_RAW) ? '' : BRANCHES_RAW).split(',').map((s) => s.trim()).filter(Boolean);
const PROTECTED = BRANCH_LIST.length ? BRANCH_LIST : ['main', 'master', 'production'];

const WELL_KNOWN = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'temp', '.tmp', '.cache', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache', '.angular', '.gradle', '.terraform', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'obj', '.vite', '.docusaurus', '.serverless', '.dart_tool', 'deriveddata', 'storybook-static', 'htmlcov', '.hypothesis', '.eggs', '.pnpm-store']);
const SYSTEM_DIR = /^(?:bin|boot|dev|etc|lib|lib32|lib64|proc|root|sbin|sys|usr|var|windows|program files|program files \(x86\)|programdata|system|library|applications)$/i;
const SQL_RE = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i;
const SQL_CLIENT = /\b(?:psql|mysql|mariadb|sqlite3?|sqlcmd|sqlplus|mongosh?|duckdb|clickhouse-client|cockroach|snowsql|invoke-sqlcmd|prisma|alembic|knex|sequelize)\b/i;
const TEXT_ONLY = new Set(['git', 'gh', 'echo', 'printf', 'grep', 'egrep', 'rg', 'cat', 'less', 'more', 'head', 'tail', 'type', 'sed', 'awk', 'ls', 'find', 'diff', 'wc', 'sort', 'tee', 'touch', 'mkdir', 'cp', 'mv', 'jq', 'man', 'which', 'where']);
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'nice', 'xargs', 'setsid', 'stdbuf']);
const DEVICE = /\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d)/;

// Judge one rm/del target: returns why it is too broad, or null when it looks like a scoped path.
function riskyTarget(raw) {
  let t = String(raw).trim().replace(/\\/g, '/');
  if (!t || t.startsWith('-')) return null;
  const glob = /(^|\/)\*(\.\*)?$/.test(t);
  if (glob) t = t.replace(/\*(\.\*)?$/, '');
  t = t.replace(/^(?:\.\/)+/, '');
  const home = /^(?:~|\$\{?(?:HOME|USERPROFILE)\}?|\$env:USERPROFILE|%(?:USERPROFILE|HOME)%)(?=\/|$)/i.exec(t);
  const drive = home ? null : /^[a-z]:(?=\/|$)/i.exec(t);
  const segs = t.slice(home ? home[0].length : drive ? drive[0].length : 0).split('/').filter((s) => s && s !== '.');
  if (home) return segs.length <= 1 ? 'your home directory' : null;
  // A bare variable ("$tmp") is unknown, not provably broad; "$tmp/" and "$tmp/*" are the classic empty-variable disaster.
  if (/^(?:\$\{?\w*\}?|\$env:\w+|%\w+%)$/i.test(t.replace(/\/$/, ''))) return glob || t.endsWith('/') ? 'a variable directory that may be empty' : null;
  if (drive || t.startsWith('/')) {
    if (segs.length <= 1) return segs.length ? 'a top-level directory' : 'a filesystem root';
    return segs.length === 2 && (/^(?:home|users)$/i.test(segs[0]) || SYSTEM_DIR.test(segs[0])) ? 'a home or system directory' : null;
  }
  if (segs.every((s) => s === '..')) return 'the current or a parent directory';
  if (segs.length + (glob ? 1 : 0) >= 2 || WELL_KNOWN.has(segs[0].toLowerCase()) || /[*?]/.test(segs[0])) return null;
  return `a single top-level path (${segs[0]})`;
}

// Heredoc bodies are data for cat/psql, not commands: drop them before tokenizing.
const stripHeredocs = (t) => t.replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');

// Shell-ish tokenizer: one token array per simple command (quotes removed, operators split).
function tokenize(cmd, ps) {
  const esc = ps ? '`' : '\\';
  const text = stripHeredocs(cmd.replace(/\r\n?/g, '\n'));
  const segs = [];
  let toks = [], cur = '', has = false, q = null;
  const word = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const seg = () => { word(); if (toks.length) segs.push(toks); toks = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === esc && n !== undefined && (ps || n === '"' || n === '\\')) { cur += n; i++; }
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === esc && n === '\n') i++;
    else if (ps && c === '`' && n !== undefined) { cur += n; i++; has = true; }
    else if ('\n;|&()'.includes(c) || (!ps && c === '`')) seg();
    else if (/\s/.test(c)) word();
    else { cur += c; has = true; }
  }
  seg();
  return segs;
}

// Drop VAR=value prefixes and wrappers such as sudo/env/nohup to reach the real command.
function unwrap(toks) {
  let i = 0;
  while (i < toks.length) {
    if (/^[A-Za-z_]\w*=/.test(toks[i])) i++;
    else if (WRAPPERS.has(toks[i].toLowerCase())) { i++; while (i < toks.length && toks[i].startsWith('-')) i += /^-[ugnCpTRDUh]$/.test(toks[i]) ? 2 : 1; }
    else break;
  }
  return toks.slice(i);
}

function checkDelete(name, args) {
  const cmdStyle = /^(?:del|erase|rmdir|rd)$/.test(name);
  const isRec = (a) => /^--recursive$/.test(a) || /^-[fFiIdvxPW]*[rR][fFiIdvxPWrR]*$/.test(a) || /^-rec\w*$/i.test(a) || (cmdStyle && /^\/s$/i.test(a));
  const isFlag = (a) => a.startsWith('-') || (cmdStyle && /^\/[a-z](?::\w+)?$/i.test(a));
  let rec = false, skip = false, dashdash = false;
  const targets = [];
  for (const a of args) {
    if (skip) skip = false;
    else if (!dashdash && a === '--') dashdash = true;
    else if (!dashdash && /^-(?:ea|erroraction|include|exclude|filter|stream|credential)$/i.test(a)) skip = true;
    else if (!dashdash && isFlag(a)) rec = rec || isRec(a);
    else targets.push(a);
  }
  for (const t of rec ? targets : []) {
    const why = riskyTarget(t);
    if (why) return `recursive delete of "${t}" (${why}) is not recoverable`;
  }
  return null;
}

function checkGit(args, ctx) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += /^-[Cc]$|^--(?:git-dir|work-tree|namespace)$/.test(args[i]) ? 2 : 1;
  const sub = args[i], rest = args.slice(i + 1);
  const flags = rest.filter((a) => a.startsWith('-'));
  const has = (re) => flags.some((f) => re.test(f));
  if (sub === 'reset' && has(/^--hard$/)) return 'git reset --hard throws away uncommitted work';
  if (sub === 'clean' && has(/^-[A-Za-z]*f|^--force$/) && !has(/^-[A-Za-z]*n|^--dry-run$/)) return 'git clean -f deletes untracked files for good';
  if (sub === 'checkout' && rest.includes('.')) return 'git checkout . discards all uncommitted changes';
  if (sub === 'branch' && has(/^-[A-Za-z]*D/)) return 'git branch -D deletes a branch even if it is unmerged';
  if (sub !== 'push') return null;
  const specs = rest.filter((a) => !a.startsWith('-')).slice(1);
  const force = has(/^(?:--force(?:-with-lease(?:=.*)?|-if-includes)?|-[A-Za-z]*f[A-Za-z]*)$/) || specs.some((s) => s.startsWith('+'));
  if (!force) return null;
  const targets = specs.map((s) => s.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, ''));
  const names = targets.length ? targets.map((t) => (t === 'HEAD' ? ctx.branch() : t)) : [ctx.branch()];
  if (has(/^--(?:all|mirror)$/) || names.some((n) => !n || PROTECTED.includes(n))) {
    return `force-push to a protected branch (${names.filter(Boolean).join(', ') || 'current branch unknown'}) can rewrite shared history`;
  }
  return null;
}

function checkCommand(name, args, ctx) {
  if (/^(?:rm|del|erase|rmdir|rd|remove-item|ri)$/.test(name)) return checkDelete(name, args);
  if (name === 'git') return checkGit(args, ctx);
  if (/^mkfs(?:\.\w+)?$/.test(name)) return `${name} would erase a filesystem`;
  if (/^(?:format-volume|clear-disk)$/.test(name) || (name === 'format' && args.some((a) => /^[a-z]:[\\/]?$/i.test(a)))) return 'formatting a disk or volume destroys all its data';
  if (name === 'dd' && args.some((a) => /^of=(?:\/dev\/|\\\\\.\\)/i.test(a))) return 'dd writing straight onto a device overwrites it';
  if (name === 'chmod' && args.some((a) => /^-[A-Za-z]*R|^--recursive$/.test(a))) {
    const bad = args.filter((a) => !a.startsWith('-')).slice(1).find((t) => riskyTarget(t));
    if (bad) return `chmod -R on "${bad}" (${riskyTarget(bad)}) can break the whole system`;
  }
  return null;
}

// Commands that run another command line: returns [script, isPowerShell] or null.
function nested(name, args) {
  const after = (re) => { const i = args.findIndex((a) => re.test(a)); return i < 0 ? null : args.slice(i + 1); };
  let r;
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(name)) return (r = after(/^-[a-z]*c$/)) && r[0] ? [r[0], false] : null;
  if (name === 'eval') return [args.join(' '), false];
  if (/^(?:powershell|pwsh)$/.test(name)) return (r = after(/^-c(?:ommand)?$/i)) ? [r.join(' '), true] : null;
  if (name === 'cmd') return (r = after(/^\/[ck]$/i)) ? [r.join(' '), false] : null;
  return null;
}

function analyze(cmd, ps, ctx, depth = 0) {
  const names = [];
  for (const raw of tokenize(cmd, ps)) {
    const toks = unwrap(raw);
    if (!toks.length) continue;
    const name = toks[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '');
    names.push(name);
    const toDevice = raw.some((t, i) => (/^\d*>>?$/.test(t) && DEVICE.test(raw[i + 1] || '')) || (/^\d*>>?\/dev\//.test(t) && DEVICE.test(t)));
    const hit = checkCommand(name, toks.slice(1), ctx) || (toDevice ? 'redirecting output onto a raw disk device destroys its data' : null);
    if (hit) return hit;
    const inner = depth < 2 ? nested(name, toks.slice(1)) : null;
    const sub = inner && analyze(inner[0], inner[1], ctx, depth + 1);
    if (sub) return sub;
  }
  if (SQL_RE.test(cmd) && (SQL_CLIENT.test(cmd) || names.some((n) => !TEXT_ONLY.has(n)))) return 'SQL DROP/TRUNCATE cannot be undone';
  return null;
}

function currentBranch(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwd || undefined, encoding: 'utf8', timeout: 1500, windowsHide: true });
  const b = r.status === 0 ? String(r.stdout).trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

function evaluate(payload, ctx = {}) {
  const tool = payload.tool_name;
  const cmd = payload.tool_input && payload.tool_input.command;
  if ((tool !== 'Bash' && tool !== 'PowerShell') || typeof cmd !== 'string' || !cmd.trim()) return null;
  const why = analyze(cmd, tool === 'PowerShell', { branch: ctx.branch || (() => currentBranch(payload.cwd)) });
  if (!why) return null;
  const hint = MODE === 'deny' ? ' Ask the user to confirm, or have them run it themselves.' : '';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: MODE, permissionDecisionReason: `Kaizen guard: ${why}.${hint}` } };
}

function selftest() {
  const bad = [
    'rm -rf /', 'rm -rf ~', 'sudo rm -fr $HOME/', 'rm -rf *', 'rm -rf .', 'rm -rf C:\\', 'rm -rf /usr/lib', 'rm -rf foo', 'git reset --hard HEAD~1', 'git clean -fdx',
    'git checkout -- .', `git push --force origin ${PROTECTED[0]}`, 'git push -f', `git push origin +${PROTECTED[0]}`, 'git branch -D old', 'psql -c "DROP TABLE users"',
    'echo "TRUNCATE TABLE a;" | mysql', 'del /s /q C:\\', 'rmdir /s /q D:\\', 'format D:', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'chmod -R 777 /',
    'cat x > /dev/sda', 'bash -c "rm -rf /"', 'ls && rm -rf ~/', 'rm -rf "$tmp"/', 'rm -rf $VAR/*',
  ];
  const good = [
    'ls -la', 'rm -rf node_modules', 'rm -rf dist/', 'rm -rf ./tmp/foo', 'rm file.txt', 'rm -rf build/*', 'git push --force-with-lease origin feature/x', 'git push origin main',
    'git status && git log --oneline', 'git commit -m "docs: never run rm -rf / or DROP TABLE"', 'git checkout -b feature', 'git reset --soft HEAD~1', 'echo "DROP TABLE x" > notes.txt',
    'cat <<EOF > a.md\nrm -rf /\nEOF', 'chmod -R 755 ./public/assets', 'dd if=a.iso of=b.img', 'rm -rf "$tmp"', 'rm -rf $(mktemp -d)',
  ];
  let failed = 0;
  const run = (tool, command, branch = () => null) => evaluate({ tool_name: tool, tool_input: { command } }, { branch });
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  for (const c of bad) check(c, run('Bash', c)?.hookSpecificOutput.permissionDecision === MODE, 'expected a block');
  for (const c of good) check(c.replace(/\n/g, '\\n'), run('Bash', c) === null, 'expected silence');
  check('ps Remove-Item C:\\', !!run('PowerShell', 'Remove-Item -Recurse -Force C:\\'), 'expected a block');
  check('ps Remove-Item .\\build', run('PowerShell', 'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue .\\build') === null, 'expected silence');
  check('push --force-with-lease on a feature branch', run('Bash', 'git push --force-with-lease', () => 'feature/x') === null, 'expected silence');
  check('non-shell tool ignored', run('Read', 'rm -rf /') === null, 'expected silence');
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) { try { process.exitCode = selftest(); } catch (e) { console.log('FAIL selftest crashed: ' + e.message); process.exitCode = 1; } return; }
  let payload = {};
  try {
    const chunks = [];
    if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    if (v && typeof v === 'object') payload = v;
  } catch { /* empty or invalid input: treat as {} */ }
  const out = evaluate(payload);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
