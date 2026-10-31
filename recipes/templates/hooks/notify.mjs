// Kaizen hook: notify
// What it does: tells you when Claude needs you (permission prompt, idle prompt) or has finished a long turn,
//   via an OS notification (Windows balloon tip, macOS osascript, Linux notify-send) and/or a Telegram message.
//   Stop notifications are sent only if the turn lasted at least minTurnSeconds (time since the last human prompt
//   in the transcript; if that cannot be determined it notifies). Failures are ignored.
// Registered for: Notification (matcher "permission_prompt|idle_prompt") and Stop, both with async: true.
// Parameters (substituted by Kaizen at install time): channel (os|telegram|both), telegramBotToken,
//   telegramChatId, minTurnSeconds. A telegram channel without token and chat id falls back to the OS notification.
// Remove: delete the Notification and Stop entries that run this file from settings.json, or run `kaizen undo`.
// Self-test: node notify.mjs --selftest   (dry run: builds the commands and payloads, sends nothing)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const CHANNEL_RAW = '{{channel}}';
const TOKEN_RAW = '{{telegramBotToken}}';
const CHAT_RAW = '{{telegramChatId}}';
const MIN_RAW = '{{minTurnSeconds}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const CFG = {
  channel: ['os', 'telegram', 'both'].includes(String(CHANNEL_RAW).trim()) ? CHANNEL_RAW.trim() : 'os',
  token: unset(TOKEN_RAW) ? '' : TOKEN_RAW.trim(),
  chat: unset(CHAT_RAW) ? '' : CHAT_RAW.trim(),
  minTurn: unset(MIN_RAW) || Number.isNaN(Number(MIN_RAW)) ? 45 : Math.max(0, Number(MIN_RAW)),
};

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try { if (fs.statSync(path.join(dir, name)).isFile()) return path.join(dir, name); } catch { /* keep looking */ }
  }
  return null;
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

// Seconds since the last human prompt in the transcript, or null when unknown.
function turnSeconds(transcriptPath, now) {
  if (typeof transcriptPath !== 'string') return null;
  let ts = null;
  for (const line of tailLines(transcriptPath, 3 * 1024 * 1024)) {
    if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) continue;
    try {
      const o = JSON.parse(line);
      const t = isHuman(o) ? Date.parse(o.timestamp) : NaN;
      if (!Number.isNaN(t)) ts = t;
    } catch { /* skip bad line */ }
  }
  return ts === null ? null : (now - ts) / 1000;
}

