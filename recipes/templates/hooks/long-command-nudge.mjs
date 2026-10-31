// Kaizen hook: long-command-nudge
// What it does: when Claude starts a Bash or PowerShell command that usually never exits or runs very long without a
//   guard (npm/yarn/pnpm dev|start, vite, next dev, python -m http.server, flask run, uvicorn, docker compose up
//   without -d, tail -f, watch, --watch modes, ssh/plink without -batch or BatchMode, sleep or Start-Sleep of 120 s
//   or more) it adds one line of context suggesting run_in_background or a timeout. PowerShell adds Get-Content -Wait,
//   ping -t, `timeout /t N`, while ($true) loops without break and Start-Sleep inside script blocks. It only adds
//   context: no permissionDecision is returned, so the normal permission flow stays exactly as it was (an "allow"
//   would skip the permission prompt, which a nudge must not do).
//   Silent when run_in_background is true, when the command is already wrapped (timeout, nohup, trailing &,
//   Start-Process, Start-Job, also after `$j =`), when the pattern is not at the start of a command (pip install
//   uvicorn, grep vite package.json, git commit -m "...") or sits in a here-string / heredoc body (commit messages,
//   file content). `Start-Process -Wait` of a long command and `Wait-Job` / `Receive-Job -Wait` (without -Timeout)
//   on a job that runs one block the tool, so they are nudged.
// Registered for: PreToolUse, matcher "Bash|PowerShell".
// Parameters: none.
// Remove: delete the PreToolUse entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node long-command-nudge.mjs --selftest

const MESSAGE = 'Kaizen: this command may run for a long time or never exit. Prefer run_in_background: true or wrap it with a timeout (e.g. `timeout 300 …`, or Start-Process / a bounded wait in PowerShell).';
const TOOLS = new Set(['Bash', 'PowerShell']);

// Commands that normally keep running until killed; each is matched at the start of a command.
const LONG = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/i,
  /^vite(?![\w.-])(?!\s+build\b)/i,
  /^(?:next\s+(?:dev|start)|ng\s+serve|astro\s+dev|nuxt\s+dev|webpack\s+serve|rails\s+s(?:erver)?|php\s+artisan\s+serve|nodemon)\b/i,
  /^python3?\s+-m\s+http\.server\b/i,
  /^flask\b.*\brun\b/i,
  /^uvicorn\s/i,
  /^tail\b.*\s-[A-Za-z]*[fF][A-Za-z]*(?:\s|$)/,
  /^watch\s/i,
  /^(?:dotnet\s+watch|cargo\s+watch)\b/i,
  /^(?:tsc|jest|vitest|nodemon|node|webpack|rollup|esbuild|sass|tailwindcss)\b.*\s--watch(?:All)?(?=\s|$)/i, // watch modes; --watch=false and --watchAll=false do not match
  /^tsc\b.*\s-w(?=\s|$)/i,
  /^npm\s+(?:run\s+)?test\b.*\s--\s.*--watch(?:All)?(?=\s|$)/i,
];

// PowerShell-only patterns, matched at the start of a segment.
const WRAPPED_PS = /^(?:start-process|start-job|start-threadjob|saps|sajb)\b/i;
const JOB_START = /\b(?:start-job|start-threadjob|sajb)\b/gi;
const PS_LONG = [
  /^(?:get-content|gc|cat|type)\b.*\s-wait\b/i,
  /^ping(?:\.exe)?\s+(?:.*\s)?-t(?=\s|$)/i,
];
const PS_ASSIGN = /^(?:\[[\w.]+\]\s*)?\$[\w:.]+\s*=\s*/; // `$job = ` / `$null = ` / `[void]$x = `
const PS_EXT = /^([\w.-]+?)\.(?:cmd|exe|bat)(?=\s|$)/i; // npm.cmd -> npm
const NO_TIMEOUT = /^(?!.*\s-timeout\b)/i;

