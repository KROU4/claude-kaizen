// Behaviour of the guard-destructive and protect-secrets hook templates, run as real child processes
// with a PreToolUse payload on stdin (the way Claude Code runs them), rendered the way `apply` renders them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'recipes', 'templates', 'hooks');
let tmp;
let renderTemplate;
const scripts = {};

function render(name, params = {}) {
  const text = fs.readFileSync(path.join(HOOKS, name), 'utf8');
  const file = path.join(tmp, `${Object.values(params).join('_').replace(/[^\w-]/g, '') || 'default'}-${name}`);
  fs.writeFileSync(file, renderTemplate(text, params, { js: true }));
  return file;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-hooks-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.KAIZEN_STATE_DIR = path.join(tmp, 'state');
  ({ renderTemplate } = await import('../scripts/lib/apply.mjs'));
  scripts.guard = render('guard-destructive.mjs', { mode: 'deny', protectedBranches: 'main,master' });
  scripts.guardAsk = render('guard-destructive.mjs', { mode: 'ask', protectedBranches: 'main,master' });
  scripts.secrets = render('protect-secrets.mjs', { extraPatterns: '*.secret' });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(script, payload) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const shell = (tool, command) => ({ tool_name: tool, tool_input: { command } });

test('rendered templates pass their own --selftest', () => {
  for (const script of [scripts.guard, scripts.guardAsk, scripts.secrets]) {
    const r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/^FAIL/m.test(r.stdout), r.stdout);
  }
});

test('protect-secrets: PowerShell tool commands are checked like Bash ones', () => {
  for (const c of ['Get-Content .env', 'Get-Content -Path .\\.env', 'type .\\.env', 'gc C:\\proj\\.env.production', 'cat ~/.ssh/id_rsa', 'Get-ChildItem env:', 'Write-Host $env:GITHUB_TOKEN']) {
    const out = run(scripts.secrets, shell('PowerShell', c));
    assert.equal(out && out.permissionDecision, 'deny', c);
    assert.equal(run(scripts.secrets, shell('Bash', c.replace(/\\/g, '/'))) !== null, true, `Bash twin of ${c}`);
  }
  for (const c of ['Get-Content README.md', 'Get-Content .env.example', 'Write-Host $env:PATH', 'Get-ChildItem']) {
    assert.equal(run(scripts.secrets, shell('PowerShell', c)), null, c);
  }
});

test('protect-secrets: PowerShell env printing and .env searching are denied, harmless forms stay allowed', () => {
  const bad = [
    '$env:GITHUB_TOKEN', '"$env:API_TOKEN"', '${env:API_TOKEN}', 'Write-Output "token: $env:API_TOKEN"', 'echo $env:AWS_SECRET_ACCESS_KEY',
    'Get-ChildItem Env:\\', 'dir env:\\', 'ls env:', 'gci env:', 'Get-ChildItem env:GITHUB_TOKEN', 'Get-Item env:API_TOKEN', '(Get-Item env:API_TOKEN).Value',
    "[Environment]::GetEnvironmentVariable('API_TOKEN')", '[Environment]::GetEnvironmentVariable("API_TOKEN", "User")', '[Environment]::GetEnvironmentVariables()',
    'Select-String -Path .env -Pattern KEY', 'sls KEY .env', 'Select-String KEY -Path:.env', 'Get-Content -Path:.env', "[IO.File]::ReadAllText('.env')",
  ];
  for (const c of bad) {
    const out = run(scripts.secrets, shell('PowerShell', c));
    assert.equal(out && out.permissionDecision, 'deny', c);
  }
  const good = [
    '$env:PATH', '"$env:PATH"', 'Get-Item env:PATH', 'Get-ChildItem env:PATH', 'Get-ChildItem C:\\proj', 'dir', '$env:API_TOKEN = "x"', '$env:PATH += ";C:\\bin"',
    'Select-String -Path .env.example -Pattern KEY', 'sls TODO README.md', 'sls .env README.md', 'Get-Content -Path:.env.example',
    "[Environment]::GetEnvironmentVariable('PATH')", 'Write-Output $env:PATH',
  ];
  for (const c of good) assert.equal(run(scripts.secrets, shell('PowerShell', c)), null, c);
});

