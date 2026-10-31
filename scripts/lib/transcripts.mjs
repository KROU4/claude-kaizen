// Transcript scanner: turns ~/.claude/projects/**/*.jsonl into per-session
// summaries without ever keeping a whole file in memory. Summaries are cached
// per file (size + mtime) so repeated measurements are cheap.
//
// Privacy: summaries keep counts, histograms and a few short, secret-scrubbed
// snippets of user prompts (needed to spot repeated instructions). No tool
// output and no assistant text is retained.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './jsonl.mjs';
import { redact, snippet } from './redact.mjs';
import { ensureDir, readJsonSafe, writeJsonAtomic } from './paths.mjs';

export const SUMMARY_VERSION = 17;

const INTERRUPT_RE = /\[Request interrupted by user/;
const COMPACT_RE = /^This session is being continued from a previous conversation/;
const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/;
// Blocks Claude Code (or hooks / the desktop app) inject into user turns. None of it was typed by a human.
const MACHINE_TAGS = [
  'system-reminder',
  'task-notification',
  'side-sessions-event',
  'ci-monitor-event',
  'local-command-stdout',
  'local-command-caveat',
  'command-name',
  'command-message',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'user-memory-input',
  'pr-link',
  'antml:function_results',
  // `!cmd` shell turns: the command and its output are not prompts
  'bash-input',
  'bash-stdout',
  'bash-stderr',
];
const MACHINE_BLOCK_RE = new RegExp(`<(${MACHINE_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'g');
const MACHINE_PREFIX_RE = /^\s*(\[SYSTEM NOTIFICATION|\[Request interrupted|<task-notification|<system-reminder)/;
const LEFTOVER_TAG_RE = /<\/?[a-z][a-z0-9_-]*(?:\s[^>]*)?>/g;

const TEST_CMD_RE =
  /\b(pytest|py\.test|npm (?:run )?test|yarn (?:run )?test|pnpm (?:run )?test|bun test|vitest|jest|mocha|go test|cargo test|dotnet test|mvn (?:-[^\s]+ )*test|gradle(?:w)? test|phpunit|rspec|mix test|make test|ctest|tox|nox|node --test)\b/;
const GIT_RE = /\bgit\s+(commit|push|pull|rebase|merge|checkout|switch|stash|reset|cherry-pick|worktree)\b/;
const FORCE_PUSH_RE = /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[^\s]+)/;
const DESTRUCTIVE_RE =
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-zA-Z]*f|\bgit\s+checkout\s+--\s|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bdel\s+\/[sq]|\brmdir\s+\/s|\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i;

const SHELL_KEYWORDS = new Set(['for', 'while', 'if', 'then', 'else', 'fi', 'do', 'done', 'case', 'esac', 'function', 'export', 'set', 'export', '&&', '||', '{', '}', '(', ')', 'local', 'return', 'exit']);

// Prompt openings that read like a correction. JS `\b` only knows ASCII word
// characters, so the boundary is a Unicode-aware lookahead instead.
const CORRECTION_OPENINGS = [
  'no[,.!\\s]', 'nope', "don'?t", 'do not', 'stop', 'wrong', 'not (?:that|this|what)', 'again', 'still', 'why did you', 'i (?:said|told|asked)', 'never', 'always', "please (?:don'?t|stop)", 'instead', 'revert', 'undo', "that'?s not",
  'нет[,.!\\s]', 'не надо', 'не нужно', 'не делай', 'не так', 'не то', 'неправильно', 'стоп', 'опять', 'снова', 'я (?:же )?(?:сказал|просил|говорил)', 'никогда', 'всегда', 'перестань', 'хватит', 'зачем ты', 'почему ты', 'верни', 'откати', 'отмени',
];
const CORRECTION_RE = new RegExp(`^\\s*(?:${CORRECTION_OPENINGS.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');

const ERROR_CLASSES = [
  ['user-rejected', /doesn'?t want to proceed|user rejected|rejected the tool|was rejected|permission to use .* denied/i],
  ['edit-mismatch', /old_string|string to replace not found|has not been read yet|file has been modified since|has been modified since read|not found in file|no changes to make|is identical/i],
  ['not-found', /command not found|is not recognized as an internal|no such file or directory|cannot find path|enoent\b|does not exist/i],
  ['permission', /permission denied|eacces|eperm\b|operation not permitted|access is denied/i],
  ['timeout', /timed out|timeout|etimedout|exceeded.*time limit/i],
  ['missing-dependency', /modulenotfounderror|cannot find module|importerror|no module named|could not resolve|package .* not found|not installed/i],
  ['syntax', /syntaxerror|parse error|unexpected token|invalid syntax|unexpected end of/i],
  // Runners differ in case and wording: jest "Tests: 1 failed", pytest "FAILED tests/x.py::t" / "1 failed", mocha "1 failing",
  // node:test "✖ failing tests" / "✖ name (1ms)" / "fail 1", dotnet "Failed MyTest [5 ms]" / "Failed: 1,".
  // Kept narrow on purpose: a bare "✖" (eslint, stylelint, listr), "N failures while ...", "Failed to read tests/x.json"
  // and a lower-case "fail:" log level (ASP.NET) are not test failures.
  ['test-failure', /\bfailed\b.*\b(?:test|tests|spec|assert)\b(?![/\\])|\b(?:test|tests)\b(?![/\\]).*\bfailed\b|assertionerror|✕|✗|^\s*✖\s+(?:failing tests|.*\(\d+(?:\.\d+)?m?s\))|\b[1-9]\d* (?:failed|failing)\b(?!\s+(?:to|while)\b)|\b[1-9]\d* failures?\s*(?:$|[,.)\]])|\bfail [1-9]|\bfailed:\s*[1-9]\d*\s*(?:,|$)|^\s*failed\s+\S+::|^\s*failed\s+\S+\s+\[\d+\s*m?s\]/im],
  // Go / jest / vitest print an upper-case FAIL at the start of a line; matched case-sensitively.
  ['test-failure', /^\s*(?:---\s*)?FAIL\b/m],
  ['type-check', /type error|typeerror|error ts\d+|mypy|incompatible types/i],
  ['lint', /eslint|ruff|flake8|pylint|prettier|stylelint|clippy|golangci/i],
  ['network', /econnrefused|enotfound|econnreset|network error|fetch failed|getaddrinfo|ssl|certificate/i],
  ['git-conflict', /merge conflict|conflict \(content\)|automatic merge failed|rebase.*conflict/i],
  ['nonzero-exit', /exit code [1-9]\d*|exited with code [1-9]/i],
];

function classifyError(text, isBash) {
  const t = String(text || '').slice(0, 4000);
  for (const [name, re] of ERROR_CLASSES) {
    if (name === 'test-failure' && !isBash) continue;
    if (re.test(t)) return name;
  }
  return 'other';
}

function inc(map, key, by = 1) {
  if (key === undefined || key === null || key === '') return;
  map[key] = (map[key] || 0) + by;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function blocks(content, type) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === type) : [];
}

/** Strip tags Claude Code injects (system reminders, command wrappers) to get what the human typed. */
export function humanText(raw) {
  if (!raw) return '';
  if (MACHINE_PREFIX_RE.test(raw) && !/<command-args>/.test(raw)) {
    // whole turn is machine-generated unless a human command argument is embedded
    const stripped = raw.replace(MACHINE_BLOCK_RE, '').replace(/^\s*\[SYSTEM NOTIFICATION[^\n]*\n?/m, '').trim();
    if (!stripped || /^(This is an automated|Do NOT interpret|No human input)/.test(stripped)) return '';
  }
  let t = raw.replace(MACHINE_BLOCK_RE, '');
  // keep the body of command-args (what the human typed after a slash command)
  const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
  t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
  t = t.replace(LEFTOVER_TAG_RE, '');
  if (args && args[1]) t = `${t} ${args[1]}`;
  t = t.replace(/^\s*\[SYSTEM NOTIFICATION[^\n]*\n?[\s\S]*?(?=\n\n|$)/, '');
  return t.trim();
}

/** Normalise a prompt into a short stem for repetition detection. */
export function promptStem(text, words = 6) {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`"'«»“”(){}\[\]<>|,:;!?.…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = norm.split(' ').filter(Boolean).slice(0, words);
  return parts.join(' ');
}

/** Normalise a shell command for repetition detection: collapse whitespace, mask hashes/numbers/paths. */
export function normalizeCommand(cmd) {
  return String(cmd)
    .replace(/\s+/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/(["'])(?:(?!\1).){40,}\1/g, '$1<text>$1')
    .trim()
    .slice(0, 200);
}

export function commandVerb(cmd) {
  // Skip leading "cd x &&" chains and env assignments, then take up to two tokens
  let c = String(cmd).trim();
  c = c.replace(/^(?:cd\s+[^&;|]+(?:&&|;)\s*)+/, '');
  c = c.replace(/^(?:[A-Z_]+=\S+\s+)+/, '');
  c = c.replace(/^(?:timeout\s+\d+\s+|sudo\s+|npx\s+-y\s+|npx\s+)/, '');
  const tokens = c.split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const first = tokens[0].replace(/^.*[\\/]/, '');
  if (SHELL_KEYWORDS.has(first)) return '(script)';
  const second = tokens[1] && !tokens[1].startsWith('-') && !/[\\/]/.test(tokens[1]) ? tokens[1] : '';
  const twoWord = new Set(['git', 'npm', 'yarn', 'pnpm', 'bun', 'docker', 'gh', 'glab', 'cargo', 'go', 'dotnet', 'kubectl', 'python', 'python3', 'node', 'make', 'pip', 'uv', 'poetry', 'terraform', 'aws', 'az', 'gcloud', 'railway', 'rtk']);
  return twoWord.has(first) && second ? `${first} ${second}` : first;
}

export function newSessionSummary(file) {
  return {
    v: SUMMARY_VERSION,
    file: path.basename(file),
    projectDir: path.basename(path.dirname(file)),
    sessionId: null,
    cwd: null,
    gitBranch: null,
    entrypoints: {},
    versions: {},
    startedAt: null,
    endedAt: null,
    userMessages: 0,
    assistantMessages: 0,
    sidechainMessages: 0,
    toolUses: {},
    toolErrors: {},
    errorClasses: {},
    toolDurations: {}, // tool -> {n, ms, max}
    slowCommands: [], // [{verb, ms}] top long bash commands
    interruptions: 0,
    compactions: 0,
    permissionDecisions: {},
    denialKinds: {},
    permissionModes: {},
    userRejections: 0,
    askUserQuestions: 0,
    planMode: 0,
    todoWrites: 0,
    subagents: {},
    subagentModels: {},
    skills: {},
    slashCommands: {},
    mcp: {}, // server -> {calls, tools: {}}
    bashVerbs: {},
    bashCommands: {}, // normalised -> count (trimmed to top N at the end)
    testCommands: 0,
    testFailures: 0,
    git: {},
    forcePushes: 0,
    destructive: 0,
    webSearches: 0,
    webFetches: 0,
    filesEdited: new Set(),
    extensions: {},
    models: {}, // model -> {messages, input, output, cacheRead, cacheCreate}
    peakContextTokens: 0,
    thinkingMs: 0,
    costUSD: null,
    linesAdded: 0,
    linesRemoved: 0,
    hooks: { summaries: 0, hookRuns: 0, errors: 0, events: {}, durations: {}, timeouts: {}, nonBlockingErrors: 0, errorSamples: [], errorsByCommand: {} },
    attachments: {},
    toolTimeouts: 0,
    toolInterrupted: 0,
    backgroundTasks: 0,
    userModifiedEdits: 0,
    hours: new Array(24).fill(0),
    weekdays: new Array(7).fill(0),
    promptStems: {}, // stem -> count
    promptSamples: {}, // stem -> first snippet (redacted)
    promptLengths: [], // chars per human prompt (capped list)
    corrections: 0,
    correctionSamples: [],
    langSample: [], // short prompt snippets for language detection
    responseGaps: [], // seconds between assistant end and next user message (capped)
  };
}

function finalize(s) {
  s.filesEdited = s.filesEdited instanceof Set ? s.filesEdited.size : s.filesEdited;
  // keep only the most frequent commands/stems to bound cache size
  s.bashCommands = topN(s.bashCommands, 60);
  s.promptStems = topN(s.promptStems, 80);
  s.hooks.errorsByCommand = topN(s.hooks.errorsByCommand, 20);
  for (const k of Object.keys(s.promptSamples)) if (!(k in s.promptStems)) delete s.promptSamples[k];
  s.slowCommands.sort((a, b) => b.ms - a.ms);
  s.slowCommands = s.slowCommands.slice(0, 10);
  s.promptLengths = s.promptLengths.slice(0, 500);
  s.responseGaps = s.responseGaps.slice(0, 500);
  s.langSample = s.langSample.slice(0, 40);
  s.durationMin = s.startedAt && s.endedAt ? Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60000) : 0;
  return s;
}

export function topN(obj, n) {
  return Object.fromEntries(
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  );
}

/** Scan one transcript file into a session summary. */
export async function summarizeTranscript(file) {
  const s = newSessionSummary(file);
  const pendingTools = new Map(); // tool_use id -> {name, ts, verb, isBash, sidechain}
  const seenUuids = new Set(); // resumed/forked sessions repeat lines
  const seenRequests = new Set(); // one assistant API response spans several lines (text, tool_use, thinking)
  let lastAssistantTs = null;
  let lastUserTs = null;
  let interruptSeen = false; // a tool_result already reported this Esc; its companion text line must not count twice

  for await (const o of readJsonl(file)) {
    const type = o.type;
    if (o.uuid) {
      if (seenUuids.has(o.uuid)) continue;
      seenUuids.add(o.uuid);
    }
    if (type === 'cost-state') {
      if (typeof o.totalCostUSD === 'number') s.costUSD = o.totalCostUSD;
      if (typeof o.totalLinesAdded === 'number') s.linesAdded = o.totalLinesAdded;
      if (typeof o.totalLinesRemoved === 'number') s.linesRemoved = o.totalLinesRemoved;
      continue;
    }
    if (type === 'system') {
      if (o.subtype === 'compact_boundary') {
        s.compactions++;
        inc(s.hooks.events, 'compact_boundary');
        continue;
      }
      if (o.subtype && /hook/i.test(o.subtype)) {
        s.hooks.summaries++;
        if (typeof o.hookCount === 'number') s.hooks.hookRuns += o.hookCount;
        const errs = Array.isArray(o.hookErrors) ? o.hookErrors.length : o.hookErrors ? 1 : 0;
        s.hooks.errors += errs;
        inc(s.hooks.events, o.subtype);
        if (Array.isArray(o.hookInfos)) {
          for (const h of o.hookInfos) {
            if (!h || typeof h.command !== 'string') continue;
            const key = hookKey(h.command);
            const d = (s.hooks.durations[key] ||= { n: 0, ms: 0, max: 0 });
            d.n++;
            if (typeof h.durationMs === 'number') {
              d.ms += h.durationMs;
              if (h.durationMs > d.max) d.max = h.durationMs;
            }
          }
        }
      }
      continue;
    }
    if (type === 'attachment') {
      const a = o.attachment || {};
      inc(s.attachments, a.type || 'unknown');
      // PreToolUse / PostToolUse / SessionStart / UserPromptSubmit runs arrive as hook_* attachments with their own
      // command and duration. Stop / SubagentStop runs also arrive as hook_* attachments, but the stop_hook_summary
      // system line above already counted them (same command and duration), so they are skipped here.
      const stopEvent = a.hookEvent === 'Stop' || a.hookEvent === 'SubagentStop';
      if (a.type === 'hook_cancelled' && typeof a.command === 'string') {
        // A cancelled run's durationMs is the time until it was killed, not how long the hook takes, so it never feeds
        // the averages. Cancellation by timeout is a finding of its own (the hook keeps hitting its limit).
        if (a.timedOut) {
          const tk = (s.hooks.timeouts[hookKey(a.command)] ||= { n: 0, limitMs: 0 });
          tk.n++;
          if (typeof a.timeoutMs === 'number' && a.timeoutMs > tk.limitMs) tk.limitMs = a.timeoutMs;
        }
        if (!stopEvent) s.hooks.hookRuns++;
      } else if (typeof a.type === 'string' && a.type.startsWith('hook_') && typeof a.command === 'string' && !stopEvent) {
        s.hooks.hookRuns++;
        const d = (s.hooks.durations[hookKey(a.command)] ||= { n: 0, ms: 0, max: 0 });
        d.n++;
        if (typeof a.durationMs === 'number') {
          d.ms += a.durationMs;
          if (a.durationMs > d.max) d.max = a.durationMs;
        }
      }
      if (a.type === 'hook_non_blocking_error' || a.type === 'hook_blocking_error' || a.type === 'hook_error') {
        s.hooks.nonBlockingErrors++;
        if (typeof a.command === 'string') inc(s.hooks.errorsByCommand, `${a.hookEvent || a.hookName || '?'}|${a.command.slice(0, 300)}`);
        if (s.hooks.errorSamples.length < 10) {
          const sample = {};
          for (const [k, v] of Object.entries(a)) {
            if (k === 'type') continue;
            if (typeof v === 'string') sample[k] = snippet(redact(v), 160);
            else if (typeof v === 'number' || typeof v === 'boolean') sample[k] = v;
          }
          s.hooks.errorSamples.push(sample);
        }
      }
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue;

    if (!s.sessionId && o.sessionId) s.sessionId = o.sessionId;
    if (!s.cwd && o.cwd) s.cwd = o.cwd;
    if (!s.gitBranch && o.gitBranch) s.gitBranch = o.gitBranch;
    if (o.entrypoint) inc(s.entrypoints, o.entrypoint);
    if (o.version) inc(s.versions, o.version);
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (!s.startedAt || ts < Date.parse(s.startedAt)) s.startedAt = o.timestamp;
      if (!s.endedAt || ts > Date.parse(s.endedAt)) s.endedAt = o.timestamp;
    }
    const content = o.message && o.message.content;
    const sidechain = o.isSidechain === true;
    if (sidechain) s.sidechainMessages++;

    if (type === 'assistant') {
      interruptSeen = false;
      const m = o.message || {};
      const reqKey = o.requestId || (m && m.id) || null;
      const firstOfRequest = !reqKey || !seenRequests.has(reqKey);
      if (reqKey) {
        seenRequests.add(reqKey);
        if (seenRequests.size > 5000) seenRequests.delete(seenRequests.values().next().value);
      }
      if (!sidechain && firstOfRequest) s.assistantMessages++;
      if (m.model && firstOfRequest) {
        const mm = (s.models[m.model] ||= { messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
        mm.messages++;
        const u = m.usage || {};
        mm.input += u.input_tokens || 0;
        mm.output += u.output_tokens || 0;
        mm.cacheRead += u.cache_read_input_tokens || 0;
        mm.cacheCreate += u.cache_creation_input_tokens || 0;
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (ctx > s.peakContextTokens) s.peakContextTokens = ctx;
      }
      if (typeof o.thinkingDurationMs === 'number' && firstOfRequest) s.thinkingMs += o.thinkingDurationMs;
      if (!sidechain && !Number.isNaN(ts)) lastAssistantTs = ts;
      for (const b of blocks(content, 'tool_use')) {
        const name = b.name || 'unknown';
        const input = b.input || {};
        if (!sidechain) inc(s.toolUses, name);
        let verb = '';
        const isBash = name === 'Bash';
        if (isBash && typeof input.command === 'string') {
          const cmd = input.command;
          verb = commandVerb(cmd);
          if (!sidechain) {
            inc(s.bashVerbs, verb);
            inc(s.bashCommands, normalizeCommand(redact(cmd)));
            if (TEST_CMD_RE.test(cmd)) s.testCommands++;
            const g = cmd.match(GIT_RE);
            if (g) inc(s.git, g[1]);
            if (FORCE_PUSH_RE.test(cmd)) s.forcePushes++;
            if (DESTRUCTIVE_RE.test(cmd)) s.destructive++;
          }
        } else if ((name === 'Agent' || name === 'Task') && !sidechain) {
          inc(s.subagents, input.subagent_type || 'general-purpose');
          if (input.model) inc(s.subagentModels, input.model);
        } else if (name === 'Skill' && !sidechain) {
          inc(s.skills, String(input.skill || input.name || 'unknown').replace(/^\//, ''));
        } else if (name === 'AskUserQuestion' && !sidechain) {
          s.askUserQuestions++;
        } else if ((name === 'EnterPlanMode' || name === 'ExitPlanMode') && !sidechain) {
          s.planMode++;
        } else if ((name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') && !sidechain) {
          s.todoWrites++;
        } else if (name === 'WebSearch' && !sidechain) {
          s.webSearches++;
        } else if (name === 'WebFetch' && !sidechain) {
          s.webFetches++;
        } else if (name.startsWith('mcp__')) {
          const parts = name.split('__');
          const server = parts[1] || 'unknown';
          const tool = parts.slice(2).join('__') || 'unknown';
          const srv = (s.mcp[server] ||= { calls: 0, tools: {} });
          srv.calls++;
          inc(srv.tools, tool);
        }
        // Main-session activity only, like the Bash counters above: edits and test runs must cover the same population.
        if (!sidechain && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && typeof (input.file_path || input.notebook_path) === 'string') {
          const fp = input.file_path || input.notebook_path;
          s.filesEdited.add(fp);
          const ext = path.extname(fp).toLowerCase() || '(none)';
          inc(s.extensions, ext);
        }
        if (b.id) pendingTools.set(b.id, { name, ts, verb, isBash, sidechain });
        if (pendingTools.size > 200) pendingTools.delete(pendingTools.keys().next().value);
      }
      continue;
    }

    // ---- user line ----
    if (o.permissionMode) inc(s.permissionModes, o.permissionMode);
    if (o.permissionDecision) {
      const pd = o.permissionDecision;
      inc(s.permissionDecisions, typeof pd === 'object' ? `${pd.decision || '?'}/${pd.reasonType || '?'}/${pd.source || '?'}` : String(pd));
    }
    if (o.toolDenialKind) inc(s.denialKinds, String(o.toolDenialKind));
    const tur = o.toolUseResult;
    if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
      if (typeof tur.timedOutAfterMs === 'number') s.toolTimeouts++;
      if (tur.interrupted === true) s.toolInterrupted++;
      if (tur.backgroundTaskId) s.backgroundTasks++;
      if (tur.userModified === true) s.userModifiedEdits++;
    }
    const results = blocks(content, 'tool_result');
    if (results.length) {
      for (const r of results) {
        const pend = pendingTools.get(r.tool_use_id);
        if (pend) {
          pendingTools.delete(r.tool_use_id);
          if (!Number.isNaN(ts) && !Number.isNaN(pend.ts) && !pend.sidechain) {
            const ms = Math.max(0, ts - pend.ts);
            const d = (s.toolDurations[pend.name] ||= { n: 0, ms: 0, max: 0 });
            d.n++;
            d.ms += ms;
            if (ms > d.max) d.max = ms;
            if (pend.isBash && ms >= 30000) s.slowCommands.push({ verb: pend.verb, ms });
          }
        }
        if (r.is_error === true && (!pend || !pend.sidechain)) {
          const text = typeof r.content === 'string' ? r.content : textOf(r.content);
          if (INTERRUPT_RE.test(text)) {
            // Esc during a tool call is an interruption, not a tool failure
            if (!interruptSeen) {
              s.interruptions++;
              interruptSeen = true;
            }
            continue;
          }
          const name = pend ? pend.name : 'unknown';
          inc(s.toolErrors, name);
          const cls = classifyError(text, pend ? pend.isBash : false);
          inc(s.errorClasses, cls);
          if (cls === 'user-rejected') s.userRejections++;
          if (cls === 'test-failure') s.testFailures++;
        } else if (pend && pend.isBash && pend.verb && TEST_CMD_RE.test(pend.verb)) {
          // test command that did not error: nothing to do, counted at tool_use time
        }
      }
      continue;
    }
    if (sidechain) continue;
    if (o.isMeta === true) continue;

    const raw = textOf(content);
    if (!raw) continue;
    if (INTERRUPT_RE.test(raw)) {
      if (!interruptSeen) s.interruptions++;
      interruptSeen = false;
      continue;
    }
    if (o.isCompactSummary === true || COMPACT_RE.test(raw)) {
      // compact_boundary system lines already count the compaction when present; older transcripts only have this marker
      if (!s.hooks.events.compact_boundary) s.compactions++;
      continue;
    }
    const cmd = raw.match(COMMAND_RE);
    if (cmd) {
      inc(s.slashCommands, cmd[1].toLowerCase());
    }
    const human = humanText(raw);
    if (!human) continue;
    s.userMessages++;
    if (!Number.isNaN(ts)) {
      const d = new Date(ts);
      s.hours[d.getHours()]++;
      s.weekdays[d.getDay()]++;
      if (lastAssistantTs && ts > lastAssistantTs && s.responseGaps.length < 500) {
        s.responseGaps.push(Math.round((ts - lastAssistantTs) / 1000));
      }
      lastUserTs = ts;
    }
    if (cmd) continue; // slash command invocations are not free-form prompts
    s.promptLengths.push(human.length);
    const safe = redact(human); // nothing derived from prompt text is stored unscrubbed
    if (s.langSample.length < 40) s.langSample.push(safe.slice(0, 120));
    const stem = promptStem(safe);
    if (stem && stem.split(' ').length >= 2) {
      inc(s.promptStems, stem);
      if (!s.promptSamples[stem]) s.promptSamples[stem] = snippet(safe, 160);
    }
    if (CORRECTION_RE.test(human)) {
      s.corrections++;
      if (s.correctionSamples.length < 12) s.correctionSamples.push(snippet(safe, 200));
    }
  }
  void lastUserTs;
  return finalize(s);
}

/** Shorten a hook command to a stable identity: drop quotes, node path and arguments after the script. */
export function hookKey(command) {
  return redact(hookKeyRaw(redact(String(command))));
}

function hookKeyRaw(command) {
  let c = String(command).replace(/\s+/g, ' ').trim();
  // "[ -f x ] || cmd" / "test -f x && cmd" wrappers: look at the command that actually runs
  const guarded = c.match(/(?:\|\||&&)\s*(.+)$/);
  if (/^(\[|test\s)/.test(c) && guarded) c = guarded[1].trim();
  // tokenize respecting quotes so "C:/Program Files/nodejs/node.exe" stays one token
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(c)) && tokens.length < 12) tokens.push(m[1] ?? m[2] ?? m[3]);
  if (!tokens.length) return '(empty)';
  const interp = /^(?:.*[\\/])?(node(?:\.exe)?|bun|deno|npx|uv|python3?(?:\.exe)?|bash|sh|zsh|pwsh(?:\.exe)?|powershell(?:\.exe)?|cmd(?:\.exe)?)$/i;
  let i = 0;
  while (i < tokens.length - 1 && (interp.test(tokens[i]) || /^-/.test(tokens[i]) || tokens[i] === 'run' || tokens[i] === '-y')) i++;
  const target = tokens[i] || tokens[0];
  const base = target.replace(/^.*[\\/]/, '');
  // Prompt-type hooks carry prose instead of a command
  if (!/[.\-_/\\]/.test(base) && tokens.length > 4 && !interp.test(tokens[0])) return '(prompt hook)';
  // A short capitalised label with no path or file name in it ("Design deep pass", "Preparing build session") is the
  // hook's status message, not a command: keep the whole label so different hooks do not collapse into one word.
  // Option flags (`-x`, `--x`), redacted values and secret-looking tokens (long id-like strings, `123456:AAH...`) mean it is
  // a command with arguments, so it keys as the command ("Get-Date -Format o" -> "Get-Date").
  const label = tokens.length >= 2 && /^\p{Lu}/u.test(tokens[0]) && !interp.test(tokens[0])
    && !tokens.some((x) => /[\\/=$|<>[\]]|^--?\w|\.\w{1,5}$|^\d+:|[A-Za-z0-9_:-]{20,}/.test(x));
  if (label) return c.slice(0, 60);
  return base.slice(0, 60) || c.slice(0, 60);
}

function cacheKey(file, st) {
  return crypto.createHash('sha1').update(`${file}|${st.size}|${Math.round(st.mtimeMs)}|${SUMMARY_VERSION}`).digest('hex');
}

/**
 * Enumerate transcript files under projectsDir modified after `sinceMs`.
 * Subagent transcripts live in nested directories; they are skipped (their
 * messages are also mirrored as isSidechain lines in the parent session).
 */
export function listTranscripts(projectsDir, { sinceMs = 0 } = {}) {
  const out = [];
  if (!fs.existsSync(projectsDir)) return out;
  for (const proj of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(projectsDir, proj.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.size === 0 || st.mtimeMs < sinceMs) continue;
      out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * Scan all transcripts. Returns {sessions, scanned, cached, bytes, errors}.
 * onProgress(done, total, file) is optional.
 */
export async function scanTranscripts({ projectsDir, sinceMs = 0, cacheDir = null, onProgress = null, useCache = true }) {
  const files = listTranscripts(projectsDir, { sinceMs });
  const sessions = [];
  let cached = 0;
  let bytes = 0;
  const errors = [];
  if (cacheDir && useCache) ensureDir(cacheDir);
  let i = 0;
  for (const f of files) {
    i++;
    bytes += f.size;
    const key = cacheDir ? cacheKey(f.file, { size: f.size, mtimeMs: f.mtimeMs }) : null;
    const cacheFile = key ? path.join(cacheDir, `${key}.json`) : null;
    let summary = cacheFile && useCache ? readJsonSafe(cacheFile) : null;
    if (summary && summary.v === SUMMARY_VERSION) {
      cached++;
    } else {
      try {
        summary = await summarizeTranscript(f.file);
        if (cacheFile) writeJsonAtomic(cacheFile, summary);
      } catch (err) {
        errors.push({ file: path.basename(f.file), error: String(err && err.message ? err.message : err) });
        continue;
      }
    }
    summary.mtime = new Date(f.mtimeMs).toISOString();
    summary.bytes = f.size;
    if (summary.userMessages + summary.assistantMessages > 0) sessions.push(summary);
    if (onProgress) onProgress(i, files.length, f.file);
  }
  return { sessions, scanned: files.length, cached, bytes, errors };
}
