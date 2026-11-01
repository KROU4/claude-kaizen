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
const MODE = !unset(MODE_RAW) && MODE_RAW.trim().toLowerCase() === 'ask' ? 'ask' : 'deny';
const BRANCH_LIST = (unset(BRANCHES_RAW) ? '' : BRANCHES_RAW).split(',').map((s) => s.trim()).filter(Boolean);
const PROTECTED = BRANCH_LIST.length ? BRANCH_LIST : ['main', 'master', 'production'];
// "release/*" style patterns: * matches any run of characters
const PROTECTED_RE = PROTECTED.map((p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
const isProtected = (name) => PROTECTED_RE.some((re) => re.test(name));

const WELL_KNOWN = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'temp', '.tmp', '.cache', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache', '.angular', '.gradle', '.terraform', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'obj', '.vite', '.docusaurus', '.serverless', '.dart_tool', 'deriveddata', 'storybook-static', 'htmlcov', '.hypothesis', '.eggs', '.pnpm-store']);
const SYSTEM_DIR = /^(?:bin|boot|dev|etc|lib|lib32|lib64|proc|root|sbin|sys|usr|var|windows|program files|program files \(x86\)|programdata|system|library|applications)$/i;
const SQL_RE = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i;
// SQL clients are recognised by command name only (never by a path or message text); framework DB shells by their subcommand.
const SQL_CLIENT = /^(?:psql|pgcli|mysql|mycli|mariadb|sqlite3?|litecli|sqlcmd|sqlplus|usql|mongosh?|duckdb|clickhouse-client|cockroach|snowsql|invoke-sqlcmd|prisma|alembic|knex|sequelize|dbshell|dbconsole)$/;
const DB_SHELL_ARG = /^(?:dbshell|dbconsole|db:console)$/;
const TEXT_ONLY = new Set(['git', 'gh', 'echo', 'printf', 'grep', 'egrep', 'rg', 'cat', 'less', 'more', 'head', 'tail', 'type', 'sed', 'awk', 'ls', 'find', 'diff', 'wc', 'sort', 'tee', 'touch', 'mkdir', 'cp', 'mv', 'jq', 'man', 'which', 'where',
  'cd', 'pushd', 'popd', 'set-location', 'select-string', 'sls', 'findstr', 'set-content', 'add-content', 'out-file', 'get-content', 'gc', 'write-host', 'write-output']);
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'env', 'nice', 'xargs', 'setsid', 'stdbuf']);
const WIN = process.platform === 'win32';
// Commands that run a program inside a container or on another host: a SQL client named in their arguments counts.
const REMOTE = /^(?:docker|podman|nerdctl|docker-compose|kubectl|oc|ssh)$/;
const DEVICE = /\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d)/;