test('protect-secrets: a glob over .env files is a secret read; unrelated tools are ignored', () => {
  assert.equal(run(scripts.secrets, shell('Bash', 'cat .env*')).permissionDecision, 'deny');
  assert.equal(run(scripts.secrets, shell('Bash', 'cat .envrc')), null);
  assert.equal(run(scripts.secrets, shell('WebFetch', 'cat .env')), null);
});

test('guard-destructive: heredoc bodies are scanned when the heredoc feeds a shell', () => {
  const bad = [
    "bash <<'EOF'\nrm -rf /\nEOF",
    'sh <<EOF\nrm -rf ~\nEOF',
    'sudo bash <<-EOF\n\tgit reset --hard\n\tEOF',
    'bash -e <<EOF\nset -e\nrm -rf "$BUILD_DIR"/\nEOF',
    'cd repo && bash <<EOF\ngit clean -fdx\nEOF',
    'cat <<EOF | bash\nrm -rf /\nEOF',
    'bash <<< "rm -rf /"',
    'eval "$(cat <<EOF\nrm -rf /\nEOF\n)"',
    'zsh << EOF\ngit branch -D old\nEOF',
  ];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', JSON.stringify(c));
  }
  assert.equal(run(scripts.guardAsk, shell('Bash', bad[0])).permissionDecision, 'ask');
  const pwsh = run(scripts.guard, shell('PowerShell', "pwsh <<'EOF'\nRemove-Item -Recurse -Force C:\\\nEOF"));
  assert.equal(pwsh && pwsh.permissionDecision, 'deny');
});

test('guard-destructive: heredocs that are plain data stay allowed', () => {
  const good = [
    'cat <<EOF > a.md\nrm -rf /\nEOF',
    'cat <<EOF | tee a.sh\nrm -rf /\nEOF',
    "bash <<'EOF'\necho hi\nls\nEOF",
    'bash run.sh <<EOF\nrm -rf /\nEOF',
    'git commit -m "$(cat <<\'EOF\'\nfix: never rm -rf /\nEOF\n)"',
  ];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, JSON.stringify(c));
});

test('guard-destructive: ".." is collapsed before judging an rm target', () => {
  const bad = ['rm -rf ~/../..', 'rm -rf /opt/..', 'rm -rf /tmp/..', 'rm -rf ~/proj/..', 'rm -rf $HOME/x/..', 'rm -rf /home/alice/..', 'rm -rf C:/Users/me/..', 'rm -rf "$PROJECT/.."', 'rm -rf foo/..', 'rm -rf ./build/../..', 'chmod -R 777 /opt/..'];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', c);
  }
  const ps = run(scripts.guard, shell('PowerShell', 'Remove-Item -Recurse -Force C:\\Users\\me\\..'));
  assert.equal(ps && ps.permissionDecision, 'deny');
  for (const c of ['rm -rf ./build/../dist', 'rm -rf ../out', 'rm -rf node_modules', 'rm -rf ./tmp/foo', 'rm -rf ~/proj/build']) {
    assert.equal(run(scripts.guard, shell('Bash', c)), null, c);
  }
});

test('guard-destructive: a variable base is unknown, so ".." after it is not a cwd-relative path', () => {
  const good = ['rm -rf "$ROOT/../site"', 'rm -rf "$SCRIPT_DIR/../release-tmp"', 'rm -rf "${BUILD_DIR}/../tmp-artifacts"', 'rm -rf "$(pwd)/../x"', 'rm -rf "$repo/../$name"', 'rm -rf "%ROOT%/../x"', 'rm -rf "$ROOT/site"', 'rm -rf "$ROOT/$name/.."'];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, c);
  assert.equal(run(scripts.guard, shell('PowerShell', 'Remove-Item -Recurse -Force "$env:BUILD\\..\\site"')), null);
  const bad = ['rm -rf "$ROOT/.."', 'rm -rf "${BUILD_DIR}/../.."', 'rm -rf "$(pwd)/.."', 'rm -rf "%ROOT%/.."', 'rm -rf "$ROOT/../"*', 'rm -rf "$tmp"/', 'rm -rf $VAR/*'];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', c);
  }
  const ps = run(scripts.guard, shell('PowerShell', 'Remove-Item -Recurse -Force "$env:BUILD\\.."'));
  assert.equal(ps && ps.permissionDecision, 'deny');
});

