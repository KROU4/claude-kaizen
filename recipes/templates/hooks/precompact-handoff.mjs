// Kaizen hook: precompact-handoff
// What it does: right before a compaction it saves a short markdown handoff of what was going on: the last human
//   prompts, recently edited files, recent shell commands and the last assistant message. The file goes to
//   ~/.claude/kaizen/handoffs/<session_id>.md (CLAUDE_CONFIG_DIR is respected; files older than 7 days are pruned).
//   session-context.mjs injects it into the next context and deletes it. Obvious secrets are scrubbed. Prints nothing.
// Registered for: PreCompact, matcher "auto|manual".
// Parameters (substituted by Kaizen at install time): maxPrompts (how many recent prompts to keep, default 5).
// Remove: delete the PreCompact entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node precompact-handoff.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RAW = '{{maxPrompts}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const MAX_PROMPTS = Math.min(20, Math.max(1, Math.floor(Number(unset(MAX_RAW) ? 5 : MAX_RAW)) || 5));
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const SCRUBS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, '[redacted]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]'],
  [/(https?:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1[redacted]@'],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*[=:]\s*)["']?[^\s"']{4,}/gi, '$1[redacted]'],
];
const scrub = (s) => SCRUBS.reduce((t, [re, to]) => t.replace(re, to), String(s));
const clip = (s, n) => {
  const one = scrub(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 3) + '...' : one;
};

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

function isHuman(o) {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary) return false;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c.trim() !== '' && !c.trimStart().startsWith('<local-command-stdout>');
  return Array.isArray(c) && c.some((b) => b && b.type === 'text') && !c.some((b) => b && b.type === 'tool_result');
}

function collect(lines, maxPrompts) {
  const prompts = [];
  const edited = new Map();
  const cmds = new Map();
  let lastText = '';
  const touch = (map, key) => { map.delete(key); map.set(key, true); };
  for (const line of lines) {
    const user = line.includes('"type":"user"');
    if (!user && !line.includes('"type":"assistant"')) continue;
    if (user && line.includes('"type":"tool_result"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.isSidechain) continue;
    if (isHuman(o)) {
      const c = o.message.content;
      prompts.push(typeof c === 'string' ? c : c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' '));
      continue;
    }
    const blocks = o.type === 'assistant' && o.message && o.message.content;
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) lastText = b.text;
      else if (b.type === 'tool_use' && b.input) {
        const f = b.input.file_path || b.input.notebook_path;
        if (EDIT_TOOLS.has(b.name) && f) touch(edited, String(f));
        else if ((b.name === 'Bash' || b.name === 'PowerShell') && b.input.command) touch(cmds, clip(b.input.command, 120));
      }
    }
  }
  return { prompts: prompts.slice(-maxPrompts), edited: [...edited.keys()].slice(-30), cmds: [...cmds.keys()].slice(-5), lastText };
}

function render(payload, d, now) {
  const out = [`# Kaizen handoff: saved before a ${payload.trigger === 'manual' ? 'manual' : 'automatic'} compaction (${now.toISOString()})`];
  if (payload.cwd) out.push(`Project: ${path.basename(String(payload.cwd))}`);
  if (d.prompts.length) out.push('', '## Last user prompts (oldest first)', ...d.prompts.map((p, i) => `${i + 1}. ${clip(p, 200)}`));
  if (d.lastText) out.push('', '## Last assistant message', clip(d.lastText, 400));
  if (d.cmds.length) out.push('', '## Recent commands', ...d.cmds.map((c) => `- \`${c}\``));
  if (d.edited.length) out.push('', '## Recently edited files (most recent last)', ...d.edited.map((f) => `- ${f}`));
  return out.join('\n') + '\n';
}

