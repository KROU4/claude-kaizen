// Kaizen hook: protect-secrets
// What it does: denies file tools that touch secret stores (.env and .env.*, *.pem, *.key, *.p12, *.pfx,
//   *.kdbx, id_rsa*, id_ed25519*, anything under .ssh/, .aws/credentials, .netrc, .pypirc, secrets.yml|yaml|json,
//   credentials.json, service-account*.json) and Bash commands that print them (cat .env, type, Get-Content,
//   printenv, bare env, echo $API_TOKEN). Allowed: .env.example/.sample/.template and public keys (*.pub, also under .ssh/).
// Registered for: PreToolUse, matcher "Read|Edit|Write|MultiEdit|Bash|PowerShell" (shell commands are checked for both shells).
// Parameters (substituted by Kaizen at install time): extraPatterns (comma list of extra glob-ish patterns,
//   e.g. "*.secret,config/prod.yml,vault/"; a pattern without "/" matches the file name only).
// Remove: delete the PreToolUse entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node protect-secrets.mjs --selftest

const EXTRA_RAW = '{{extraPatterns}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const EXTRA = unset(EXTRA_RAW) ? [] : EXTRA_RAW.split(',').map((s) => s.trim()).filter(Boolean);

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'type', 'get-content', 'gc', 'bat', 'nl', 'tac', 'strings', 'xxd', 'od', 'base64']);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk']);
const SECRETY = /SECRET|TOKEN|PASSW(?:OR)?D|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY/i;

// Tiny glob -> RegExp: ** any depth, * inside a segment, ? one character; anchored at a path boundary.
function globRe(p) {
  const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp('(?:^|/)' + body + '$', 'i');
}

function isSecretPath(file, extras = EXTRA) {
  const norm = String(file).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const base = (parts[parts.length - 1] || '').toLowerCase();
  const dirs = parts.slice(0, -1).map((s) => s.toLowerCase());
  if (!base) return false;
  if (/^\.env(?:[.*?].*)?$/.test(base)) return !/\.(?:example|sample|template)$/.test(base);
  const extra = () => extras.some((p) => {
    const pat = p.replace(/\\/g, '/');
    if (pat.endsWith('/')) return dirs.some((d) => globRe(pat.slice(0, -1)).test(d));
    return globRe(pat).test(pat.includes('/') ? norm : base);
  });
  if (base.endsWith('.pub')) return extra(); // public keys are fine, also under .ssh/
  if (dirs.includes('.ssh')) return true;
  if (base === 'credentials' && dirs[dirs.length - 1] === '.aws') return true;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)/.test(base)) return true;
  if (/\.(?:pem|key|p12|pfx|kdbx)$/.test(base)) return true;
  if (/^(?:\.netrc|_netrc|\.pypirc|credentials\.json|secrets\.(?:ya?ml|json)|service-account.*\.json)$/.test(base)) return true;
  return extra();
}

// Quote-aware split of a command line into simple commands (one token array each).
function segments(cmd) {
  const segs = [];
  let toks = [], cur = '', has = false, q = null;
  const word = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const seg = () => { word(); if (toks.length) segs.push(toks); toks = []; };
  for (const c of cmd) {
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if ('\n;|&()`'.includes(c)) seg();
    else if (/\s/.test(c)) word();
    else { cur += c; has = true; }
  }
  seg();
  return segs;
}