test('guard-destructive: a heredoc body is judged only for the command it belongs to', () => {
  const good = [
    'cat <<EOF > a.md\nrm -rf /\nEOF\nbash <<X\necho hi\nX',
    'cat <<EOF > deploy.md\nrm -rf ~/old\nEOF\ngit add deploy.md && eval "$(ssh-agent -s)"',
    'cat <<EOF > notes.md\nrm -rf ~\nEOF\nsource venv/bin/activate && bash -l',
    'cat <<EOF > a.md\nrm -rf /\nEOF\nsh -c "echo done"',
    'cat <<EOF | tee a.sh\nrm -rf /\nEOF\nbash run.sh',
  ];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, JSON.stringify(c));
  const bad = [
    'cat <<EOF > a.md\nhi\nEOF\nbash <<X\nrm -rf /\nX',
    'cat <<EOF > a.md\nhi\nEOF\ncat <<EOF | bash\nrm -rf /\nEOF',
    'cat <<EOF | tr a b | bash\nrm -rf /\nEOF',
    'echo start; eval "$(cat <<EOF\nrm -rf /\nEOF\n)"',
  ];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', JSON.stringify(c));
  }
});

test('guard-destructive: bash options with an argument and a glued heredoc still reach the script body', () => {
  const bad = [
    "bash -euo pipefail <<'EOF'\nrm -rf /\nEOF",
    'bash -o pipefail <<EOF\nrm -rf /\nEOF',
    'bash +o history <<EOF\nrm -rf /\nEOF',
    'bash -O extglob <<EOF\nrm -rf /\nEOF',
    'bash --rcfile ~/.bashrc <<EOF\nrm -rf /\nEOF',
    'bash<<EOF\nrm -rf /\nEOF',
    'sudo bash -eu -o pipefail <<EOF\ngit reset --hard\nEOF',
  ];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', JSON.stringify(c));
  }
  for (const c of ["bash -euo pipefail <<'EOF'\necho hi\nEOF", 'bash -o pipefail run.sh <<EOF\nrm -rf /\nEOF', 'bash -o pipefail script.sh']) {
    assert.equal(run(scripts.guard, shell('Bash', c)), null, JSON.stringify(c));
  }
});

test('guard-destructive: SQL in a heredoc is blocked unless the heredoc only feeds a text-only sink', () => {
  const bad = [
    "psql mydb <<'SQL'\nDROP TABLE users;\nSQL",
    'cat <<EOF | mysql app\nTRUNCATE TABLE logs;\nEOF',
    'python3 - <<EOF\nimport sqlite3\nsqlite3.connect("a.db").execute("DROP TABLE t")\nEOF',
    'node --input-type=module <<EOF\nawait db.query("DROP TABLE users")\nEOF',
    'python manage.py dbshell <<EOF\nDROP TABLE x;\nEOF',
    'rails dbconsole <<EOF\nDROP TABLE x;\nEOF',
    'cat <<EOF | python3 -\nTRUNCATE TABLE a\nEOF',
    'cat <<EOF | tr a b | mysql\nDROP TABLE x;\nEOF',
    'ssh db psql <<EOF\nDROP DATABASE x;\nEOF',
    'docker exec -i db psql -U app <<EOF\nDROP TABLE x;\nEOF',
    'sudo -u postgres psql <<EOF\nTRUNCATE TABLE x;\nEOF',
    'ruby <<EOF\nDB.run "DROP TABLE x"\nEOF',
    'cat <<EOF > a.sql\nhi\nEOF\npsql -c "DROP TABLE x"',
    'cat <<EOF > a.sql\nhi\nEOF\npython3 - <<X\nDROP TABLE y\nX',
  ];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', JSON.stringify(c));
  }
  assert.equal(run(scripts.guardAsk, shell('Bash', bad[2])).permissionDecision, 'ask');
});