// Judge one rm/del target: returns why it is too broad, or null when it looks like a scoped path.
function riskyTarget(raw) {
  let t = String(raw).trim().replace(/\\/g, '/');
  if (!t || t.startsWith('-')) return null;
  const glob = /(^|\/)\*(\.\*)?$/.test(t);
  if (glob) t = t.replace(/\*(\.\*)?$/, '');
  t = t.replace(/^(?:\.\/)+/, '');
  // WSL / Cygwin mount drives as /mnt/c, /cygdrive/c, Git Bash (Windows only) as /c: judge them exactly like C:/.
  t = t.replace(WIN ? /^\/(?:(?:mnt|cygdrive)\/)?([a-z])(?=\/|$)/i : /^\/(?:mnt|cygdrive)\/([a-z])(?=\/|$)/i, (m, d) => d.toUpperCase() + ':');
  const home = /^(?:~|\$\{?(?:HOME|USERPROFILE)\}?|\$env:USERPROFILE|%(?:USERPROFILE|HOME)%)(?=\/|$)/i.exec(t);
  const drive = home ? null : /^[a-z]:(?=\/|$)/i.exec(t);
  // A leading variable / substitution ($ROOT, ${DIR}, $(pwd), %DIR%, $env:X) is an unknown base, never a cwd-relative name.
  const vbase = home || drive ? null : /^(?:\$\{[^}]*\}|\$\([^)]*\)|\$env:\w+|\$\w+|%\w+%)(?=\/|$)/i.exec(t);
  // Collapse "..": popping past the start leaves `up` > 0 (above home, or above the relative start; at / or C:\ it stays put).
  const segs = [];
  let up = 0;
  for (const s of t.slice((home || drive || vbase || [''])[0].length).split('/')) {
    if (!s || s === '.') continue;
    if (s !== '..') segs.push(s);
    else if (segs.length) segs.pop();
    else up++;
  }
  if (home) return segs.length <= 1 || up ? 'your home directory' : null;
  if (vbase) {
    if (up) return segs.length ? null : 'the parent of a variable directory';
    // "$tmp/" and "$tmp/*" are the classic empty-variable disaster; "$tmp/x" is scoped.
    return !segs.length && (glob || t.endsWith('/')) ? 'a variable directory that may be empty' : null;
  }
  // A bare variable ("$tmp") is unknown, not provably broad; "$tmp/" and "$tmp/*" are the classic empty-variable disaster.
  if (/^(?:\$\{?\w*\}?|\$env:\w+|%\w+%)$/i.test(t.replace(/\/$/, ''))) return glob || t.endsWith('/') ? 'a variable directory that may be empty' : null;
  if (drive || t.startsWith('/')) {
    if (segs.length <= 1) return segs.length ? 'a top-level directory' : 'a filesystem root';
    return segs.length === 2 && (/^(?:home|users)$/i.test(segs[0]) || SYSTEM_DIR.test(segs[0])) ? 'a home or system directory' : null;
  }
  if (!segs.length) return 'the current or a parent directory';
  if (up) return null;
  if (segs.length + (glob ? 1 : 0) >= 2 || WELL_KNOWN.has(segs[0].toLowerCase()) || /[*?]/.test(segs[0])) return null;
  return `a single top-level path (${segs[0]})`;
}