// The platform-specific command that shows the notification (null when no tool is available).
function osCommand(platform, text, which = onPath) {
  const t = text.replace(/[\r\n\t]+/g, ' ').replace(/^-+\s*/, '').slice(0, 220);
  if (platform === 'win32') {
    const q = t.replace(/"/g, "'").replace(/['\u2018\u2019\u201A\u201B]/g, "''");
    const script = `try { Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle = 'Claude Code'; $n.BalloonTipText = '${q}'; $n.Visible = $true; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 6; $n.Dispose() } catch { msg * '${q}' }`;
    return { bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  if (platform === 'darwin') {
    return { bin: 'osascript', args: ['-e', `display notification "${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with title "Claude Code"`] };
  }
  return which('notify-send') ? { bin: 'notify-send', args: ['Claude Code', t] } : null;
}

// Turn a hook payload into { text, os, tg } (null = stay quiet). Pure: nothing is sent here.
function plan(p, cfg = CFG, platform = process.platform, now = Date.now()) {
  if (p.hook_event_name !== 'Stop' && p.hook_event_name !== 'Notification') return null; // empty or foreign input: stay quiet
  let text;
  if (p.hook_event_name === 'Stop') {
    const secs = turnSeconds(p.transcript_path, now);
    if (secs !== null && secs < cfg.minTurn) return null;
    const last = String(p.last_assistant_message || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    text = `Claude finished: ${last || 'turn complete'}`;
  } else {
    const fallback = p.notification_type === 'idle_prompt' ? 'Claude is waiting for input' : 'Claude needs permission';
    text = String(p.message || p.title || fallback).replace(/\s+/g, ' ').trim();
  }
  const project = String(p.cwd || '').split(/[\\/]/).filter(Boolean).pop();
  if (project) text += ` [${project}]`;
  const tg = cfg.channel !== 'os' && /^\d+:[\w-]+$/.test(cfg.token) && cfg.chat;
  return {
    text,
    os: cfg.channel !== 'telegram' || !tg ? osCommand(platform, text) : null,
    tg: tg ? { host: 'api.telegram.org', path: `/bot${cfg.token}/sendMessage`, body: JSON.stringify({ chat_id: cfg.chat, text: `Claude Code: ${text}` }) } : null,
  };
}

const runOs = (cmd) => new Promise((resolve) => {
  if (!cmd) return resolve();
  try {
    const child = spawn(cmd.bin, cmd.args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 12000);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on('error', done);
    child.on('exit', done);
  } catch { resolve(); }
});

const runTelegram = (t) => new Promise((resolve) => {
  if (!t) return resolve();
  try {
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t.body) };
    const req = https.request({ host: t.host, path: t.path, method: 'POST', headers, timeout: 5000 }, (res) => { res.resume(); res.on('end', resolve); res.on('error', resolve); });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(t.body);
  } catch { resolve(); }
});

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-notify-'));
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const both = { channel: 'both', token: '123456:ABC-def_ghi', chat: '-100123', minTurn: 45 };
  const now = Date.parse('2026-01-01T12:00:00Z');
  const transcript = (secondsAgo) => {
    const f = path.join(tmp, `t${secondsAgo}.jsonl`);
    const prompt = { type: 'user', timestamp: new Date(now - secondsAgo * 1000).toISOString(), message: { role: 'user', content: 'do the thing' } };
    fs.writeFileSync(f, JSON.stringify(prompt) + '\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n');
    return f;
  };
  try {
    const n = plan({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', cwd: 'C:\\work\\demo app' }, both, 'win32', now);
    check('notification text', n && n.text === 'Claude needs your permission to use Bash [demo app]', JSON.stringify(n && n.text));
    check('windows command shape', n.os.bin === 'powershell' && ['-NoProfile', '-NonInteractive', '-Command'].every((a, i) => n.os.args[i] === a) && n.os.args[3].includes('ShowBalloonTip(5000)') && n.os.args[3].includes('msg *'), 'bad powershell command');
    check('telegram payload', n.tg.host === 'api.telegram.org' && n.tg.path === '/bot123456:ABC-def_ghi/sendMessage' && JSON.parse(n.tg.body).chat_id === '-100123', JSON.stringify(n.tg));
    const w = osCommand('win32', 'it\'s "quoted" \u2019x');
    check('windows quoting', !w.args[3].includes('"') && w.args[3].includes("'it''s ''quoted'' ''x'"), w.args[3].slice(-120));
    const m = osCommand('darwin', 'say "hi" \\ there');
    check('macos command', m.bin === 'osascript' && m.args[0] === '-e' && m.args[1] === 'display notification "say \\"hi\\" \\\\ there" with title "Claude Code"', m.args[1]);
    const l = osCommand('linux', '-x', (b) => `/usr/bin/${b}`);
    check('linux command', l.bin === 'notify-send' && l.args.join('|') === 'Claude Code|x', JSON.stringify(l));
    check('linux without notify-send -> null', osCommand('linux', 'x', () => null) === null, 'expected null');
    const idle = plan({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, { ...both, channel: 'os' }, 'linux', now);
    check('channel os: default text, no telegram', idle.text === 'Claude is waiting for input' && idle.tg === null, JSON.stringify(idle));
    const note = { hook_event_name: 'Notification', message: 'x' };
    check('channel telegram: no OS command', plan(note, { ...both, channel: 'telegram' }, 'win32', now).os === null, 'expected no os command');
    check('telegram without token falls back to OS', plan(note, { channel: 'telegram', token: '', chat: '', minTurn: 45 }, 'win32', now).os !== null, 'expected os command');
    check('empty or foreign input -> quiet', plan({}, both, 'win32', now) === null && plan({ hook_event_name: 'SessionStart' }, both, 'win32', now) === null, 'expected null');
    const stop = (secondsAgo) => plan({ hook_event_name: 'Stop', last_assistant_message: 'All done.\nTests pass.', transcript_path: secondsAgo === null ? undefined : transcript(secondsAgo), cwd: '/w/demo' }, both, 'win32', now);
    check('short turn -> quiet', stop(5) === null, 'expected null');
    const noisy = path.join(tmp, 'noisy.jsonl'); // a background-task notice 5 s ago must not restart the turn clock
    const line = (secondsAgo, content) => JSON.stringify({ type: 'user', timestamp: new Date(now - secondsAgo * 1000).toISOString(), message: { role: 'user', content } });
    fs.writeFileSync(noisy, line(120, 'do the thing') + '\n' + line(5, '<task-notification>job done</task-notification>') + '\n');
    check('task notifications do not reset the clock', plan({ hook_event_name: 'Stop', transcript_path: noisy }, both, 'win32', now) !== null, 'expected a notification');
    const long = stop(120);
    check('long turn -> notify', long && long.text === 'Claude finished: All done. Tests pass. [demo]', JSON.stringify(long && long.text));
    check('unknown turn length -> notify', stop(null) !== null, 'expected a notification');
    check('missing transcript file -> notify', plan({ hook_event_name: 'Stop', transcript_path: path.join(tmp, 'nope.jsonl') }, both, 'win32', now) !== null, 'expected a notification');
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
  const p = plan(payload);
  if (p) await Promise.all([runOs(p.os), runTelegram(p.tg)]);
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