test('guard-destructive: SQL written to a file through a text-only heredoc stays allowed', () => {
  const good = [
    'cat <<EOF > migrations/001.sql\nDROP TABLE old_users;\nEOF\nnode scripts/check.js',
    "cat > down.sql <<'SQL'\nTRUNCATE TABLE cache;\nSQL",
    'cat <<EOF | tee down.sql\nDROP TABLE x;\nEOF',
    'cat <<EOF >> migrations/002.sql\nDROP TABLE x;\nEOF\ngit add migrations',
    'git commit -F - <<EOF\ndocs: why we DROP TABLE legacy\nEOF',
    'cat <<EOF > prisma/migrations/20261101_x/migration.sql\nDROP TABLE old_users;\nEOF',
    'cat <<EOF > db/mysql/down.sql\nDROP TABLE cache;\nEOF',
    'cat <<EOF | tee db/psql/down.sql\nDROP TABLE x;\nEOF',
  ];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, JSON.stringify(c));
});

test('guard-destructive: SQL clients are matched by command name, not by a path or message text', () => {
  const good = [
    'git commit -m "docs: explain drop table in prisma migrations"',
    'git show HEAD:prisma/migrations/1/migration.sql | grep -i "drop table"',
    'grep -rn "DROP TABLE" db/mysql/ prisma/',
    'echo "DROP TABLE x" > ./mysql/notes.sql',
    'git log -S"TRUNCATE TABLE" -- prisma/migrations',
  ];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, JSON.stringify(c));
  const bad = ['psql -c "DROP TABLE users"', 'sudo -u postgres psql -c "DROP TABLE x"', 'echo "TRUNCATE TABLE a;" | mysql', 'docker exec db psql -c "TRUNCATE TABLE logs"', 'python manage.py dbshell -c "DROP TABLE x"', '/usr/bin/psql -c "DROP TABLE x"', 'rails dbconsole -e "DROP TABLE x"'];
  for (const c of bad) {
    const out = run(scripts.guard, shell('Bash', c));
    assert.equal(out && out.permissionDecision, 'deny', c);
  }
});

test('format-on-edit: a shell file is formatted by shfmt when it is on PATH and left alone when it is not', () => {
  const script = render('format-on-edit.mjs', { formatter: 'shfmt', timeoutSec: '20' });
  const bin = path.join(tmp, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  // a fake shfmt that rewrites its last argument, so the test needs no real formatter
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'shfmt.cmd'), '@echo off\r\n> "%~2" echo formatted\r\n');
  else fs.writeFileSync(path.join(bin, 'shfmt'), '#!/bin/sh\nprintf formatted > "$2"\n', { mode: 0o755 });
  const target = path.join(tmp, 'deploy.sh');
  const other = path.join(tmp, 'notes.md');
  const go = (file, pathVar) => {
    fs.writeFileSync(file, 'x');
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_input: { file_path: file } }), encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, PATH: pathVar } });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(file, 'utf8');
  };
  assert.match(go(target, `${bin}${path.delimiter}${path.dirname(process.execPath)}`), /^formatted/);
  assert.equal(go(target, path.dirname(process.execPath)), 'x', 'no shfmt on PATH: nothing happens');
  assert.equal(go(other, `${bin}${path.delimiter}${path.dirname(process.execPath)}`), 'x', 'shfmt does not touch other file types');
});