function save(payload, o = {}) {
  const sid = String(payload.session_id || '').replace(/[^\w-]/g, '');
  if (!sid || typeof payload.transcript_path !== 'string') return null;
  const data = collect(tailLines(payload.transcript_path, 4 * 1024 * 1024), o.maxPrompts || MAX_PROMPTS);
  if (!data.prompts.length && !data.edited.length && !data.cmds.length && !data.lastText) return null;
  const dir = path.join(o.configDir || configDir(), 'kaizen', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.md`);
  fs.writeFileSync(file, render(payload, data, new Date()));
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try { if (name.endsWith('.md') && Date.now() - fs.statSync(f).mtimeMs > 7 * 864e5) fs.unlinkSync(f); } catch { /* ignore */ }
  }
  return file;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-handoff-'));
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const asst = (...blocks) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
  const use = (name, input) => ({ type: 'tool_use', id: 't', name, input });
  const lines = [];
  for (let i = 1; i <= 7; i++) lines.push(user(i === 7 ? 'deploy with password=hunter22 and key sk-ant-api03-abcdefghijklmnop1234' : `prompt number ${i}`));
  for (let i = 1; i <= 35; i++) lines.push(asst(use('Edit', { file_path: `/p/src/f${i}.ts` })));
  lines.push(asst(use('Edit', { file_path: '/p/src/f1.ts' })));
  lines.push(JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [use('Write', { file_path: '/p/side.ts' })] } }));
  for (const c of ['npm test', 'git status', 'ls', 'npm test', 'pwd', 'echo a', 'echo b']) lines.push(asst(use('Bash', { command: c })));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'prompt number 99' }] } }));
  lines.push(asst({ type: 'text', text: 'x'.repeat(600) }));
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  try {
    const old = path.join(tmp, 'kaizen', 'handoffs', 'old.md');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'stale');
    fs.utimesSync(old, new Date(Date.now() - 10 * 864e5), new Date(Date.now() - 10 * 864e5));
    const file = save({ session_id: 'sess-1', transcript_path: transcript, trigger: 'auto', cwd: '/w/demo' }, { configDir: tmp, maxPrompts: 5 });
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    check('handoff written to <config>/kaizen/handoffs/<session>.md', file === path.join(tmp, 'kaizen', 'handoffs', 'sess-1.md'), String(file));
    const prompts = text.split('## Last user prompts')[1]?.split('\n\n')[0].split('\n').filter((l) => /^\d+\./.test(l)) || [];
    check('keeps the last 5 prompts', prompts.length === 5 && prompts[0].startsWith('1. prompt number 3'), JSON.stringify(prompts));
    check('secrets are scrubbed', !/hunter22|sk-ant/.test(text) && text.includes('password=[redacted]'), text.slice(0, 400));
    const files = text.split('## Recently edited files')[1]?.split('\n').filter((l) => l.startsWith('- ')) || [];
    check('last 30 distinct edited files, newest last', files.length === 30 && files[29] === '- /p/src/f1.ts' && !text.includes('side.ts'), `${files.length} ${files[29]}`);
    const cmds = text.split('## Recent commands')[1]?.split('\n\n')[0].split('\n').filter((l) => l.startsWith('- ')) || [];
    check('last 5 distinct commands', cmds.join('|') === ['ls', 'npm test', 'pwd', 'echo a', 'echo b'].map((c) => `- \`${c}\``).join('|'), JSON.stringify(cmds));
    check('last assistant text clipped to 400', /\n## Last assistant message\nx{397}\.\.\.\n/.test(text), 'wrong clip');
    check('old handoffs are pruned', !fs.existsSync(old), 'stale file still there');
    check('missing transcript -> nothing written', save({ session_id: 'sess-2', transcript_path: path.join(tmp, 'nope.jsonl') }, { configDir: tmp }) === null && !fs.existsSync(path.join(tmp, 'kaizen', 'handoffs', 'sess-2.md')), 'expected null');
    check('no session id -> nothing written', save({ transcript_path: transcript }, { configDir: tmp }) === null, 'expected null');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  save(payload);
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