// Returns the offending path (or a short description) when a Bash command would print a secret.
function bashHit(cmd, extras) {
  // PowerShell/.NET forms that the segment split below would cut apart at "(".
  if (/\bGetEnvironmentVariables\s*\(/i.test(cmd)) return 'the process environment';
  for (const m of cmd.matchAll(/\bGetEnvironmentVariable\s*\(\s*['"]?([\w.*-]+)/gi)) if (SECRETY.test(m[1])) return 'a secret environment variable';
  for (const m of cmd.matchAll(/\b(?:ReadAll(?:Text|Lines|Bytes)|OpenText)\s*\(\s*(['"])(.+?)\1/gi)) if (isSecretPath(m[2], extras)) return m[2];
  for (const raw of segments(cmd)) {
    let i = 0;
    while (i < raw.length && (/^[A-Za-z_]\w*=/.test(raw[i]) || /^(?:sudo|command|time|nohup|exec)$/i.test(raw[i]))) i++;
    const first = raw[i] || '';
    const name = first.split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
    // "-Path:.env" is one token in PowerShell: split it so the path is seen.
    const args = raw.slice(i + 1).map((a) => a.replace(/^\d*<+/, '')).flatMap((a) => { const m = /^-(?:path|literalpath|lp|filepath|pspath):(.+)$/i.exec(a); return m ? ['-path', m[1]] : [a]; });
    const pos = args.filter((a) => a && !a.startsWith('-'));
    if (READERS.has(name) || PATTERN_FIRST.has(name)) {
      const file = (PATTERN_FIRST.has(name) ? pos.slice(1) : pos).find((a) => isSecretPath(a, extras));
      if (file) return file;
    }
    if (name === 'select-string' || name === 'sls') {
      // The pattern is the first positional unless -Path/-Pattern name the parameters explicitly.
      const named = args.some((a) => /^-(?:path|literalpath|lp|pattern)$/i.test(a));
      const file = (named ? pos : pos.slice(1)).find((a) => isSecretPath(a, extras));
      if (file) return file;
    }
    if (name === 'printenv' && (!pos.length || pos.some((a) => SECRETY.test(a)))) return 'the process environment';
    if (name === 'env' && !pos.length) return 'the process environment';
    if (/^(?:get-childitem|gci|dir|ls|get-item|gi|get-itemproperty|gp|get-content|gc)$/.test(name)) {
      // Env: drive: the bare drive (also "Env:\", "env:*") lists everything; "env:NAME" prints one value.
      for (const a of pos) {
        const m = /^env:[\\/]?(.*)$/i.exec(a);
        if (m && (!m[1] || /^\*+$/.test(m[1]) || SECRETY.test(m[1]))) return 'the process environment';
      }
    }
    if (/^(?:echo|printf|write-host|write-output|write-error|write-warning|write-verbose|write-information|out-host|out-string)$/.test(name)
      && args.some((a) => [...a.matchAll(/\$\{?(?:env:)?(\w+)/g)].some((m) => SECRETY.test(m[1])))) return 'a secret environment variable';
    // A bare expression ($env:API_TOKEN, "$env:API_TOKEN") prints its value in PowerShell; an assignment does not.
    if (/\$\{?env:\w+/i.test(first) && !/\$\{?env:\w+\}?\s*[+\-*\/]?=/i.test(first) && !/^[+\-*\/]?=$/.test(raw[i + 1] || '')
      && [...first.matchAll(/\$\{?env:(\w+)/gi)].some((m) => SECRETY.test(m[1]))) return 'a secret environment variable';
  }
  return null;
}

const deny = (what) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kaizen: ${what} looks like a secret store; ask the user to paste only the needed values.` } });

function evaluate(payload, extras = EXTRA) {
  const input = payload.tool_input || {};
  const file = input.file_path || input.notebook_path;
  if (typeof file === 'string' && file) return isSecretPath(file, extras) ? deny(file) : null;
  const hit = (payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell') && typeof input.command === 'string' ? bashHit(input.command, extras) : null;
  return hit ? deny(hit) : null;
}

function selftest() {
  const file = (tool, p) => ({ tool_name: tool, tool_input: { file_path: p } });
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
  const cases = [
    [file('Read', '/app/.env'), true], [file('Read', 'C:\\proj\\.env.production'), true], [file('Read', '/home/u/.ssh/id_rsa'), true], [file('Read', '/home/u/.aws/credentials'), true],
    [file('Read', '/x/server.pem'), true], [file('Read', '/x/id_ed25519'), true], [file('Read', '/x/.netrc'), true], [file('Read', 'config/secrets.yaml'), true],
    [file('Read', 'service-account-prod.json'), true], [file('Read', 'vault.kdbx'), true], [file('Write', '/app/.env'), true], [file('Edit', '/app/.env.local'), true],
    [{ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/x/.env' } }, true],
    [file('Read', '/app/.env.example'), false], [file('Read', '/app/.env.sample'), false], [file('Read', '/app/.env.template'), false], [file('Edit', 'src/app.ts'), false],
    [file('Read', 'README.md'), false], [file('Read', '/x/id_rsa.pub'), false], [file('Read', '/home/u/.ssh/id_ed25519.pub'), false], [file('Read', 'C:\\Users\\u\\.ssh\\id_rsa.pub'), false], [file('Read', '/home/u/.ssh/known_hosts'), true],
    [bash('cat ~/.ssh/id_rsa.pub'), false], [ps('Get-Content $env:USERPROFILE\\.ssh\\id_ed25519.pub'), false], [bash('cat ~/.ssh/id_rsa'), true], [file('Read', '/x/environment.js'), false], [file('Read', '/x/.envrc'), false],
    [bash('cat .env'), true], [bash('type C:\\a\\.env'), true], [bash('Get-Content secrets.json'), true], [bash('head -n 3 ~/.ssh/id_rsa'), true], [bash('tail -f .env.local'), true],
    [bash('printenv'), true], [bash('env | sort'), true], [bash('echo $GITHUB_TOKEN'), true], [bash('cat < .env'), true], [bash('grep API_KEY .env'), true],
    [bash('cat README.md'), false], [bash('ls -la'), false], [bash('cat .env.example'), false], [bash('echo $PATH'), false], [bash('grep -r ".env" src'), false],
    [bash('cp .env.example .env'), false], [bash('printenv PATH'), false], [bash('env FOO=1 node a.js'), false], [bash('git status'), false],
    [bash('cat .env*'), true],
    [ps('Get-Content .env'), true], [ps('Get-Content -Path .\\.env'), true], [ps('type .\\.env'), true], [ps('gc C:\\proj\\.env.production'), true], [ps('cat ~/.ssh/id_rsa'), true],
    [ps('Get-ChildItem env:'), true], [ps('Write-Host $env:GITHUB_TOKEN'), true], [ps('Get-Content .env; ls'), true],
    [ps('Get-Content README.md'), false], [ps('Get-Content .env.example'), false], [ps('Write-Host $env:PATH'), false], [ps('Get-ChildItem'), false],
    [ps('$env:GITHUB_TOKEN'), true], [ps('"$env:API_TOKEN"'), true], [ps('${env:API_TOKEN}'), true], [ps('Write-Output "token: $env:API_TOKEN"'), true], [ps('echo $env:AWS_SECRET_ACCESS_KEY'), true],
    [ps('Get-ChildItem Env:\\'), true], [ps('dir env:\\'), true], [ps('ls env:'), true], [ps('gci env:'), true], [ps('Get-ChildItem env:GITHUB_TOKEN'), true], [ps('Get-Item env:API_TOKEN'), true],
    [ps('(Get-Item env:API_TOKEN).Value'), true], [ps("[Environment]::GetEnvironmentVariable('API_TOKEN')"), true], [ps('[Environment]::GetEnvironmentVariables()'), true],
    [ps('Select-String -Path .env -Pattern KEY'), true], [ps('sls KEY .env'), true], [ps('Select-String KEY -Path:.env'), true], [ps('Get-Content -Path:.env'), true], [ps("[IO.File]::ReadAllText('.env')"), true],
    [ps('$env:PATH'), false], [ps('"$env:PATH"'), false], [ps('Get-Item env:PATH'), false], [ps('Get-ChildItem env:PATH'), false], [ps('Get-ChildItem C:\\proj'), false], [ps('dir'), false],
    [ps('$env:API_TOKEN = "x"'), false], [ps('$env:PATH += ";C:\\bin"'), false], [ps('Select-String -Path .env.example -Pattern KEY'), false], [ps('sls TODO README.md'), false],
    [ps('sls .env README.md'), false], [ps('Get-Content -Path:.env.example'), false], [ps("[Environment]::GetEnvironmentVariable('PATH')"), false], [ps('Write-Output $env:PATH'), false],
    [{ tool_name: 'WebFetch', tool_input: { command: 'cat .env' } }, false],
  ];
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  for (const [p, expect] of cases) {
    const r = evaluate(p, []);
    const name = `${p.tool_name} ${p.tool_input.file_path || p.tool_input.notebook_path || p.tool_input.command}`;
    check(name, !!r === expect && (!r || r.hookSpecificOutput.permissionDecision === 'deny'), expect ? 'expected deny' : 'expected silence');
  }
  const extras = ['*.secret', 'config/prod.yml', 'vault/'];
  check('extra *.secret', !!evaluate(file('Read', 'a/b.secret'), extras), 'expected deny');
  check('extra config/prod.yml', !!evaluate(file('Read', '/x/config/prod.yml'), extras), 'expected deny');
  check('extra vault/', !!evaluate(file('Read', '/x/vault/a.txt'), extras), 'expected deny');
  check('extra no false hit', evaluate(file('Read', '/x/config/dev.yml'), extras) === null, 'expected silence');
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
