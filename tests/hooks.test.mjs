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