// Start-Sleep takes seconds by default; -Milliseconds / -m / -ms switch the unit.
function psSleepSeconds(text) {
  const m = /(?:^|[{(]\s*)start-sleep\s+(?:-(s|seconds|m|ms|milliseconds)[:\s]\s*)?(\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return 0;
  return Number(m[2]) * (/^m/i.test(m[1] || '') ? 0.001 : 1);
}

// Removes here-string bodies (@' ... '@, @" ... "@) and heredoc bodies (<<WORD ... WORD): their lines are text, not commands.
function dropTextBodies(cmd) {
  return cmd.replace(/\r/g, '')
    .replace(/@(['"])\n(?:[\s\S]*?\n)?\1@/g, "''")
    .replace(/(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _w, rest) => ' ' + rest);
}

// Cuts the `{ ... }` block of every Start-Job out of the text (a job runs in the background) and returns the blocks.
function cutJobBlocks(text) {
  const blocks = [];
  let out = '';
  let pos = 0;
  JOB_START.lastIndex = 0;
  for (let m; (m = JOB_START.exec(text)); ) {
    if (m.index < pos) continue;
    const open = text.indexOf('{', m.index);
    if (open < 0 || /[;|\n]/.test(text.slice(m.index, open))) continue;
    let depth = 0, end = -1;
    for (let i = open, q = ''; i < text.length && end < 0; i++) {
      const ch = text[i];
      if (q) { if (ch === q) q = ''; } else if (ch === "'" || ch === '"') q = ch;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) end = i;
    }
    if (end < 0) continue;
    blocks.push(text.slice(open + 1, end));
    out += text.slice(pos, open) + '{}';
    pos = end + 1;
    JOB_START.lastIndex = pos;
  }
  return { text: out + text.slice(pos), blocks };
}

// The command a Start-Process line launches: `Start-Process npm -ArgumentList 'run','dev' -Wait` -> `npm run dev`.
function launched(seg) {
  return seg.replace(/^\S+/, '').replace(/\s-(?:argumentlist|filepath|wait|nonewwindow|passthru|windowstyle\s+\w+|workingdirectory\s+\S+|verb\s+\S+)(?=\s|$)/gi, ' ').replace(/['",]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isLong(cmd, ps = false) {
  let text = dropTextBodies(cmd);
  let blocks = [];
  if (ps) ({ text, blocks } = cutJobBlocks(text));
  // An unbounded loop (while ($true) / for (;;)) without a way out; quoted text is not code.
  const code = text.replace(/'[^']*'|"(?:[^"`]|`[\s\S])*"/g, "''");
  if (ps && /\b(?:while\s*\(\s*(?:\$true|1)\s*\)|for\s*\(\s*;\s*;\s*\))/i.test(code) && !/\b(?:break|return|exit|throw)\b/i.test(code)) return true;
  // `2>&1` and `&>` are redirections, not the background operator; a segment followed by a single `&` is backgrounded.
  const parts = text.replace(/\d*>&\d*|&>>?/g, ' ').split(/(&&|\|\||[;|&\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i + 1] === '&') continue;
    let body = parts[i].trim();
    if (ps) body = body.replace(PS_ASSIGN, '').replace(PS_EXT, '$1');
    body = body
      .replace(/^(?:[A-Za-z_]\w*=\S*\s+|(?:sudo|exec|command|time|nice)\s+)+/i, '')
      .replace(/^(?:npx|bunx|pnpx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:-\S+\s+)*/i, '');
    if (ps) {
      body = body.replace(PS_EXT, '$1');
      if (WRAPPED_PS.test(body)) {
        // Backgrounded, unless Start-Process waits for a command that does not exit.
        if (/^(?:start-process|saps)\b/i.test(body) && /\s-wait\b/i.test(body) && isLong(launched(body), true)) return true;
        continue;
      }
      // Waiting for a job whose block runs long blocks the tool just like running the block directly.
      const waits = /^(?:wait-job|wjb)\b/i.test(body) || (/^(?:receive-job|rcjb)\b/i.test(body) && /\s-wait\b/i.test(body));
      if (waits && NO_TIMEOUT.test(body) && blocks.some((b) => isLong(b, true))) return true;
      if (PS_LONG.some((re) => re.test(body)) || psSleepSeconds(body) >= 120) return true;
      const wait = /^timeout(?:\.exe)?\s+\/t\s+(-?\d+)/i.exec(body); // Windows timeout.exe waits N s (-1 forever)
      if (wait && (Number(wait[1]) < 0 || Number(wait[1]) >= 120)) return true;
    }
    if (LONG.some((re) => re.test(body))) return true;
    if (/^docker(?:\s+|-)compose\b.*\bup\b/i.test(body) && !/\s(?:-d|--detach|--wait)\b/i.test(body)) return true;
    if (/^(?:ssh|plink)(?:\.exe)?\s/i.test(body) && !/-batch\b|BatchMode\s*=\s*yes/i.test(body)) return true;
    const sleep = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/i.exec(body) || /^start-sleep\s+(?:-s(?:econds)?\s+)?(\d+)()\b/i.exec(body);
    if (sleep && Number(sleep[1]) * ({ m: 60, h: 3600, d: 86400 }[sleep[2].toLowerCase()] || 1) >= 120) return true;
  }
  return false;
}

function evaluate(payload) {
  const input = payload.tool_input || {};
  if (!TOOLS.has(payload.tool_name) || typeof input.command !== 'string' || input.run_in_background === true) return null;
  return isLong(input.command, payload.tool_name === 'PowerShell') ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: MESSAGE } } : null;
}

function selftest() {
  const nudge = [
    'npm run dev', 'yarn dev', 'pnpm dev', 'npm start', 'npx vite --port 3000', 'vite', 'next dev', 'python -m http.server 8000', 'flask --app x run', 'uvicorn app:app --reload',
    'docker compose up', 'docker-compose -f a.yml up --build', 'tail -f app.log', 'tail -n 50 -F app.log', 'watch -n 5 ls', 'ssh host uptime', 'plink -ssh user@host ls',
    'sleep 300', 'sleep 2m', 'Start-Sleep -Seconds 300', 'cd app && npm run dev', 'FOO=1 npm start', 'sudo tail -F /var/log/syslog', 'ls | tee out && npm run dev 2>&1 | tee dev.log',
    'cat <<EOF > a.md\nx\nEOF\nnpm run dev', "git commit -m @'\nmsg\n'@; npm run dev",
  ];
  const quiet = [
    'ls', 'npm run build', 'npm test', 'npm i -D vite', 'pip install uvicorn', 'vite build', 'vite-node script.ts', 'docker compose up -d', 'docker compose up --build -d', 'timeout 300 npm run dev',
    'uvicorn app:app &', 'npm run dev > dev.log 2>&1 &', 'tail -n 20 app.log', 'ssh-keygen -t ed25519', 'plink -batch -ssh u@h uptime', 'ssh -o BatchMode=yes host ls', 'timeout 60 ssh host ls',
    'sleep 5', 'sleep 1m', 'git commit -m "npm run dev"', 'echo "tail -f"', 'grep vite package.json', 'nohup npm run dev &',
    "git commit -m @'\nnpm run dev now loads .env\n'@", "@'\n## Dev\nnpm run dev\n'@ | Set-Content README.md", '@"\nnpm start\n"@ | Set-Content a.md',
    "git commit -m \"$(cat <<'EOF'\nnpm start works again\nEOF\n)\"", 'cat <<EOF > a.md\nnpm run dev\ntail -f x\nEOF', 'cat <<-"END"\n\tuvicorn app:app\n\tEND',
  ];
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const run = (command, extra = {}, tool = 'Bash') => evaluate({ tool_name: tool, tool_input: { command, ...extra } });
  const psNudge = [
    'Start-Sleep -Seconds 300', 'Start-Sleep 600', 'Start-Sleep -s 120', 'Start-Sleep -Milliseconds 300000', 'Start-Sleep -m 180000', 'cd app; Start-Sleep -Seconds 300', 'Write-Host wait; Start-Sleep 200',
    'if ($x) { Start-Sleep -Seconds 300 }', 'while ($true) { Get-Date; Start-Sleep 5 }', 'for (;;) { Invoke-WebRequest http://x }', 'Get-Content app.log -Wait -Tail 10', 'gc app.log -Wait', 'ping -t 10.0.0.1',
    'timeout /t 300', 'timeout /t -1', 'npm run dev', 'npm.cmd start', 'npx vite', 'docker compose up', 'dotnet watch run', 'tsc --watch', 'tsc -w', 'jest --watch', 'node --watch server.js', 'npm test -- --watch',
    'cd C:\\proj; npm run dev', '$env:PORT=3000; npm run dev', 'python -m http.server 8000', 'uvicorn app:app --reload', 'plink -ssh user@host ls',
    'npx.cmd vite', 'npx.cmd next dev', 'pnpm.cmd exec vite', 'npx.exe -y vite', '$x = npm run dev',
    "Start-Process npm -ArgumentList 'run','dev' -Wait -NoNewWindow", 'Start-Process -FilePath npm -ArgumentList "run dev" -Wait', 'Start-Job { npm run dev } | Receive-Job -Wait', 'Start-Job { npm run dev } | Wait-Job',
    '$j = Start-Job { npm run dev }; Wait-Job $j', 'Start-Job -ScriptBlock {\n  npm run dev\n} | Wait-Job', 'Start-Job { npm run dev }; while ($true) { Get-Date }', "git commit -m @'\nmsg\n'@; npm run dev",
  ];
  const psQuiet = [
    'Start-Sleep -Seconds 5', 'Start-Sleep 60', 'Start-Sleep -Milliseconds 5000', 'Start-Sleep -m 90000', 'Get-Content app.log -Tail 20', 'ping -n 2 10.0.0.1', 'timeout /t 5', 'while ($true) { if (Test-Path x) { break }; Start-Sleep 2 }',
    'while (-not (Test-Path x)) { Start-Sleep -Seconds 5 }', 'Start-Process npm -ArgumentList "run dev"', 'Start-Job { npm run dev }', 'Start-Job -ScriptBlock { Start-Sleep 600 }', 'npm run build', 'npm test', 'tsc --noEmit', 'jest --watchAll=false',
    'npm test -- --watch=false', 'Write-Host "npm run dev"', 'Get-ChildItem', 'git commit -m "Start-Sleep 600"', 'docker compose up -d', 'plink -batch -ssh user@host ls', 'dotnet build', 'node script.js',
    '$job = Start-Job { Start-Sleep 600 }', '$job = Start-Job -ScriptBlock { while ($true) { Get-Date; Start-Sleep 5 } }', 'Start-Job -ScriptBlock {\n  npm run dev\n}', '$null = Start-Job { npm run dev }', '[void](Start-Job { npm run dev })',
    '$p = Start-Process npm -ArgumentList "run dev" -PassThru', 'saps npm -ArgumentList "run dev"', 'Start-Job { npm run dev } | Out-Null', "Write-Host 'while ($true) loop removed'", 'Write-Host "for (;;) is bad"',
    'Start-Process msiexec -ArgumentList "/i a.msi" -Wait', 'Start-Process npm -ArgumentList "run build" -Wait -NoNewWindow', 'Start-Job { Start-Sleep 5 } | Wait-Job', 'Start-Job { npm run dev } | Wait-Job -Timeout 5',
    'Start-Job { npm run dev } | Receive-Job -Timeout 5', 'Start-Job { npm run dev } | Receive-Job', 'Wait-Job $j', 'npx.cmd tsc --noEmit', 'pnpm.cmd exec tsc', 'npm.cmd run build',
    "git commit -m @'\nFix: while ($true) in npm run dev\nStart-Sleep 600\n'@", "@'\nStart-Job { x }\nnpm run dev\n'@ | Set-Content a.ps1",
  ];
  for (const tool of ['Bash', 'PowerShell']) {
    for (const c of nudge) {
      const r = run(c, {}, tool);
      check(`${tool} nudge: ${JSON.stringify(c)}`, !!r && r.hookSpecificOutput.additionalContext === MESSAGE && !('permissionDecision' in r.hookSpecificOutput), 'expected a nudge without a permission decision');
    }
    for (const c of quiet) check(`${tool} quiet: ${JSON.stringify(c)}`, run(c, {}, tool) === null, 'expected silence');
    check(`${tool} quiet: run_in_background true`, run('npm run dev', { run_in_background: true }, tool) === null, 'expected silence');
  }
  for (const c of psNudge) check(`PowerShell nudge: ${JSON.stringify(c)}`, !!run(c, {}, 'PowerShell'), 'expected a nudge');
  for (const c of psQuiet) check(`PowerShell quiet: ${JSON.stringify(c)}`, run(c, {}, 'PowerShell') === null, 'expected silence');
  check('quiet: other tool', run('npm run dev', {}, 'Read') === null, 'expected silence');
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
  const out = evaluate(payload);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
