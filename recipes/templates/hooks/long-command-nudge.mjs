// Kaizen hook: long-command-nudge
// What it does: when Claude starts a Bash command that usually never exits or runs very long without a guard
//   (npm/yarn/pnpm dev|start, vite, next dev, python -m http.server, flask run, uvicorn, docker compose up without
//   -d, tail -f, watch, ssh/plink without -batch or BatchMode, sleep of 120 s or more) it adds one line of context
//   suggesting run_in_background or a timeout. It only adds context: no permissionDecision is returned, so the normal
//   permission flow stays exactly as it was (an "allow" would skip the permission prompt, which a nudge must not do).
//   Silent when run_in_background is true, when the command is already wrapped (timeout, nohup, trailing &) or when
//   the pattern is not at the start of a command (pip install uvicorn, grep vite package.json, git commit -m "...").
// Registered for: PreToolUse, matcher "Bash".
// Parameters: none.
// Remove: delete the PreToolUse entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node long-command-nudge.mjs --selftest

const MESSAGE = 'Kaizen: this command may run for a long time or never exit. Prefer run_in_background: true or wrap it with a timeout (e.g. `timeout 300 …`).';

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
];

function isLong(cmd) {
  // `2>&1` and `&>` are redirections, not the background operator; a segment followed by a single `&` is backgrounded.
  const parts = cmd.replace(/\r/g, '').replace(/\d*>&\d*|&>>?/g, ' ').split(/(&&|\|\||[;|&\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i + 1] === '&') continue;
    const body = parts[i].trim()
      .replace(/^(?:[A-Za-z_]\w*=\S*\s+|(?:sudo|exec|command|time|nice)\s+)+/i, '')
      .replace(/^(?:npx|bunx|pnpx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|pipenv\s+run)\s+(?:-\S+\s+)*/i, '');
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
  if (payload.tool_name !== 'Bash' || typeof input.command !== 'string' || input.run_in_background === true) return null;
  return isLong(input.command) ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: MESSAGE } } : null;
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
  for (const c of nudge) {
    const r = run(c);
    check(`nudge: ${c}`, !!r && r.hookSpecificOutput.additionalContext === MESSAGE && !('permissionDecision' in r.hookSpecificOutput), 'expected a nudge without a permission decision');
  }
  for (const c of quiet) check(`quiet: ${c}`, run(c) === null, 'expected silence');
  check('quiet: run_in_background true', run('npm run dev', { run_in_background: true }) === null, 'expected silence');
  check('quiet: other tool', run('npm run dev', {}, 'Read') === null, 'expected silence');
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) { process.exitCode = selftest(); return; }
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