// A fake CLI that appends "<cwd>|<args>" to the file named by KZ_LOG, so tests see exactly how a formatter was called.
function fakeTool(name) {
  const bin = fs.mkdtempSync(path.join(tmp, 'fake-'));
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${name}.cmd`), '@echo off\r\n>> "%KZ_LOG%" echo %CD%^|%*\r\n');
  else fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$KZ_LOG"\n', { mode: 0o755 });
  return bin;
}
function runFormatter(script, bin, file, cwd) {
  const log = path.join(bin, 'calls.log');
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_input: { file_path: file }, cwd }), encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, KZ_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  // .cmd shims are started through cmd.exe with every argument quoted: drop the quotes before comparing
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').replace(/"/g, '').split(/\r?\n/).filter(Boolean) : [];
}

test('format-on-edit: Python gets `ruff format` only, never a lint autofix that deletes unused imports', () => {
  for (const formatter of ['auto', 'ruff']) {
    const bin = fakeTool('ruff');
    const file = path.join(bin, 'a.py');
    fs.writeFileSync(file, 'import os\n');
    const calls = runFormatter(render('format-on-edit.mjs', { formatter, timeoutSec: '20' }), bin, file, bin);
    assert.equal(calls.length, 1, `${formatter}: ${calls.join(' / ')}`);
    assert.match(calls[0], /\|format /);
    assert.doesNotMatch(calls.join('\n'), /check|--fix/);
  }
});

test('format-on-edit: dotnet format runs in the project directory with a relative --include path', () => {
  const bin = fakeTool('dotnet');
  const proj = path.join(bin, 'app');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'app.csproj'), '<Project/>');
  const file = path.join(proj, 'src', 'A.cs');
  fs.writeFileSync(file, 'class A{}');
  const calls = runFormatter(render('format-on-edit.mjs', { formatter: 'dotnet format', timeoutSec: '20' }), bin, file, proj);
  assert.equal(calls.length, 1, calls.join(' / '));
  const [cwd, args] = calls[0].split('|');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(proj));
  assert.match(args, /^format .*app\.csproj --include src[\\/]A\.cs$/);
});

test('format-on-edit: timeoutSec cannot exceed the 30 s hook timeout (the rendered selftest checks the cap)', () => {
  const script = render('format-on-edit.mjs', { formatter: 'auto', timeoutSec: '120' });
  const r = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok timeout is capped below the hook timeout/);
});

test('session-context: non-ASCII file names are shown as written, not as octal escapes', (t) => {
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) return t.skip('git is not installed');
  const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(repo, 'файл с пробелом.txt'), 'x');
  const script = render('session-context.mjs', { maxChars: '1500', includeGit: 'true' });
  const out = run(script, { hook_event_name: 'SessionStart', session_id: 'nonascii', cwd: repo });
  assert.ok(out && out.additionalContext.includes('файл с пробелом.txt'), JSON.stringify(out));
  assert.doesNotMatch(out.additionalContext, /\\\d{3}/);
});

test('long-command-nudge: PowerShell calls are nudged like Bash ones; wrapped or short ones are not', () => {
  const script = render('long-command-nudge.mjs', {});
  const st = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.ok(!/^FAIL/m.test(st.stdout), st.stdout);
  for (const c of ['npm run dev', 'Start-Sleep -Seconds 300', 'while ($true) { Get-Date }', 'tsc --watch', 'Get-Content app.log -Wait']) {
    const out = run(script, shell('PowerShell', c));
    assert.ok(out && /run_in_background/.test(out.additionalContext), c);
    assert.equal('permissionDecision' in out, false, 'a nudge never decides permissions');
  }
  for (const c of ['Start-Sleep -Seconds 5', 'Start-Job { npm run dev }', 'npm run build', 'npm run dev']) {
    const payload = shell('PowerShell', c);
    if (c === 'npm run dev') payload.tool_input.run_in_background = true;
    assert.equal(run(script, payload), null, c);
  }
});

test('long-command-nudge: here-string and heredoc bodies, Start-Job in assignments and blocks, -Wait forms and .cmd shims', () => {
  const script = render('long-command-nudge.mjs', {});
  const quiet = [
    ['PowerShell', "git commit -m @'\nnpm run dev now loads .env\n'@"],
    ['PowerShell', "@'\n## Dev\nnpm run dev\n'@ | Set-Content README.md"],
    ['Bash', "git commit -m \"$(cat <<'EOF'\nnpm start works again\nEOF\n)\""],
    ['Bash', 'cat <<EOF > a.md\ntail -f x\nEOF'],
    ['PowerShell', "Write-Host 'while ($true) loop removed'"],
    ['PowerShell', '$job = Start-Job { Start-Sleep 600 }'],
    ['PowerShell', '$job = Start-Job -ScriptBlock { while ($true) { Get-Date; Start-Sleep 5 } }'],
    ['PowerShell', 'Start-Job -ScriptBlock {\n  npm run dev\n}'],
    ['PowerShell', 'Start-Job { Start-Sleep 5 } | Wait-Job'],
    ['PowerShell', 'Start-Job { npm run dev } | Wait-Job -Timeout 5'],
    ['PowerShell', 'Start-Process msiexec -ArgumentList "/i a.msi" -Wait'],
  ];
  for (const [tool, c] of quiet) assert.equal(run(script, shell(tool, c)), null, c);
  const nudged = [
    ['PowerShell', "Start-Process npm -ArgumentList 'run','dev' -Wait -NoNewWindow"],
    ['PowerShell', 'Start-Job { npm run dev } | Receive-Job -Wait'],
    ['PowerShell', 'Start-Job { npm run dev } | Wait-Job'],
    ['PowerShell', '$j = Start-Job { npm run dev }; Wait-Job $j'],
    ['PowerShell', 'npx.cmd vite'],
    ['PowerShell', 'pnpm.cmd exec vite'],
    ['Bash', 'cat <<EOF > a.md\nx\nEOF\nnpm run dev'],
  ];
  for (const [tool, c] of nudged) {
    const out = run(script, shell(tool, c));
    assert.ok(out && /run_in_background/.test(out.additionalContext), c);
  }
});

test('guard-destructive: SQL text is judged by the command it belongs to, not by every command on the line', () => {
  const good = [
    'cd C:/Users/KROU4/proj && git commit -m "migrations: drop table legacy_users"',
    'cd migrations && grep -n "DROP TABLE" *.sql',
    'rg -n "drop table" migrations && npm test',
    'pushd db && git log -S"TRUNCATE TABLE" && popd',
    'msg="drop table x"; git commit -m "$msg"',
  ];
  for (const c of good) assert.equal(run(scripts.guard, shell('Bash', c)), null, c);
  const bad = ['cd db && psql -c "DROP TABLE x"', 'git log -S"drop table" && psql -c "select 1"', 'q="DROP TABLE x"; python run.py "$q"', 'cd x && python migrate.py "drop table y"', 'echo "DROP TABLE x" | cd . | mysql'];
  for (const c of bad) assert.equal(run(scripts.guard, shell('Bash', c))?.permissionDecision, 'deny', c);
  const psGood = [
    "Select-String -Path .\\migrations\\*.sql -Pattern 'DROP TABLE'",
    "@'\nDROP TABLE old_users;\n'@ | Set-Content migrations\\002_down.sql",
    "@\"\nTRUNCATE TABLE cache;\n\"@ | Out-File down.sql",
    "git commit -m @'\nmigrations: drop table legacy_users\n'@",
    'cd C:\\proj; git commit -m "drop table old"',
  ];
  for (const c of psGood) assert.equal(run(scripts.guard, shell('PowerShell', c)), null, JSON.stringify(c));
  const psBad = ["@'\nDROP TABLE old_users;\n'@ | Invoke-Sqlcmd", "@'\nDROP TABLE x;\n'@ | sqlcmd -S db", 'Invoke-Sqlcmd -Query "DROP TABLE x"'];
  for (const c of psBad) assert.equal(run(scripts.guard, shell('PowerShell', c))?.permissionDecision, 'deny', JSON.stringify(c));
});

test('guard-destructive: PowerShell comma-separated paths are an array, each one judged on its own', () => {
  for (const c of ['Remove-Item -Recurse -Force node_modules, dist', 'Remove-Item -Recurse -Force node_modules,dist', 'Remove-Item -Recurse -Force .\\out\\a,.\\out\\b']) {
    assert.equal(run(scripts.guard, shell('PowerShell', c)), null, c);
  }
  for (const c of ['Remove-Item -Recurse -Force .\\out\\a,C:\\', 'Remove-Item -Recurse -Force .\\out\\a,~', 'Remove-Item -Recurse -Force ./out/a,/', 'Remove-Item -Recurse -Force dist, C:\\', 'powershell -Command "Remove-Item -Recurse -Force dist,C:\\"']) {
    assert.equal(run(scripts.guard, shell('PowerShell', c))?.permissionDecision, 'deny', c);
  }
  // in Bash a comma is part of the file name: not an array, and a single top-level name is still flagged
  assert.equal(run(scripts.guard, shell('Bash', 'rm -rf a/b,c/d')), null);
});

test('guard-destructive: Git Bash / WSL drive paths and cmd //c are judged like C:\\ paths', () => {
  // bare /c is a Git Bash drive only on Windows; elsewhere /c/... is an ordinary directory
  const gitBash = process.platform === 'win32' ? ['rm -rf /c/Users/KROU4', 'rm -rf /c/Users/KROU4/', 'rm -rf /c/Users', 'rm -rf /c/Windows', 'rm -rf /c', 'rm -rf /c/'] : [];
  const bad = [...gitBash, 'rm -rf /mnt/c/Users/me', 'rm -rf /cygdrive/c/Windows',
    'cmd //c "rd /s /q C:\\"', "cmd //c 'rd /s /q C:\\'", 'cmd //c rd /s /q C:\\', 'cmd //c "rd /s /q C:/"', 'cmd.exe /c "rd /s /q C:\\"'];
  for (const c of bad) assert.equal(run(scripts.guard, shell('Bash', c))?.permissionDecision, 'deny', c);
  for (const c of ['rm -rf /c/Users/KROU4/proj/dist', 'rm -rf /mnt/c/proj/node_modules', 'rm -rf /c/proj/build/*', 'cmd //c "dir C:\\"']) {
    assert.equal(run(scripts.guard, shell('Bash', c)), null, c);
  }
});

test('protect-secrets: public keys are readable everywhere, private keys and the rest of .ssh stay denied', () => {
  const pub = [
    shell('Bash', 'cat ~/.ssh/id_ed25519.pub'),
    shell('PowerShell', 'Get-Content $env:USERPROFILE\\.ssh\\id_ed25519.pub'),
    { tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\KROU4\\.ssh\\id_rsa.pub' } },
    { tool_name: 'Read', tool_input: { file_path: '/home/u/.ssh/id_ed25519.pub' } },
  ];
  for (const p of pub) assert.equal(run(scripts.secrets, p), null, JSON.stringify(p));
  const priv = [
    shell('Bash', 'cat ~/.ssh/id_ed25519'),
    { tool_name: 'Read', tool_input: { file_path: '/home/u/.ssh/id_rsa' } },
    { tool_name: 'Read', tool_input: { file_path: '/home/u/.ssh/config' } },
    { tool_name: 'Read', tool_input: { file_path: '/home/u/.ssh/known_hosts' } },
  ];
  for (const p of priv) assert.equal(run(scripts.secrets, p)?.permissionDecision, 'deny', JSON.stringify(p));
});

test('verify-before-stop: Windows shims and build-tool wrappers count as test runs; the rendered selftest passes', () => {
  const script = render('verify-before-stop.mjs', { mode: 'block' });
  const st = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.ok(!/^FAIL/m.test(st.stdout), st.stdout);
  const line = (o) => JSON.stringify(o);
  const turn = (command, tool = 'PowerShell') => {
    const file = path.join(tmp, `vbs-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(file, [
      line({ type: 'user', message: { role: 'user', content: 'fix it' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: 'C:\\p\\src\\a.ts' } }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: tool, input: { command } }] } }),
    ].join('\n') + '\n');
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ transcript_path: file }), encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  for (const c of ['npm.cmd test', 'pnpm.cmd run lint', 'yarn.cmd test', './mvnw test', 'mvnw.cmd verify', '.\\gradlew.bat test', './gradlew test', 'npx.cmd vitest run', 'npm test']) {
    assert.equal(turn(c), '', c);
  }
  assert.match(turn('git status'), /"decision":"block"/);
});
