// Kaizen hook: long-command-nudge
// What it does: when Claude starts a Bash or PowerShell command that usually never exits or runs very long without a
//   guard (npm/yarn/pnpm dev|start, vite, next dev, python -m http.server, flask run, uvicorn, docker compose up
//   without -d, tail -f, watch, --watch modes, ssh/plink without -batch or BatchMode, sleep or Start-Sleep of 120 s
//   or more) it adds one line of context suggesting run_in_background or a timeout. PowerShell adds Get-Content -Wait,
//   ping -t, `timeout /t N`, while ($true) loops without break and Start-Sleep inside script blocks. It only adds
//   context: no permissionDecision is returned, so the normal permission flow stays exactly as it was (an "allow"
//   would skip the permission prompt, which a nudge must not do).
//   Silent when run_in_background is true, when the command is already wrapped (timeout, nohup, trailing &,
//   Start-Process, Start-Job) or when the pattern is not at the start of a command (pip install uvicorn,
//   grep vite package.json, git commit -m "...").
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
const PS_LONG = [
  /^(?:get-content|gc|cat|type)\b.*\s-wait\b/i,
  /^ping(?:\.exe)?\s+(?:.*\s)?-t(?=\s|$)/i,
];

// Start-Sleep takes seconds by default; -Milliseconds / -m / -ms switch the unit.
function psSleepSeconds(text) {
  const m = /(?:^|[{(]\s*)start-sleep\s+(?:-(s|seconds|m|ms|milliseconds)[:\s]\s*)?(\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return 0;
  return Number(m[2]) * (/^m/i.test(m[1] || '') ? 0.001 : 1);
}

function isLong(cmd, ps = false) {
  // An unbounded loop (while ($true) / for (;;)) without a way out, unless the whole command runs as a job.
  if (ps && !WRAPPED_PS.test(cmd.trim()) && /\b(?:while\s*\(\s*(?:\$true|1)\s*\)|for\s*\(\s*;\s*;\s*\))/i.test(cmd) && !/\b(?:break|return|exit|throw)\b/i.test(cmd)) return true;
  // `2>&1` and `&>` are redirections, not the background operator; a segment followed by a single `&` is backgrounded.
  const parts = cmd.replace(/\r/g, '').replace(/\d*>&\d*|&>>?/g, ' ').split(/(&&|\|\||[;|&\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i + 1] === '&') continue;
    let body = parts[i].trim()
      .replace(/^(?:[A-Za-z_]\w*=\S*\s+|(?:sudo|exec|command|time|nice)\s+)+/i, '')
      .replace(/^(?:npx|bunx|pnpx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:-\S+\s+)*/i, '');
    if (ps) {
      body = body.replace(/^([\w.-]+?)\.(?:cmd|exe|bat)(?=\s|$)/i, '$1'); // npm.cmd -> npm
      if (WRAPPED_PS.test(body)) continue;
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
  ];
  const quiet = [
    'ls', 'npm run build', 'npm test', 'npm i -D vite', 'pip install uvicorn', 'vite build', 'vite-node script.ts', 'docker compose up -d', 'docker compose up --build -d', 'timeout 300 npm run dev',
    'uvicorn app:app &', 'npm run dev > dev.log 2>&1 &', 'tail -n 20 app.log', 'ssh-keygen -t ed25519', 'plink -batch -ssh u@h uptime', 'ssh -o BatchMode=yes host ls', 'timeout 60 ssh host ls',
    'sleep 5', 'sleep 1m', 'git commit -m "npm run dev"', 'echo "tail -f"', 'grep vite package.json', 'nohup npm run dev &',
  ];
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const run = (command, extra = {}, tool = 'Bash') => evaluate({ tool_name: tool, tool_input: { command, ...extra } });
  const psNudge = [
    'Start-Sleep -Seconds 300', 'Start-Sleep 600', 'Start-Sleep -s 120', 'Start-Sleep -Milliseconds 300000', 'Start-Sleep -m 180000', 'cd app; Start-Sleep -Seconds 300', 'Write-Host wait; Start-Sleep 200',
    'if ($x) { Start-Sleep -Seconds 300 }', 'while ($true) { Get-Date; Start-Sleep 5 }', 'for (;;) { Invoke-WebRequest http://x }', 'Get-Content app.log -Wait -Tail 10', 'gc app.log -Wait', 'ping -t 10.0.0.1',
    'timeout /t 300', 'timeout /t -1', 'npm run dev', 'npm.cmd start', 'npx vite', 'docker compose up', 'dotnet watch run', 'tsc --watch', 'tsc -w', 'jest --watch', 'node --watch server.js', 'npm test -- --watch',
    'cd C:\\proj; npm run dev', '$env:PORT=3000; npm run dev', 'python -m http.server 8000', 'uvicorn app:app --reload', 'plink -ssh user@host ls',
  ];
  const psQuiet = [
    'Start-Sleep -Seconds 5', 'Start-Sleep 60', 'Start-Sleep -Milliseconds 5000', 'Start-Sleep -m 90000', 'Get-Content app.log -Tail 20', 'ping -n 2 10.0.0.1', 'timeout /t 5', 'while ($true) { if (Test-Path x) { break }; Start-Sleep 2 }',
    'while (-not (Test-Path x)) { Start-Sleep -Seconds 5 }', 'Start-Process npm -ArgumentList "run dev"', 'Start-Job { npm run dev }', 'Start-Job -ScriptBlock { Start-Sleep 600 }', 'npm run build', 'npm test', 'tsc --noEmit', 'jest --watchAll=false',
    'npm test -- --watch=false', 'Write-Host "npm run dev"', 'Get-ChildItem', 'git commit -m "Start-Sleep 600"', 'docker compose up -d', 'plink -batch -ssh user@host ls', 'dotnet build', 'node script.js',
  ];
  for (const tool of ['Bash', 'PowerShell']) {
    for (const c of nudge) {
      const r = run(c, {}, tool);
      check(`${tool} nudge: ${c}`, !!r && r.hookSpecificOutput.additionalContext === MESSAGE && !('permissionDecision' in r.hookSpecificOutput), 'expected a nudge without a permission decision');
    }
    for (const c of quiet) check(`${tool} quiet: ${c}`, run(c, {}, tool) === null, 'expected silence');
    check(`${tool} quiet: run_in_background true`, run('npm run dev', { run_in_background: true }, tool) === null, 'expected silence');
  }
  for (const c of psNudge) check(`PowerShell nudge: ${c}`, !!run(c, {}, 'PowerShell'), 'expected a nudge');
  for (const c of psQuiet) check(`PowerShell quiet: ${c}`, run(c, {}, 'PowerShell') === null, 'expected silence');
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