// Heredoc bodies are data for cat/psql, not commands: drop them before tokenizing. Each heredoc operator becomes a
// marker word (\u0001N\u0001) in the command it belongs to and its body goes to `bodies[N]`, so analyze() inspects
// only the bodies that reach a shell (bash <<EOF ... EOF, cat <<EOF | bash).
const MARK = /\u0001(\d+)\u0001/g;
// PowerShell here-strings (@'...'@ and @"..."@, closer at the start of a line) are data the same way: the body goes to `bodies`
// and the here-string itself becomes a marker word in the command line.
const stripHereStrings = (t, bodies, ps) => (ps ? t.replace(/@(['"])[ \t]*\n([\s\S]*?)\n\1@/g, (m, q, body) => ` \u0001${bodies.push(body) - 1}\u0001 `) : t);
const stripHeredocs = (t, bodies, ps) => stripHereStrings(t, bodies, ps).replace(/(?<!<)(?:(?<=^|[\s;|&(])\d+)?<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, (m, q, d, rest, body) => ` \u0001${bodies.push(body) - 1}\u0001 ${rest}`);

// Shell-ish tokenizer: one token array per simple command (quotes removed, operators split); `.pipe` marks "piped into the next".
function tokenize(cmd, ps, bodies) {
  const esc = ps ? '`' : '\\';
  const text = stripHeredocs(cmd.replace(/\r\n?/g, '\n'), bodies, ps);
  const segs = [];
  let toks = [], cur = '', has = false, q = null, bt = false;
  const subs = []; // open parens, true for a substitution ($( <( >( @() whose output feeds the command around it: `.sub`
  const word = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const seg = (pipe) => { word(); if (toks.length) { toks.pipe = !!pipe; toks.sub = bt || subs.includes(true); segs.push(toks); } toks = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === esc && n !== undefined && (ps || n === '"' || n === '\\')) { cur += n; i++; }
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === esc && n === '\n') i++;
    else if (ps && c === '`' && n !== undefined) { cur += n; i++; has = true; }
    else if ('\n;|&()'.includes(c) || (!ps && c === '`')) {
      const opens = c === '(' && /[$<>@]$/.test(cur);
      seg(c === '|' && n !== '|');
      if (c === '(') subs.push(opens); else if (c === ')') subs.pop(); else if (c === '`') bt = !bt;
    }
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

function checkDelete(name, args, ps) {
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
  // PowerShell `Remove-Item a, b` / `a,b` is an array of paths and cmd.exe splits `rd a,b` on commas; Bash expands `{a,b}`.
  const brace = (x) => { const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(x); return m ? m[2].split(',').flatMap((s) => brace(m[1] + s + m[3])) : [x]; };
  const list = ps || cmdStyle ? targets.flatMap((x) => x.split(',')).filter(Boolean) : targets.flatMap(brace);
  for (const t of rec ? list : []) {
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
  if (has(/^--(?:all|mirror)$/) || names.some((n) => !n || isProtected(n))) {
    return `force-push to a protected branch (${names.filter(Boolean).join(', ') || 'current branch unknown'}) can rewrite shared history`;
  }
  return null;
}

function checkCommand(name, args, ctx, ps) {
  if (/^(?:rm|del|erase|rmdir|rd|remove-item|ri)$/.test(name)) return checkDelete(name, args, ps);
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
  if (name === 'cmd') return (r = after(/^\/{1,2}[ck]$/i)) ? [r.join(' '), false] : null;
  return null;
}

// A shell that reads its script from stdin (bash <<EOF, bash <<< "...", ... | bash): returns { ps, strs } or null.
function stdinScript(name, args) {
  const ps = /^(?:powershell|pwsh)$/.test(name);
  if (name !== 'eval' && !ps && !/^(?:bash|sh|zsh|dash|ksh)$/.test(name)) return null;
  const strs = [];
  let s = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[a-z]*c(?:ommand)?$/i.test(a) && name !== 'eval') return null;
    if (a === '-s') s = true;
    else if (name !== 'eval' && !ps && (/^[-+][A-Za-z]*[oO]$/.test(a) || /^--(?:rcfile|init-file)$/.test(a))) i++; // option that takes an argument (-o pipefail, -euo pipefail, -O extglob)
    else if (/^\u0001\d+\u0001$/.test(a)) continue; // heredoc marker: stdin, not a script file
    else if (a === '<<<') strs.push(args[++i] || '');
    else if (a.startsWith('<<<')) strs.push(a.slice(3));
    else if (/^\d*<<-?$/.test(a)) i++;
    else if (!a.startsWith('-') && !/^\d*<<-?./.test(a) && !s && name !== 'eval') return null; // a script file, not stdin
  }
  return { ps, strs };
}

function analyze(cmd, ps, ctx, depth = 0, bodies = []) {
  const names = [], info = [];
  for (const raw of tokenize(cmd, ps, bodies)) {
    const toks = unwrap(raw);
    if (!toks.length) { info.push({ raw, name: '', f: null, args: [], assign: true }); continue; } // VAR=value only: can carry SQL text
    const name = toks[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '');
    names.push(name);
    const f = stdinScript(name, toks.slice(1));
    info.push({ raw, name, f, args: toks.slice(1) });
    const toDevice = raw.some((t, i) => (/^\d*>>?$/.test(t) && DEVICE.test(raw[i + 1] || '')) || (/^\d*>>?\/dev\//.test(t) && DEVICE.test(t)));
    const hit = checkCommand(name, toks.slice(1), ctx, ps) || (toDevice ? 'redirecting output onto a raw disk device destroys its data' : null);
    if (hit) return hit;
    const inner = depth < 2 ? nested(name, toks.slice(1)) : null;
    const sub = inner && analyze(inner[0], inner[1], ctx, depth + 1, bodies);
    if (sub) return sub;
  }
  if (depth < 2) {
    // A heredoc body is shell code only when its own command is a stdin shell (or eval), or is piped into one.
    const reader = (k) => {
      for (let j = k; j < info.length; j++) {
        if (info[j].f && (j === k || info[j].name !== 'eval')) return info[j].f;
        if (!info[j].raw.pipe) break;
      }
      return null;
    };
    for (let k = 0; k < info.length; k++) {
      const f = reader(k);
      if (!f) continue;
      const owned = [...info[k].raw.join(' ').matchAll(MARK)].map((m) => bodies[+m[1]]);
      if (info[k].f) owned.push(...info[k].f.strs);
      for (const b of owned) {
        const sub = analyze(b, f.ps, ctx, depth + 1, bodies);
        if (sub) return sub;
      }
    }
  }
  // SQL on the command line itself: blocked unless every command is text-only. A heredoc body counts the same way, judged by
  // the command that owns it and whatever it is piped into (python - <<EOF, rails dbconsole <<EOF, cat <<EOF | mysql), so
  // `cat <<EOF > migration.sql` with a DROP in it stays allowed while an interpreter or DB shell reading it is blocked.
  // The SQL text is judged by the command it belongs to (and whatever that command is piped into), not by every command on the
  // line: `cd x && git commit -m "drop table"` or `rg "drop table" && npm test` are fine, `psql ...` anywhere is not.
  const SQL_MSG = 'SQL DROP/TRUNCATE cannot be undone';
  const client = (i) => SQL_CLIENT.test(i.name) || i.args.some((a) => DB_SHELL_ARG.test(a) || (REMOTE.test(i.name) && SQL_CLIENT.test(a.split(/[\\/]/).pop().toLowerCase())));
  const risky = (i) => !i.assign && (client(i) || !(TEXT_ONLY.has(i.name) || /^\u0001\d+\u0001$/.test(i.name)));
  const sinks = (k) => { // is the command at k, or anything it pipes into, able to run SQL?
    if (info[k].assign) return info.slice(k + 1).some(risky); // `q="DROP TABLE x"; python run.py "$q"`
    if (info[k].raw.sub) return info.some(risky); // `python run.py $(echo "DROP TABLE x")`: output feeds the command around it
    for (let j = k; j < info.length; j++) {
      if (risky(info[j])) return true;
      if (!info[j].raw.pipe) break;
    }
    return false;
  };
  if (SQL_RE.test(stripHeredocs(cmd.replace(/\r\n?/g, '\n'), [], ps))) {
    if (info.some(client)) return SQL_MSG;
    for (let k = 0; k < info.length; k++) if (SQL_RE.test(info[k].raw.join(' ')) && sinks(k)) return SQL_MSG;
  }
  for (let k = 0; k < info.length; k++) {
    const owned = [...info[k].raw.join(' ').matchAll(MARK)].map((m) => bodies[+m[1]] || '');
    if (owned.some((b) => SQL_RE.test(b)) && sinks(k)) return SQL_MSG;
  }
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
    'rm -rf ~/../..', 'rm -rf /opt/..', 'rm -rf ~/proj/..', 'rm -rf /home/u/..', 'rm -rf "$PROJECT/.."', 'rm -rf ./build/../..',
    "bash <<'EOF'\nrm -rf /\nEOF", 'sh <<EOF\nrm -rf ~\nEOF', 'sudo bash <<-EOF\n\tgit reset --hard\n\tEOF', 'cat <<EOF | bash\ngit clean -fdx\nEOF',
    'bash <<< "rm -rf /"', 'eval "$(cat <<EOF\nrm -rf /\nEOF\n)"', 'cd x && bash -e <<EOF\nset -e\ngit branch -D old\nEOF',
    'rm -rf "$ROOT/.."', 'rm -rf "${BUILD_DIR}/../.."', 'rm -rf "$(pwd)/.."', 'rm -rf "%ROOT%/.."', 'rm -rf "$ROOT/../"*',
    "bash -euo pipefail <<'EOF'\nrm -rf /\nEOF", 'bash -o pipefail <<EOF\nrm -rf /\nEOF', 'bash -O extglob <<EOF\nrm -rf /\nEOF', 'bash<<EOF\nrm -rf /\nEOF',
    'cat <<EOF > a.md\nhi\nEOF\nbash <<X\nrm -rf /\nX', 'cat <<EOF | tr a b | bash\nrm -rf /\nEOF',
    "psql mydb <<'SQL'\nDROP TABLE users;\nSQL", 'cat <<EOF | mysql app\nTRUNCATE TABLE logs;\nEOF', 'ssh db psql <<EOF\nDROP DATABASE x;\nEOF',
    'python3 - <<EOF\nimport sqlite3\nsqlite3.connect("a.db").execute("DROP TABLE t")\nEOF', 'node --input-type=module <<EOF\nawait db.query("DROP TABLE users")\nEOF',
    'python manage.py dbshell <<EOF\nDROP TABLE x;\nEOF', 'rails dbconsole <<EOF\nDROP TABLE x;\nEOF', 'cat <<EOF | python3 -\nTRUNCATE TABLE a\nEOF',
    'cat <<EOF | tr a b | mysql\nDROP TABLE x;\nEOF', 'sudo -u postgres psql -c "DROP TABLE x"', 'docker exec db psql -c "TRUNCATE TABLE logs"',
    ...(WIN ? ['rm -rf /c/Users/me', 'rm -rf /c/Windows', 'rm -rf /c/'] : []), 'rm -rf /mnt/c/Users/me', 'rm -rf {dist,/}', 'cmd //c "rd /s /q .\\out\\a,C:\\"',
    'python run.py $(echo "DROP TABLE users")', 'python run.py `echo "DROP TABLE users"`', 'python run.py <(echo "DROP TABLE users")', 'python run.py $(printf "DROP TABLE %s" users)',
    'echo "DROP TABLE x" > q.sql && docker exec -i db psql < q.sql', 'ssh host mysql -e "TRUNCATE TABLE logs"', 'cmd //c "rd /s /q C:\\"', "cmd //c 'rd /s /q C:\\'", 'cmd //c rd /s /q C:\\', 'cmd //c "rd /s /q C:/"',
    'cd db && psql -c "DROP TABLE x"', 'git log -S"drop table" && psql -c "select 1"', 'q="DROP TABLE x"; python run.py "$q"', 'cd x && python migrate.py "drop table y"',
  ];
  const good = [
    'ls -la', 'rm -rf node_modules', 'rm -rf dist/', 'rm -rf ./tmp/foo', 'rm file.txt', 'rm -rf build/*', 'git push --force-with-lease origin feature/x', 'git push origin main',
    'git status && git log --oneline', 'git commit -m "docs: never run rm -rf / or DROP TABLE"', 'git checkout -b feature', 'git reset --soft HEAD~1', 'echo "DROP TABLE x" > notes.txt',
    'cat <<EOF > a.md\nrm -rf /\nEOF', 'chmod -R 755 ./public/assets', 'dd if=a.iso of=b.img', 'rm -rf "$tmp"', 'rm -rf $(mktemp -d)',
    'rm -rf ./build/../dist', 'rm -rf ../out', "bash <<'EOF'\necho hi\nls\nEOF", 'cat <<EOF | tee a.sh\nrm -rf /\nEOF', 'bash run.sh <<EOF\nrm -rf /\nEOF',
    'git commit -m "$(cat <<\'EOF\'\nfix: never rm -rf /\nEOF\n)"',
    'rm -rf "$ROOT/../site"', 'rm -rf "${BUILD_DIR}/../tmp-artifacts"', 'rm -rf "$(pwd)/../x"', 'rm -rf "$repo/../$name"', 'rm -rf "%ROOT%/../x"', 'rm -rf "$SCRIPT_DIR/../release-tmp"',
    'cat <<EOF > a.md\nrm -rf /\nEOF\nbash <<X\necho hi\nX', 'cat <<EOF > deploy.md\nrm -rf ~/old\nEOF\ngit add deploy.md && eval "$(ssh-agent -s)"',
    'cat <<EOF > notes.md\nrm -rf ~\nEOF\nsource venv/bin/activate && bash -l', "bash -euo pipefail <<'EOF'\necho hi\nEOF",
    'cat <<EOF > migrations/001.sql\nDROP TABLE old_users;\nEOF\nnode scripts/check.js', "cat > down.sql <<'SQL'\nTRUNCATE TABLE cache;\nSQL",
    'cat <<EOF > prisma/migrations/20261101_x/migration.sql\nDROP TABLE old_users;\nEOF', 'cat <<EOF > db/mysql/down.sql\nDROP TABLE cache;\nEOF',
    'git commit -m "docs: explain drop table in prisma migrations"', 'git show HEAD:prisma/migrations/1/migration.sql | grep -i "drop table"',
    'cat <<EOF | tee db/psql/down.sql\nDROP TABLE x;\nEOF',
    'cd C:/Users/KROU4/proj && git commit -m "migrations: drop table legacy_users"', 'cd migrations && grep -n "DROP TABLE" *.sql', 'rg -n "drop table" migrations && npm test',
    'msg="drop table x"; git commit -m "$msg"', 'rm -rf /c/Users/me/proj/dist', 'rm -rf /mnt/c/proj/node_modules', 'rm -rf {dist,build}', 'rm -rf src/{a,b}',
    'git commit -m "$(echo drop table legacy)"', ...(WIN ? [] : ['rm -rf /x/build']),
  ];
  const psBad = [
    'Remove-Item -Recurse -Force .\\out\\a,C:\\', 'Remove-Item -Recurse -Force .\\out\\a,~', 'Remove-Item -Recurse -Force ./out/a,/', 'Remove-Item -Recurse -Force node_modules, C:\\',
    "@'\nDROP TABLE old_users;\n'@ | Invoke-Sqlcmd", "@'\nDROP TABLE old_users;\n'@ | sqlcmd -S db", 'powershell -Command "Remove-Item -Recurse -Force dist,C:\\"',
  ];
  const psGood = [
    'Remove-Item -Recurse -Force node_modules, dist', 'Remove-Item -Recurse -Force node_modules,dist', 'Remove-Item -Recurse -Force .\\out\\a,.\\out\\b',
    "Select-String -Path .\\migrations\\*.sql -Pattern 'DROP TABLE'", "@'\nDROP TABLE old_users;\n'@ | Set-Content migrations\\002_down.sql",
    "@\"\nTRUNCATE TABLE cache;\n\"@ | Out-File -Encoding utf8 down.sql", "git commit -m @'\nmigrations: drop table legacy_users\n'@", 'cd C:\\proj; git commit -m "drop table old"',
  ];
  let failed = 0;
  const run = (tool, command, branch = () => null) => evaluate({ tool_name: tool, tool_input: { command } }, { branch });
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  for (const c of bad) check(c.replace(/\n/g, '\\n'), run('Bash', c)?.hookSpecificOutput.permissionDecision === MODE, 'expected a block');
  for (const c of good) check(c.replace(/\n/g, '\\n'), run('Bash', c) === null, 'expected silence');
  for (const c of psBad) check(`ps ${c.replace(/\n/g, '\\n')}`, run('PowerShell', c)?.hookSpecificOutput.permissionDecision === MODE, 'expected a block');
  for (const c of psGood) check(`ps ${c.replace(/\n/g, '\\n')}`, run('PowerShell', c) === null, 'expected silence');
  check('ps Remove-Item C:\\',!!run('PowerShell', 'Remove-Item -Recurse -Force C:\\'), 'expected a block');
  check('ps Remove-Item $env:X\\..', !!run('PowerShell', 'Remove-Item -Recurse -Force "$env:BUILD\\.."'), 'expected a block');
  check('ps Remove-Item $env:X\\..\\site', run('PowerShell', 'Remove-Item -Recurse -Force "$env:BUILD\\..\\site"') === null, 'expected silence');
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
