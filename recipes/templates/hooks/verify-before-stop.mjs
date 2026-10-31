// Kaizen hook: verify-before-stop
// What it does: when Claude is about to finish a turn, reads the tail of the transcript. If source files were
//   edited since the last human prompt but no test, lint or type-check command ran, it blocks the stop once so
//   Claude runs the checks (mode block), or only shows a reminder (mode remind). It never blocks twice: a Stop
//   that already followed a block (stop_hook_active) passes. Doc/config-only edits (md, txt, json, yaml) are ignored.
// Registered for: Stop (no matcher).
// Parameters (substituted by Kaizen at install time): mode (block|remind), testPattern (regex source matched,
//   case-insensitively, against Bash/PowerShell commands; invalid or empty falls back to a built-in list).
// Remove: delete the Stop entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node verify-before-stop.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE_RAW = '{{mode}}';
const PATTERN_RAW = '{{testPattern}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const MODE = !unset(MODE_RAW) && MODE_RAW.trim() === 'remind' ? 'remind' : 'block';
const DEFAULT_RE = /\b(?:pytest|unittest|tox|nox|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check)|vitest|jest|mocha|playwright\s+test|go\s+(?:test|vet)|cargo\s+(?:test|clippy|check)|dotnet\s+test|mvn\s+(?:\S+\s+)*(?:test|verify)|gradlew?\s+(?:test|check)|phpunit|rspec|mix\s+test|make\s+(?:test|check|lint)|node\s+--test|ruff|eslint|tsc|mypy|pyright|flake8|pylint|golangci-lint|biome)\b/i;
const CODE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cpp|h|vue|svelte|sql|sh|ps1)$/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function compile(src) {
  if (unset(src)) return DEFAULT_RE;
  try { return new RegExp(src, 'i'); } catch { return DEFAULT_RE; }
}

// Last `maxBytes` of a file as complete lines (the first, possibly cut, line is dropped).
function tailLines(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    for (let n = 1; n > 0 && off < buf.length; off += n) n = fs.readSync(fd, buf, off, buf.length - off, start + off);
    const lines = buf.subarray(0, off).toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Text Claude Code injects into user turns (background-task notices, reminders, command output, interrupts).
const MACHINE = /^\s*(?:<(?:system-reminder|task-notification|local-command-stdout|local-command-caveat|side-sessions-event|ci-monitor-event)\b|\[SYSTEM NOTIFICATION|\[Request interrupted|This session is being continued from a previous conversation)/;

// A real human prompt: a user line with at least one non-machine text and no tool_result; never meta/summary/sidechain.
function isHuman(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary) return false;
  const c = o.message && o.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
  return texts.some((t) => t.trim() !== '' && !MACHINE.test(t));
}

// Walk the transcript once, resetting at every human prompt, so only the current turn is counted.
function scan(lines, testRe) {
  let edited = new Set();
  let ran = false;
  for (const line of lines) {
    const user = line.includes('"type":"user"');
    if (!user && !(line.includes('"type":"assistant"') && line.includes('"type":"tool_use"'))) continue;
    if (user && line.includes('"type":"tool_result"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain) continue;
    if (isHuman(o)) { edited = new Set(); ran = false; continue; }
    const blocks = o.type === 'assistant' && o.message && o.message.content;
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      if (EDIT_TOOLS.has(b.name)) { const f = b.input.file_path || b.input.notebook_path; if (f) edited.add(String(f)); }
      else if ((b.name === 'Bash' || b.name === 'PowerShell') && testRe.test(String(b.input.command || ''))) ran = true;
    }
  }
  return { edited: [...edited], ran };
}

function evaluate(payload, mode = MODE, testRe = compile(PATTERN_RAW)) {
  if (payload.stop_hook_active === true || typeof payload.transcript_path !== 'string') return null;
  const { edited, ran } = scan(tailLines(payload.transcript_path, 3 * 1024 * 1024), testRe);
  const code = edited.filter((f) => CODE_EXT.test(f));
  if (!code.length || ran) return null;
  if (mode === 'remind') return { systemMessage: `Kaizen: ${code.length} file(s) changed without a test/lint run this turn.` };
  const names = [...new Set(code.map((f) => f.split(/[\\/]/).pop()))].slice(0, 3).join(', ');
  return { decision: 'block', reason: `Kaizen: ${code.length} source file(s) changed this turn (${names}) but no test, lint or type-check command ran. Run the project's checks now, or state explicitly why they are not needed, then finish.` };
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-vbs-'));
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const ev = (payload, mode = 'block', re = DEFAULT_RE) => evaluate(payload, mode, re); // independent of the installed parameters
  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const asst = (...blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
  const use = (name, input) => ({ type: 'tool_use', id: 't1', name, input });
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  const edit = (f) => asst(use('Edit', { file_path: f }));
  const bash = (c) => asst(use('Bash', { command: c }));
  let n = 0;
  const transcript = (...lines) => { const f = path.join(tmp, `t${n++}.jsonl`); fs.writeFileSync(f, lines.join('\n') + '\n'); return { transcript_path: f }; };
  try {
    const r1 = ev(transcript(user('fix it'), edit('C:\\p\\src\\a.ts'), result, edit('/p/b.py')));
    check('code edited, no checks -> block', r1 && r1.decision === 'block' && r1.reason.includes('2 source file(s)') && r1.reason.includes('a.ts, b.py'), JSON.stringify(r1));
    check('tests ran -> silent', ev(transcript(user('fix'), edit('/p/a.ts'), result, bash('cd p && npm test -- --run'))) === null, 'expected silence');
    check('only docs/config edited -> silent', ev(transcript(user('docs'), edit('/p/README.md'), edit('/p/package.json'), edit('/p/x.yaml'))) === null, 'expected silence');
    check('stop_hook_active -> silent', ev({ ...transcript(user('fix'), edit('/p/a.ts')), stop_hook_active: true }) === null, 'expected silence');
    check('new prompt resets the turn', ev(transcript(user('one'), edit('/p/a.ts'), user('what is this?'), asst({ type: 'text', text: 'an answer' }))) === null, 'expected silence');
    check('earlier test run does not cover a new edit', ev(transcript(user('one'), bash('pytest -q'), user('two'), edit('/p/a.py')))?.decision === 'block', 'expected block');
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [use('Edit', { file_path: '/p/a.ts' })] } });
    check('sidechain edits ignored', ev(transcript(user('go'), side)) === null, 'expected silence');
    check('remind mode', ev(transcript(user('fix'), edit('/p/a.go')), 'remind')?.systemMessage?.includes('1 file(s)'), 'expected systemMessage');
    check('custom testPattern', ev(transcript(user('x'), edit('/p/a.rs'), bash('make verify')), 'block', compile('make verify')) === null, 'expected silence');
    check('invalid testPattern falls back', compile('([').test('pytest'), 'expected default pattern');
    check('missing transcript -> silent', ev({ transcript_path: path.join(tmp, 'nope.jsonl') }) === null && ev({}) === null, 'expected silence');
    check('garbage lines tolerated', ev(transcript('not json', '{"type":"user"', user('x'), edit('/p/a.ts')))?.decision === 'block', 'expected block');
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
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    if (v && typeof v === 'object') payload = v;
  } catch { /* empty or invalid input: treat as {} */ }
  const out = evaluate(payload);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
