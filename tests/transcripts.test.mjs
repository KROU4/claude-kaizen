// scripts/lib/transcripts.mjs and scripts/lib/jsonl.mjs against the synthetic transcripts in tests/fixtures/projects.
//
// What the three fixture sessions contain (all numbers below come from there):
//   session-a  main scenario. 8 typed prompts (3 of them open with the same six words, 2 are corrections, one is Russian),
//              19 API responses (some spread over 2-3 lines), a subagent excursion (sidechain lines), a 40 s build,
//              rm -rf x2, one force push, permission decisions, hook summaries and attachments, one compaction
//              (boundary + summary), a resume replay (duplicate uuids) and one truncated JSON line.
//   session-b  bypassPermissions prompts, a 30 s and a 29 s command, a timeout, edit mismatch, plan/todo/web tools,
//              a command with a secret repeated three times, machine/meta turns and garbage lines.
//   session-c  other project, claude-desktop entrypoint, legacy compaction (summary line without boundary), bare /review.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from '../scripts/lib/jsonl.mjs';
import {
  SUMMARY_VERSION,
  hookKey,
  humanText,
  listTranscripts,
  newSessionSummary,
  normalizeCommand,
  powershellVerb,
  promptStem,
  scanTranscripts,
  summarizeTranscript,
  topN,
} from '../scripts/lib/transcripts.mjs';
import { PROJECTS_FIXTURE, SESSION_IDS, TRANSCRIPTS, cleanupTempDirs, copyTree, dedupeByUuid, makeTempDir, parseJsonlFile, writeText } from './helpers.mjs';

const DEPLOY_STEM = 'deploy the service to staging and';

/** Write synthetic transcript lines (objects or raw strings) to a temp file and summarize it. */
async function summarizeLines(lines) {
  const dir = makeTempDir('kaizen-tr-');
  const file = path.join(dir, 'proj', 'inline.jsonl');
  writeText(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return summarizeTranscript(file);
}

const userLine = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, timestamp: '2026-10-29T09:00:00.000Z', ...extra });

const asstText = (id, extra = {}) => ({ type: 'assistant', uuid: `a-${id}`, requestId: `r-${id}`, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, timestamp: '2026-10-29T09:00:00.000Z', ...extra });

after(() => cleanupTempDirs());

describe('summarizeTranscript: session A', () => {
  let s;
  let lines;
  before(async () => {
    s = await summarizeTranscript(TRANSCRIPTS.a);
    lines = parseJsonlFile(TRANSCRIPTS.a);
  });

  describe('identity', () => {
    it('takes session id, cwd and branch from the first user or assistant line', () => {
      assert.equal(s.sessionId, SESSION_IDS.a);
      assert.equal(s.cwd, 'C:\\work\\demo-app');
      assert.equal(s.gitBranch, 'main');
    });

    it('derives file and project directory names from the path', () => {
      assert.equal(s.file, 'session-a.jsonl');
      assert.equal(s.projectDir, 'C--work-demo-app');
    });

    it('stamps the summary with the current summary version', () => {
      assert.equal(s.v, SUMMARY_VERSION);
    });

    it('counts entrypoint and client version per line, keeping resume duplicates out', () => {
      assert.deepEqual(s.entrypoints, { cli: 57 });
      assert.deepEqual(s.versions, { '2.1.101': 57 });
    });

    it('spans the first to the last timestamped line', () => {
      assert.equal(s.startedAt, '2026-10-29T09:00:05.000Z');
      assert.equal(s.endedAt, '2026-10-29T09:13:58.000Z');
      assert.equal(s.durationMin, 14);
    });
  });

  describe('prompts', () => {
    it('counts only human-typed prompts as user messages', () => {
      // 8 typed prompts. Not counted: tool results, the sidechain prompt, the machine notification,
      // the interruption, the bare /commit and the compaction summary.
      assert.equal(s.userMessages, 8);
      assert.equal(s.promptLengths.length, 8);
    });

    it('does not count a [SYSTEM NOTIFICATION] task-notification turn as a prompt', () => {
      assert.ok(!Object.keys(s.promptStems).some((stem) => /system notification|task notification|background command/.test(stem)));
      assert.ok(!s.langSample.some((text) => /SYSTEM NOTIFICATION|task-notification/.test(text)));
    });

    it('counts an interruption separately and keeps it out of the prompts', () => {
      assert.equal(s.interruptions, 1);
      assert.ok(!Object.keys(s.promptStems).some((stem) => stem.includes('request interrupted')));
    });

    it('counts a bare slash command as a slash command, not as a prompt', () => {
      assert.deepEqual(s.slashCommands, { commit: 1 });
      assert.ok(!('commit' in s.promptStems));
    });

    it('does not count the compaction summary as a prompt', () => {
      assert.ok(!Object.keys(s.promptStems).some((stem) => stem.startsWith('this session is being continued')));
    });

    it('detects exactly two corrections: the English "No, ..." and the Russian "Нет, ..."', () => {
      assert.equal(s.corrections, 2);
      assert.equal(s.correctionSamples.length, 2);
      assert.ok(s.correctionSamples[0].startsWith("No, don't hardcode"));
      assert.ok(s.correctionSamples[1].startsWith('Нет, не надо'));
    });

    it('redacts secrets inside correction samples', () => {
      assert.equal(s.correctionSamples[0], "No, don't hardcode password=[REDACTED:secret] in the config");
      assert.equal(s.correctionSamples[1], 'Нет, не надо трогать конфиг, token=[REDACTED:secret]');
      assert.ok(!JSON.stringify(s.correctionSamples).includes('swordfish123'));
      assert.ok(!JSON.stringify(s.correctionSamples).includes('FAKE-TOKEN-1234'));
    });

    it('groups the three prompts that open with the same six words into one stem with count 3', () => {
      assert.equal(s.promptStems[DEPLOY_STEM], 3);
      assert.equal(s.promptSamples[DEPLOY_STEM], 'Deploy the service to staging and check logs');
    });

    it('records every other prompt as its own stem with count 1', () => {
      const others = Object.entries(s.promptStems).filter(([stem]) => stem !== DEPLOY_STEM);
      assert.equal(others.length, 5);
      assert.ok(others.every(([, count]) => count === 1));
    });

    it('keeps secrets out of the persisted stems and samples', () => {
      const persisted = JSON.stringify({ stems: s.promptStems, samples: s.promptSamples });
      assert.ok(!/swordfish123/i.test(persisted), 'password value leaked into the summary');
      assert.ok(!/fake-token-1234/i.test(persisted), 'token value leaked into the summary');
    });

    it('keeps short snippets of the typed prompts for language detection', () => {
      assert.equal(s.langSample.length, 8);
      assert.ok(s.langSample.some((text) => text.startsWith('Нет, не надо')));
    });
  });

  describe('assistant responses and tokens', () => {
    it('counts one assistant message per distinct requestId, not one per line', () => {
      const assistantLines = dedupeByUuid(lines).filter((o) => o.type === 'assistant' && !o.isSidechain);
      const requests = new Set(assistantLines.map((o) => o.requestId));
      assert.ok(assistantLines.length > requests.size, 'fixture must spread some responses over several lines');
      assert.equal(s.assistantMessages, requests.size);
      assert.equal(s.assistantMessages, 19);
    });

    it('counts token usage once per API response even when every line of it repeats the usage', () => {
      const firstLineOfRequest = new Map();
      for (const o of dedupeByUuid(lines)) {
        if (o.type === 'assistant' && !firstLineOfRequest.has(o.requestId)) firstLineOfRequest.set(o.requestId, o);
      }
      const expected = {};
      for (const o of firstLineOfRequest.values()) {
        const m = (expected[o.message.model] ||= { messages: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
        m.messages++;
        m.input += o.message.usage.input_tokens;
        m.output += o.message.usage.output_tokens;
        m.cacheRead += o.message.usage.cache_read_input_tokens;
        m.cacheCreate += o.message.usage.cache_creation_input_tokens;
      }
      assert.deepEqual(s.models, expected);
    });

    it('splits usage per model, subagent traffic included', () => {
      assert.deepEqual(s.models['claude-opus-4-7'], { messages: 19, input: 75, output: 930, cacheRead: 102100, cacheCreate: 2310 });
      assert.deepEqual(s.models['claude-haiku-4-5'], { messages: 2, input: 42, output: 24, cacheRead: 1200, cacheCreate: 1210 });
    });

    it('tracks the largest prompt (input + cache read + cache creation) of any single response', () => {
      assert.equal(s.peakContextTokens, 6273);
    });

    it('adds up the thinking time reported on the first line of a response', () => {
      assert.equal(s.thinkingMs, 90000);
    });
  });

  describe('subagent (sidechain) traffic', () => {
    it('counts sidechain lines separately from the main conversation', () => {
      assert.equal(s.sidechainMessages, 4);
    });

    it('does not count sidechain tool use or sidechain responses as main-session activity', () => {
      assert.equal(s.toolUses.Read, undefined);
      assert.equal(s.assistantMessages, 19);
      assert.equal(s.userMessages, 8);
    });
  });

  describe('tool use', () => {
    it('counts tool_use blocks by tool name', () => {
      assert.deepEqual(s.toolUses, {
        Bash: 7,
        Edit: 3,
        Write: 1,
        Agent: 1,
        Task: 1,
        Skill: 1,
        AskUserQuestion: 1,
        mcp__github__get_issue: 1,
        mcp__plugin_demo_srv__tool: 1,
        'mcp__used-srv__ping': 1,
      });
    });

    it('reduces Bash commands to verbs (git, npm and rm keep their subcommand where it is one)', () => {
      assert.deepEqual(s.bashVerbs, { 'git status': 2, 'npm test': 1, 'npm run': 1, rm: 2, 'git push': 1 });
    });

    it('counts git subcommands', () => {
      assert.deepEqual(s.git, { push: 1 });
    });

    it('counts test runs', () => {
      assert.equal(s.testCommands, 1);
    });

    it('counts destructive commands (rm -rf twice) and the force push separately', () => {
      assert.equal(s.destructive, 2);
      assert.equal(s.forcePushes, 1);
    });

    it('keeps normalized Bash commands with their counts', () => {
      assert.equal(s.bashCommands['git status'], 2);
      assert.equal(s.bashCommands['rm -rf /'], 1);
      assert.equal(s.bashCommands['git push --force origin main'], 1);
    });

    it('records Agent/Task spawns by subagent type, defaulting to general-purpose, with the model they asked for', () => {
      assert.deepEqual(s.subagents, { 'code-reviewer': 1, 'general-purpose': 1 });
      assert.deepEqual(s.subagentModels, { haiku: 1 });
    });

    it('records skill invocations, AskUserQuestion and MCP calls', () => {
      assert.deepEqual(s.skills, { 'demo-skill': 1 });
      assert.equal(s.askUserQuestions, 1);
      assert.deepEqual(s.mcp, {
        github: { calls: 1, tools: { get_issue: 1 } },
        plugin_demo_srv: { calls: 1, tools: { tool: 1 } },
        'used-srv': { calls: 1, tools: { ping: 1 } },
      });
    });

    it('counts distinct edited files and edits per extension', () => {
      assert.equal(s.filesEdited, 2);
      assert.deepEqual(s.extensions, { '.ts': 2, '.py': 2 });
    });

    it('counts edits the user changed by hand in between (toolUseResult.userModified)', () => {
      assert.equal(s.userModifiedEdits, 1);
    });
  });

  describe('errors and permissions', () => {
    it('attributes failed tool results to the tool that produced them', () => {
      assert.deepEqual(s.toolErrors, { Bash: 3, Edit: 1 });
    });

    it('classifies failures: test failure, edit mismatch, user rejection and everything else', () => {
      assert.deepEqual(s.errorClasses, { 'test-failure': 1, 'edit-mismatch': 1, 'user-rejected': 1, other: 1 });
      assert.equal(s.testFailures, 1);
    });

    it('counts a user rejection once', () => {
      assert.equal(s.userRejections, 1);
    });

    it('records denial kinds reported on the tool result line', () => {
      assert.deepEqual(s.denialKinds, { 'user-rejected': 1, 'permission-rule': 1 });
    });

    it('keys permission decisions as decision/reasonType/source', () => {
      assert.equal(s.permissionDecisions['accept/rule/user_permanent'], 1);
      assert.deepEqual(s.permissionDecisions, {
        'accept/rule/user_permanent': 1,
        'accept/mode/config': 4,
        'accept/hook/hook': 1,
        'accept/rule/user_temporary': 1,
        'reject/user/user_reject': 1,
        'reject/rule/config': 1,
        'accept/rule/config': 1,
      });
    });

    it('counts the permission mode of every user line that carries one', () => {
      assert.deepEqual(s.permissionModes, { default: 10 });
    });
  });

  describe('timing', () => {
    it('measures tool duration from the tool_use line to its tool_result line', () => {
      assert.deepEqual(s.toolDurations.Bash, { n: 7, ms: 48000, max: 40000 });
      assert.deepEqual(s.toolDurations.Edit, { n: 3, ms: 3000, max: 1000 });
    });

    it('lists the 40 second command among the slow commands', () => {
      assert.deepEqual(s.slowCommands, [{ verb: 'npm run', ms: 40000 }]);
    });
  });

  describe('hooks and attachments', () => {
    it('counts stop_hook_summary lines, hook runs and hook errors', () => {
      assert.equal(s.hooks.summaries, 2);
      // 3 from the Stop summaries (2 + 1) plus 5 PreToolUse/PostToolUse runs that arrive as hook_* attachments
      assert.equal(s.hooks.hookRuns, 8);
      assert.equal(s.hooks.errors, 1);
    });

    it('does not treat a system line without "hook" in its subtype as a hook event', () => {
      assert.deepEqual(s.hooks.events, { stop_hook_summary: 2, compact_boundary: 1 });
    });

    it('keys hook durations by script basename: x.mjs, not "Program"', () => {
      assert.ok('x.mjs' in s.hooks.durations);
      assert.ok(!('Program' in s.hooks.durations));
      assert.ok(!Object.keys(s.hooks.durations).some((k) => /Program|Files|nodejs/.test(k)));
      assert.deepEqual(s.hooks.durations['x.mjs'], { n: 2, ms: 4000, max: 2500 });
      // 1 Stop run (300 ms) + 3 hook_success attachments (300 ms each) + 1 hook_non_blocking_error attachment (80 ms)
      assert.deepEqual(s.hooks.durations.prettier, { n: 5, ms: 1280, max: 300 });
      assert.deepEqual(s.hooks.durations['guard.mjs'], { n: 1, ms: 120, max: 120 });
    });

    it('counts non-blocking hook errors from attachments', () => {
      assert.equal(s.hooks.nonBlockingErrors, 2);
    });

    it('counts attachments by type, using "unknown" for an attachment without one', () => {
      assert.deepEqual(s.attachments, { hook_success: 3, hook_non_blocking_error: 2, todo_reminder: 1, unknown: 1 });
    });

    it('keeps hook error samples with the hook name, exit code and a redacted stderr', () => {
      assert.equal(s.hooks.errorSamples.length, 2);
      const sample = s.hooks.errorSamples[0];
      assert.equal(sample.hookName, 'PreToolUse:Bash');
      assert.equal(sample.exitCode, 1);
      assert.equal(sample.stderr, 'guard.mjs: cannot read config token=[REDACTED:secret]');
      assert.ok(!JSON.stringify(s.hooks.errorSamples).includes('FAKE-HOOK-SECRET-1'));
    });

    it('counts hook errors per event and command', () => {
      assert.deepEqual(s.hooks.errorsByCommand, {
        'PreToolUse|node "C:/Users/dev/.claude/kaizen/hooks/guard.mjs"': 1,
        'PostToolUse|npx prettier --write': 1,
      });
    });
  });

  describe('compaction, cost and resume', () => {
    it('counts the compact_boundary line once, not again for the summary message that follows', () => {
      assert.equal(s.compactions, 1);
    });

    it('takes cost and line totals from the last cost-state line', () => {
      assert.equal(s.costUSD, 1.25);
      assert.equal(s.linesAdded, 10);
      assert.equal(s.linesRemoved, 3);
    });

    it('ignores lines whose uuid was already seen (a resumed session replays its history)', () => {
      const uuids = lines.map((o) => o.uuid).filter(Boolean);
      assert.ok(uuids.length > new Set(uuids).size, 'fixture must contain replayed lines');
      // If the replay were counted the deploy stem would be 4 and git status would have run 3 times.
      assert.equal(s.promptStems[DEPLOY_STEM], 3);
      assert.equal(s.bashVerbs['git status'], 2);
      assert.equal(s.toolUses.Bash, 7);
    });

    it('skips a line that is not valid JSON and keeps reading', () => {
      const raw = fs.readFileSync(TRANSCRIPTS.a, 'utf8').split('\n').filter(Boolean);
      const broken = raw.filter((line) => {
        if (!line.startsWith('{')) return false;
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(broken.length, 1, 'fixture must contain exactly one truncated JSON line');
      assert.equal(s.userMessages, 8);
      assert.equal(s.assistantMessages, 19);
    });
  });
});

describe('summarizeTranscript: session B', () => {
  let s;
  before(async () => {
    s = await summarizeTranscript(TRANSCRIPTS.b);
  });

  it('reads the branch, version and entrypoint of the session', () => {
    assert.equal(s.gitBranch, 'feature/csv');
    assert.deepEqual(s.versions, { '2.1.102': 62 });
    assert.deepEqual(s.entrypoints, { cli: 62 });
  });

  it('counts five typed prompts and 22 responses', () => {
    assert.equal(s.userMessages, 5);
    assert.equal(s.assistantMessages, 22);
    assert.equal(s.sidechainMessages, 0);
  });

  it('ignores summary, file-history-snapshot, system-reminder and isMeta lines and unparsable garbage', () => {
    // none of these may turn into prompts, stems or errors
    assert.equal(s.userMessages, 5);
    assert.deepEqual(Object.keys(s.promptStems).sort(), [
      'commit this with a conventional message',
      'refactor the config loader to use',
      'run the test suite and fix',
      'show me the diff before committing',
      'update the readme with the new',
    ]);
    assert.ok(!s.langSample.some((text) => /Caveat|system-reminder|task tools/.test(text)));
  });

  it('counts the permission modes: two bypassPermissions prompts and three default ones', () => {
    assert.deepEqual(s.permissionModes, { bypassPermissions: 2, default: 3 });
  });

  it('counts a command that took exactly 30 s as slow and one that took 29 s as not slow', () => {
    assert.deepEqual(s.slowCommands, [
      { verb: 'docker compose', ms: 120000 },
      { verb: 'pytest', ms: 30000 },
    ]);
    assert.equal(s.toolDurations.Bash.max, 120000);
  });

  it('classifies a "timed out" result as a timeout and a modified-since-read result as an edit mismatch', () => {
    assert.deepEqual(s.errorClasses, { 'edit-mismatch': 1, timeout: 1 });
    assert.deepEqual(s.toolErrors, { Edit: 1, Bash: 1 });
  });

  it('counts timed-out, interrupted and background tool results from toolUseResult', () => {
    assert.equal(s.toolTimeouts, 1);
    assert.equal(s.toolInterrupted, 1);
    assert.equal(s.backgroundTasks, 1);
  });

  it('counts plan mode switches, todo writes and web tools', () => {
    assert.equal(s.planMode, 2);
    assert.equal(s.todoWrites, 1);
    assert.equal(s.webSearches, 1);
    assert.equal(s.webFetches, 1);
  });

  it('counts commits, pushes, a hard reset and test runs', () => {
    assert.deepEqual(s.git, { commit: 2, push: 1, reset: 1 });
    assert.equal(s.destructive, 1);
    assert.equal(s.forcePushes, 0);
    assert.equal(s.testCommands, 2);
  });

  it('records an Explore subagent without a model', () => {
    assert.deepEqual(s.subagents, { Explore: 1 });
    assert.deepEqual(s.subagentModels, {});
  });

  it('counts one decision per tool_result line even when two sessions share the same decision key', () => {
    assert.deepEqual(s.permissionDecisions, { 'accept/rule/user_permanent': 2, 'accept/mode/config': 2 });
  });

  it('reads cost and line totals from the only cost-state line', () => {
    assert.equal(s.costUSD, 0.75);
    assert.equal(s.linesAdded, 5);
    assert.equal(s.linesRemoved, 2);
  });

  it('keeps a command that is repeated three times with its secret redacted', () => {
    const repeated = Object.entries(s.bashCommands).filter(([, n]) => n === 3);
    assert.equal(repeated.length, 1);
    assert.ok(!/FAKE-DEPLOY-TOKEN/i.test(repeated[0][0]), `secret leaked into: ${repeated[0][0]}`);
    assert.equal(repeated[0][0], './deploy.sh --token=[REDACTED:secret] --env staging');
  });
});

describe('summarizeTranscript: session C', () => {
  let s;
  before(async () => {
    s = await summarizeTranscript(TRANSCRIPTS.c);
  });

  it('belongs to the other project and carries the desktop entrypoint', () => {
    assert.equal(s.projectDir, 'C--work-other');
    assert.equal(s.cwd, 'C:\\work\\other');
    assert.deepEqual(s.entrypoints, { 'claude-desktop': 12 });
  });

  it('has no git branch and no cost when the transcript carries none', () => {
    assert.equal(s.gitBranch, null);
    assert.equal(s.costUSD, null);
    assert.equal(s.linesAdded, 0);
  });

  it('counts three typed prompts and keeps the bare /review out of them', () => {
    assert.equal(s.userMessages, 3);
    assert.deepEqual(s.slashCommands, { review: 1 });
  });

  it('counts a compaction that only has a summary message (older transcripts without compact_boundary)', () => {
    assert.equal(s.compactions, 1);
  });

  it('classifies a non-zero exit as nonzero-exit', () => {
    assert.deepEqual(s.errorClasses, { 'nonzero-exit': 1 });
  });
});

describe('summarizeTranscript: edge cases on inline transcripts', () => {
  it('returns an empty summary for a transcript that only has unknown line types', async () => {
    const s = await summarizeLines([{ type: 'summary', summary: 'x', leafUuid: 'u' }, { type: 'file-history-snapshot', snapshot: {} }]);
    assert.equal(s.userMessages, 0);
    assert.equal(s.assistantMessages, 0);
    assert.equal(s.sessionId, null);
    assert.equal(s.durationMin, 0);
  });

  it('falls back to message.id when requestId is missing, so a split response still counts once', async () => {
    const usage = { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const mk = (blocks, uuid) => ({ type: 'assistant', uuid, message: { id: 'msg_X', model: 'claude-test', role: 'assistant', content: blocks, usage }, timestamp: '2026-10-29T09:00:00.000Z' });
    const s = await summarizeLines([mk([{ type: 'text', text: 'a' }], 'u1'), mk([{ type: 'text', text: 'b' }], 'u2')]);
    assert.equal(s.assistantMessages, 1);
    assert.deepEqual(s.models['claude-test'], { messages: 1, input: 5, output: 7, cacheRead: 0, cacheCreate: 0 });
  });

  it('counts every assistant line separately when it has neither requestId nor message.id', async () => {
    const mk = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, timestamp: '2026-10-29T09:00:00.000Z' });
    const s = await summarizeLines([mk('u1'), mk('u2'), mk('u3')]);
    assert.equal(s.assistantMessages, 3);
  });

  it('attributes an error without a matching tool_use to the tool "unknown"', async () => {
    const s = await summarizeLines([
      userLine([{ type: 'tool_result', tool_use_id: 'toolu_missing', is_error: true, content: 'command not found: foo' }], { uuid: 'u1' }),
    ]);
    assert.deepEqual(s.toolErrors, { unknown: 1 });
    assert.deepEqual(s.errorClasses, { 'not-found': 1 });
  });

  it('classifies error text delivered as an array of text blocks', async () => {
    const s = await summarizeLines([
      userLine([{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'Error: ECONNREFUSED 127.0.0.1:5432' }] }], { uuid: 'u1' }),
    ]);
    assert.deepEqual(s.errorClasses, { network: 1 });
  });

  it('does not classify test failures for non-Bash tools', async () => {
    const tool = { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } };
    const s = await summarizeLines([
      { type: 'assistant', uuid: 'a1', requestId: 'r1', message: { id: 'm1', role: 'assistant', content: [tool] }, timestamp: '2026-10-29T09:00:00.000Z' },
      userLine([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '2 tests failed' }], { uuid: 'u1' }),
    ]);
    assert.equal(s.testFailures, 0);
    assert.deepEqual(s.errorClasses, { other: 1 });
  });

  it('counts a sidechain MCP call but not a sidechain Bash command', async () => {
    const mk = (id, name, input) => ({ type: 'assistant', uuid: `u-${id}`, requestId: `r-${id}`, isSidechain: true, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: '2026-10-29T09:00:00.000Z' });
    const s = await summarizeLines([mk('t1', 'Bash', { command: 'git status' }), mk('t2', 'mcp__github__get_issue', {})]);
    assert.deepEqual(s.toolUses, {});
    assert.deepEqual(s.bashVerbs, {});
    assert.deepEqual(s.mcp, { github: { calls: 1, tools: { get_issue: 1 } } });
    assert.equal(s.assistantMessages, 0);
    assert.equal(s.sidechainMessages, 2);
  });

  const asst = (id, blocks, extra = {}) => ({ type: 'assistant', uuid: `u-${id}`, requestId: `r-${id}`, message: { id: `m-${id}`, role: 'assistant', content: blocks }, timestamp: '2026-10-29T09:00:00.000Z', ...extra });
  const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const toolResult = (id, content, isError = true) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });

  it('tells code edits from documentation-only edits', async () => {
    const s = await summarizeLines([
      asst('e1', [toolUse('t1', 'Edit', { file_path: 'README.md', old_string: 'a', new_string: 'b' })]),
      asst('e2', [toolUse('t2', 'Write', { file_path: 'docs/notes.txt', content: 'x' })]),
      asst('e3', [toolUse('t3', 'Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })]),
    ]);
    assert.equal(s.filesEdited, 3);
    assert.equal(s.codeFilesEdited, 1);
    const docsOnly = await summarizeLines([asst('d1', [toolUse('t1', 'Edit', { file_path: 'CHANGELOG.md', old_string: 'a', new_string: 'b' })])]);
    assert.equal(docsOnly.codeFilesEdited, 0);
  });

  it('does not count `!` shell turns (bash-input / bash-stdout / bash-stderr) as prompts, stems or samples', async () => {
    const s = await summarizeLines([
      userLine('<bash-input>git status</bash-input>', { uuid: 'u1' }),
      userLine('<bash-stdout>On branch main\nnothing to commit, working tree clean</bash-stdout><bash-stderr></bash-stderr>', { uuid: 'u2' }),
      userLine('<bash-input>git status</bash-input>', { uuid: 'u3' }),
      userLine('<bash-stdout>On branch main\nnothing to commit, working tree clean</bash-stdout><bash-stderr></bash-stderr>', { uuid: 'u4' }),
      userLine('please look at the failing build', { uuid: 'u5' }),
    ]);
    assert.equal(s.userMessages, 1);
    assert.deepEqual(s.promptStems, { 'please look at the failing build': 1 });
    assert.ok(!JSON.stringify(s.promptSamples).includes('nothing to commit'));
    assert.ok(!JSON.stringify(s.langSample).includes('nothing to commit'));
    assert.equal(s.promptLengths.length, 1);
  });

  it('humanText returns nothing for shell turns', () => {
    assert.equal(humanText('<bash-input>git status</bash-input>'), '');
    assert.equal(humanText('<bash-stdout>x y z</bash-stdout><bash-stderr>oops</bash-stderr>'), '');
  });

  it('counts a tool interrupted with Esc once as an interruption and not as a tool error', async () => {
    const marker = '[Request interrupted by user for tool use]';
    const s = await summarizeLines([
      asst('1', [toolUse('t1', 'Bash', { command: 'sleep 600' })]),
      userLine([toolResult('t1', marker)], { uuid: 'u1' }),
      userLine([{ type: 'text', text: marker }], { uuid: 'u2' }),
    ]);
    assert.equal(s.interruptions, 1);
    assert.deepEqual(s.toolErrors, {});
    assert.deepEqual(s.errorClasses, {});
  });

  it('counts an interruption reported only by the tool_result, and a later plain interrupt separately', async () => {
    const marker = '[Request interrupted by user for tool use]';
    const s = await summarizeLines([
      asst('1', [toolUse('t1', 'Bash', { command: 'sleep 600' })]),
      userLine([toolResult('t1', marker)], { uuid: 'u1' }),
      asst('2', [{ type: 'text', text: 'ok' }]),
      userLine([{ type: 'text', text: '[Request interrupted by user]' }], { uuid: 'u2' }),
    ]);
    assert.equal(s.interruptions, 2);
    assert.deepEqual(s.toolErrors, {});
  });

  it('still counts a real tool failure next to an interruption', async () => {
    const s = await summarizeLines([
      asst('1', [toolUse('t1', 'Bash', { command: 'false' }), toolUse('t2', 'Bash', { command: 'sleep 600' })]),
      userLine([toolResult('t1', 'Exit code 1'), toolResult('t2', '[Request interrupted by user for tool use]')], { uuid: 'u1' }),
    ]);
    assert.deepEqual(s.toolErrors, { Bash: 1 });
    assert.equal(s.interruptions, 1);
  });

  it('classifies test failures from pytest, mocha, node:test, dotnet and jest output', async () => {
    const outputs = [
      'FAILED tests/test_x.py::test_a - assert 1 == 2\n=== 1 failed, 2 passed in 0.12s ===\nExit code 1',
      '  1 passing (5ms)\n  1 failing\n\n  1) suite\n       AssertionError: expected 1 to equal 2\nExit code 1',
      '✖ failing tests:\n# fail 1\nExit code 1',
      '  Failed MyTests.Adds [5 ms]\nFailed!  - Failed:     1, Passed:     2\nExit code 1',
      'Tests: 1 failed, 2 passed, 3 total\nExit code 1',
      '--- FAIL: TestAdd (0.00s)\nFAIL\nexit status 1',
    ];
    const lines = [];
    outputs.forEach((out, i) => {
      lines.push(asst(`a${i}`, [toolUse(`t${i}`, 'Bash', { command: 'run tests' })]));
      lines.push(userLine([toolResult(`t${i}`, out)], { uuid: `ru${i}` }));
    });
    const s = await summarizeLines(lines);
    assert.deepEqual(s.errorClasses, { 'test-failure': outputs.length });
    assert.equal(s.testFailures, outputs.length);
  });

  it('does not classify linter, listr, dotnet run and plain error output as test failures', async () => {
    const outputs = [
      'Exit code 1\n✖ 1 problem (1 error, 0 warnings)',
      'Exit code 1\n✖ 3 problems (2 errors, 1 warning)',
      'Exit code 1\nfail: Microsoft.AspNetCore.Server.Kestrel[13]\n      Connection processing ended abnormally.',
      'Exit code 1\n✖ Failed to download template',
      'Exit code 1\nError: Failed to read config from tests/fixtures/app.json',
      'Exit code 1\n2 failures while copying files',
      'Exit code 1\nStatus: failed: 1 layer could not be pulled',
    ];
    const lines = [];
    outputs.forEach((out, i) => {
      lines.push(asst(`a${i}`, [toolUse(`t${i}`, 'Bash', { command: 'npx eslint .' })]));
      lines.push(userLine([toolResult(`t${i}`, out)], { uuid: `ru${i}` }));
    });
    const s = await summarizeLines(lines);
    assert.equal(s.testFailures, 0);
    assert.equal(s.errorClasses['test-failure'], undefined);
    assert.equal(s.errorClasses['nonzero-exit'], outputs.length);
  });

  it('still detects node:test, rspec and dotnet failures after tightening the regex', async () => {
    const outputs = [
      '✖ adds numbers (1.2ms)\nℹ fail 1\nExit code 1',
      '3 examples, 1 failure\nExit code 1',
      'Total tests: 3\n     Passed: 2\n     Failed: 1\nExit code 1',
      'FAIL src/add.test.js\nExit code 1',
    ];
    const lines = [];
    outputs.forEach((out, i) => {
      lines.push(asst(`a${i}`, [toolUse(`t${i}`, 'Bash', { command: 'run tests' })]));
      lines.push(userLine([toolResult(`t${i}`, out)], { uuid: `ru${i}` }));
    });
    const s = await summarizeLines(lines);
    assert.equal(s.testFailures, outputs.length);
  });

  it('does not mistake unrelated failures for test failures', async () => {
    const outputs = ['fetch failed: ECONNREFUSED', 'fatal: unable to access repo\nExit code 128', 'Build failed\nExit code 1'];
    const lines = [];
    outputs.forEach((out, i) => {
      lines.push(asst(`a${i}`, [toolUse(`t${i}`, 'Bash', { command: 'x' })]));
      lines.push(userLine([toolResult(`t${i}`, out)], { uuid: `ru${i}` }));
    });
    const s = await summarizeLines(lines);
    assert.equal(s.testFailures, 0);
  });

  it('keeps subagent edits out of filesEdited and extensions, but counts the tests a subagent ran', async () => {
    const s = await summarizeLines([
      asst('1', [toolUse('e1', 'Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }), toolUse('b1', 'Bash', { command: 'npm test' })], { isSidechain: true }),
      asst('2', [toolUse('e2', 'Write', { file_path: '/w/src/main.py', content: 'x' })]),
    ]);
    assert.equal(s.filesEdited, 1);
    assert.deepEqual(s.extensions, { '.py': 1 });
    assert.equal(s.testCommands, 1);
    assert.equal(s.sidechainTestCommands, 1);
    assert.deepEqual(s.bashVerbs, {}, 'the other Bash counters stay main-session');
  });

  it('counts a test run by a subagent (Kaizen test-runner) as verification of the main-session edits', async () => {
    const s = await summarizeLines([
      asst('1', [toolUse('e1', 'Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' })]),
      asst('2', [toolUse('a1', 'Agent', { subagent_type: 'test-runner', prompt: 'run the tests' })]),
      asst('3', [toolUse('b1', 'Bash', { command: 'npm test' }), toolUse('b2', 'Bash', { command: 'git status' })], { isSidechain: true }),
      userLine([toolResult('b1', 'Exit code 1\nTests: 2 failed, 118 passed')], { uuid: 'ur1', isSidechain: true }),
    ]);
    assert.equal(s.filesEdited, 1);
    assert.equal(s.testCommands, 1);
    assert.equal(s.sidechainTestCommands, 1);
    assert.equal(s.testFailures, 1, 'a failing test run in a subagent is a test failure');
    assert.deepEqual(s.toolErrors, {}, 'sidechain tool errors are not main-session errors');
  });

  it('does not count the time spent waiting for a permission answer as a slow command', async () => {
    const at = (sec) => new Date(Date.UTC(2026, 9, 29, 9, 0, 0) + sec * 1000).toISOString();
    const run = (id, cmd, startSec, endSec, decision) => [
      { ...asst(id, [toolUse(id, 'Bash', { command: cmd })]), timestamp: at(startSec) },
      { ...userLine([toolResult(id, 'ok', false)], { uuid: `ur-${id}` }), timestamp: at(endSec), ...(decision ? { permissionDecision: decision } : {}) },
    ];
    const s = await summarizeLines([
      ...run('w1', 'git status', 0, 60, { decision: 'accept', reasonType: 'prompt', source: 'user_temporary' }),
      ...run('w2', 'git diff', 100, 160, { decision: 'accept', reasonType: 'mode', source: 'config' }),
      ...run('w3', 'npm run build', 200, 260),
    ]);
    assert.deepEqual(s.slowCommands.map((c) => c.verb).sort(), ['git diff', 'npm run'], 'the prompted git status is not slow, the unprompted ones are');
    assert.equal(s.slowCommandCount, 2);
  });

  it('keeps counting slow commands past the ten longest of a session', async () => {
    const at = (sec) => new Date(Date.UTC(2026, 9, 29, 9, 0, 0) + sec * 1000).toISOString();
    const lines = [];
    for (let i = 0; i < 25; i++) {
      lines.push({ ...asst(`s${i}`, [toolUse(`s${i}`, 'Bash', { command: 'npm run build' })]), timestamp: at(i * 100) });
      lines.push({ ...userLine([toolResult(`s${i}`, 'ok', false)], { uuid: `us${i}` }), timestamp: at(i * 100 + 40) });
    }
    const s = await summarizeLines(lines);
    assert.equal(s.slowCommandCount, 25);
    assert.equal(s.slowCommands.length, 25);
  });

  it('records hook runs and durations from hook_* attachments', async () => {
    const att = (type, extra) => ({ type: 'attachment', uuid: `h-${Math.random()}`, attachment: { type, command: 'node "/x/format.mjs"', ...extra } });
    const s = await summarizeLines([
      att('hook_success', { durationMs: 4000 }),
      att('hook_success', { durationMs: 2000 }),
      att('hook_non_blocking_error', { durationMs: 100, hookEvent: 'PostToolUse' }),
      { type: 'attachment', uuid: 'h-none', attachment: { type: 'hook_success' } },
    ]);
    assert.equal(s.hooks.hookRuns, 3);
    assert.deepEqual(s.hooks.durations['format.mjs'], { n: 3, ms: 6100, max: 4000 });
  });

  it('counts a Stop hook run once when it appears both as an attachment and in stop_hook_summary', async () => {
    const cmd = 'node "/x/notify.mjs"';
    const s = await summarizeLines([
      { type: 'attachment', uuid: 'h1', attachment: { type: 'hook_success', hookEvent: 'Stop', command: cmd, durationMs: 2000 } },
      { type: 'system', subtype: 'stop_hook_summary', uuid: 'h2', hookCount: 1, hookInfos: [{ command: cmd, durationMs: 2000 }], hookErrors: [] },
      { type: 'attachment', uuid: 'h3', attachment: { type: 'hook_success', hookEvent: 'SubagentStop', command: cmd, durationMs: 500 } },
      { type: 'attachment', uuid: 'h4', attachment: { type: 'hook_success', hookEvent: 'PostToolUse', command: cmd, durationMs: 100 } },
    ]);
    assert.equal(s.hooks.hookRuns, 2); // 1 from the Stop summary + 1 PostToolUse attachment
    assert.deepEqual(s.hooks.durations['notify.mjs'], { n: 2, ms: 2100, max: 2000 });
  });

  it('records hooks killed by their timeout separately and keeps cancelled runs out of the duration averages', async () => {
    const cmd = 'node "/x/block-push.mjs"';
    const s = await summarizeLines([
      { type: 'attachment', uuid: 'c1', attachment: { type: 'hook_cancelled', hookEvent: 'PreToolUse', command: cmd, durationMs: 18000, timedOut: true, timeoutMs: 5000 } },
      { type: 'attachment', uuid: 'c2', attachment: { type: 'hook_cancelled', hookEvent: 'PreToolUse', command: cmd, durationMs: 9000, timedOut: true, timeoutMs: 5000 } },
      { type: 'attachment', uuid: 'c3', attachment: { type: 'hook_cancelled', hookEvent: 'PreToolUse', command: cmd, durationMs: 300, timedOut: false } },
      { type: 'attachment', uuid: 'c4', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: cmd, durationMs: 200 } },
    ]);
    assert.equal(s.hooks.hookRuns, 4);
    assert.deepEqual(s.hooks.timeouts['block-push.mjs'], { n: 2, limitMs: 5000 });
    assert.deepEqual(s.hooks.durations['block-push.mjs'], { n: 1, ms: 200, max: 200 });
  });

  it('treats a user line with a <command-args> body as one user message but not as a free-form prompt', async () => {
    const s = await summarizeLines([
      userLine('<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>the login bug</command-args>', { uuid: 'u1' }),
    ]);
    assert.deepEqual(s.slashCommands, { fix: 1 });
    assert.equal(s.userMessages, 1);
    assert.deepEqual(s.promptStems, {});
  });

  it('survives a transcript where every line lacks a timestamp', async () => {
    const s = await summarizeLines([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello there friend' } }]);
    assert.equal(s.userMessages, 1);
    assert.equal(s.startedAt, null);
    assert.equal(s.durationMin, 0);
  });

  it('reports a correction only for prompts that start like one', async () => {
    const s = await summarizeLines([
      asstText('0'), // a correction answers something Claude did
      userLine("Don't touch the lockfile", { uuid: 'u1' }),
      userLine('please add a button, no animations', { uuid: 'u2' }),
      userLine('Стоп, это не то', { uuid: 'u3' }),
      userLine('Notes about the nodes', { uuid: 'u4' }),
    ]);
    assert.equal(s.corrections, 2);
  });
});

describe('newSessionSummary', () => {
  it('returns independent objects with zeroed counters', () => {
    const a = newSessionSummary('/x/proj/a.jsonl');
    const b = newSessionSummary('/x/proj/b.jsonl');
    assert.equal(a.v, SUMMARY_VERSION);
    assert.equal(a.file, 'a.jsonl');
    assert.equal(a.projectDir, 'proj');
    assert.equal(a.userMessages, 0);
    assert.notEqual(a.toolUses, b.toolUses);
    assert.notEqual(a.hours, b.hours);
    assert.equal(a.hours.length, 24);
    assert.equal(a.weekdays.length, 7);
  });
});

describe('promptStem', () => {
  it('lowercases and keeps the first six words', () => {
    assert.equal(promptStem('One Two Three Four Five Six Seven Eight'), 'one two three four five six');
  });

  it('honours a custom word count', () => {
    assert.equal(promptStem('one two three four', 2), 'one two');
  });

  it('strips punctuation, quotes and brackets', () => {
    assert.equal(promptStem('Deploy the service, to "staging"!'), 'deploy the service to staging');
    assert.equal(promptStem('Fix (the) [bug] {now}'), 'fix the bug now');
  });

  it('drops URLs', () => {
    assert.equal(promptStem('see https://example.test/a?b=1 for details'), 'see for details');
  });

  it('lowercases Cyrillic as well', () => {
    assert.equal(promptStem('Нет, Не надо'), 'нет не надо');
  });

  it('gives the same stem to differently punctuated repeats of one instruction', () => {
    assert.equal(promptStem('Deploy the service to staging and check logs'), promptStem('deploy the service to staging, and check the logs again'));
  });

  it('returns an empty string for empty or punctuation-only text', () => {
    assert.equal(promptStem(''), '');
    assert.equal(promptStem('?! ... ,,'), '');
  });
});

describe('normalizeCommand', () => {
  it('collapses whitespace and newlines', () => {
    assert.equal(normalizeCommand('git   status\n'), 'git status');
  });

  it('masks commit hashes', () => {
    assert.equal(normalizeCommand('git show 1a2b3c4d5e'), 'git show <hash>');
  });

  it('masks numbers of two or more digits and keeps single digits', () => {
    assert.equal(normalizeCommand('sleep 90'), 'sleep <n>');
    assert.equal(normalizeCommand('head -n 5 file.txt'), 'head -n 5 file.txt');
  });

  it('replaces long quoted text (40+ characters) but keeps short quoted text', () => {
    assert.equal(normalizeCommand('git commit -m "feat: add csv converter"'), 'git commit -m "feat: add csv converter"');
    assert.equal(normalizeCommand("git commit -m 'this message is much longer than forty characters in total'"), "git commit -m '<text>'");
  });

  it('truncates to 200 characters', () => {
    assert.equal(normalizeCommand('x'.repeat(500)).length, 200);
  });
});

describe('humanText', () => {
  it('returns typed text unchanged apart from trimming', () => {
    assert.equal(humanText('  Fix the login bug \n'), 'Fix the login bug');
  });

  it('returns an empty string for empty input', () => {
    assert.equal(humanText(''), '');
    assert.equal(humanText(null), '');
    assert.equal(humanText(undefined), '');
  });

  it('removes injected <system-reminder> blocks and keeps what the human typed', () => {
    assert.equal(humanText('Fix it\n<system-reminder>ignore me</system-reminder>'), 'Fix it');
  });

  it('returns an empty string for a turn that is only a system reminder', () => {
    assert.equal(humanText('<system-reminder>\nTask tools were not used recently.\n</system-reminder>'), '');
  });

  it('returns an empty string for a [SYSTEM NOTIFICATION] task-notification turn', () => {
    const raw = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>';
    assert.equal(humanText(raw), '');
  });

  it('returns an empty string for a bare slash command', () => {
    assert.equal(humanText('<command-message>commit</command-message>\n<command-name>/commit</command-name>'), '');
  });

  it('keeps the arguments the human typed after a slash command', () => {
    const raw = '<command-message>fix</command-message>\n<command-name>/fix</command-name>\n<command-args>the login bug</command-args>';
    assert.equal(humanText(raw), 'the login bug');
  });

  it('strips unknown wrapper tags but keeps their text', () => {
    assert.equal(humanText('Hello <b>world</b>'), 'Hello world');
  });
});

describe('hookKey', () => {
  it('keeps a short status-message label whole instead of its first word', () => {
    assert.equal(hookKey('Design deep pass'), 'Design deep pass');
    assert.equal(hookKey('Preparing build session'), 'Preparing build session');
    assert.equal(hookKey('Подготовка сессии'), 'Подготовка сессии');
    // real commands are unaffected
    assert.equal(hookKey('Get-Date'), 'Get-Date');
    assert.equal(hookKey('Prettier --write src/a.ts'), 'Prettier');
    assert.equal(hookKey('node "C:/x/Fmt Hook.mjs"'), 'Fmt Hook.mjs');
    assert.equal(hookKey('Long prose about many different things here'), '(prompt hook)');
  });

  it('keys a command with arguments as the command, never as a label carrying its arguments', () => {
    assert.equal(hookKey('Get-Date -Format o'), 'Get-Date');
    assert.equal(hookKey('Get-ChildItem --recurse x'), 'Get-ChildItem');
    assert.equal(hookKey('MyTool --api-key sk-abcdef1234567890abcdefgh run'), 'MyTool');
    assert.equal(hookKey('Notify-Telegram 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ'), 'Notify-Telegram');
    assert.equal(hookKey('Notify 1234567890:short'), 'Notify');
    assert.equal(hookKey('Deploy abcdefghijklmnopqrstuvwxyz0123'), 'Deploy');
  });

  it('never lets a secret reach the key, whichever branch produces it', () => {
    const secrets = ['sk-abcdef1234567890abcdefgh', '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'];
    for (const s of secrets) {
      for (const cmd of [`Notify ${s}`, `${s}`, `node hook.mjs ${s}`, `bash -c "curl -H 'Authorization: Bearer ${s}' x"`, `MyTool --key ${s}`, `API_TOKEN=${s} node a.mjs`, `Notify --api-key=${s}`]) {
        const key = hookKey(cmd);
        assert.ok(!key.includes(s) && !key.includes(s.slice(0, 20)), `${cmd} -> ${key}`);
      }
    }
    assert.match(hookKey('sk-abcdef1234567890abcdefgh'), /^\[REDACTED:/);
  });

  it('uses the script basename after a quoted node path with spaces', () => {
    assert.equal(hookKey('node "C:/Program Files/nodejs/node.exe" "C:/x/y/keyword.mjs"'), 'keyword.mjs');
  });

  it('never returns a fragment of the node path ("Program")', () => {
    assert.equal(hookKey('node "C:/Program Files/nodejs/node.exe" x.mjs'), 'x.mjs');
  });

  it('labels a prose prompt hook', () => {
    assert.equal(hookKey('Check that all tests pass before stopping and summarize the result'), '(prompt hook)');
  });

  it('looks through a [ -f ... ] || wrapper to the command that actually runs', () => {
    assert.equal(hookKey('[ ! -f a ] || node b.mjs'), 'b.mjs');
  });

  it('looks through a test ... && wrapper', () => {
    assert.equal(hookKey('test -f a.txt && node c.mjs --flag'), 'c.mjs');
  });

  it('skips runners and their flags', () => {
    assert.equal(hookKey('npx prettier --write'), 'prettier');
    assert.equal(hookKey('npx -y prettier --write'), 'prettier');
  });

  it('handles unquoted Windows paths with backslashes', () => {
    assert.equal(hookKey('node C:\\Users\\me\\.claude\\kaizen\\hooks\\guard.mjs'), 'guard.mjs');
  });

  it('handles shells and interpreters', () => {
    assert.equal(hookKey('bash ~/.claude/hooks/notify.sh arg'), 'notify.sh');
    assert.equal(hookKey('python3 /opt/hooks/check.py'), 'check.py');
  });

  it('returns (empty) for an empty command', () => {
    assert.equal(hookKey(''), '(empty)');
    assert.equal(hookKey('   '), '(empty)');
  });

  it('caps very long script names at 60 characters', () => {
    assert.equal(hookKey(`node ${'a'.repeat(80)}.mjs`).length, 60);
  });
});

describe('topN', () => {
  it('keeps the n largest entries in descending order', () => {
    assert.deepEqual(Object.entries(topN({ a: 1, b: 5, c: 3 }, 2)), [
      ['b', 5],
      ['c', 3],
    ]);
  });

  it('returns everything when n is larger than the map', () => {
    assert.deepEqual(topN({ a: 1 }, 10), { a: 1 });
  });
});

describe('readJsonl', () => {
  it('yields parsed objects and skips blank lines and lines that do not start with {', async () => {
    const dir = makeTempDir('kaizen-jsonl-');
    const file = path.join(dir, 'x.jsonl');
    writeText(file, '{"a":1}\n\nnot json\n[1,2]\n{"b":2}\n');
    const seen = [];
    for await (const o of readJsonl(file)) seen.push(o);
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  });

  it('reports unparsable objects through onError with their line number and keeps going', async () => {
    const dir = makeTempDir('kaizen-jsonl-');
    const file = path.join(dir, 'x.jsonl');
    writeText(file, '{"a":1}\n{"broken": \n{"c":3}\n');
    const errors = [];
    const seen = [];
    for await (const o of readJsonl(file, { onError: (err, lineNo) => errors.push(lineNo) })) seen.push(o);
    assert.deepEqual(seen, [{ a: 1 }, { c: 3 }]);
    assert.deepEqual(errors, [2]);
  });

  it('reads CRLF files and a last line without a trailing newline', async () => {
    const dir = makeTempDir('kaizen-jsonl-');
    const file = path.join(dir, 'x.jsonl');
    writeText(file, '{"a":1}\r\n{"b":2}');
    const seen = [];
    for await (const o of readJsonl(file)) seen.push(o);
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  });
});

describe('listTranscripts', () => {
  let projects;
  before(() => {
    projects = makeTempDir('kaizen-list-');
    const write = (rel, text, mtimeSec) => {
      const file = path.join(projects, rel);
      writeText(file, text);
      if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
    };
    write('proj1/older.jsonl', '{"type":"user"}\n', 1_700_000_000);
    write('proj1/newer.jsonl', '{"type":"user"}\n', 1_800_000_000);
    write('proj1/empty.jsonl', '', 1_800_000_100);
    write('proj1/notes.txt', 'not a transcript', 1_800_000_200);
    write('proj1/older/subagents/agent-1.jsonl', '{"type":"user"}\n', 1_700_000_300);
    write('proj2/other.jsonl', '{"type":"user"}\n', 1_750_000_000);
    write('stray.jsonl', '{"type":"user"}\n', 1_800_000_400);
  });

  it('lists *.jsonl files of project directories, oldest first', () => {
    const names = listTranscripts(projects).map((f) => path.basename(f.file));
    assert.deepEqual(names, ['older.jsonl', 'other.jsonl', 'newer.jsonl']);
  });

  it('skips empty files, non-jsonl files, subagent transcripts as sessions of their own and files outside project directories', () => {
    const names = listTranscripts(projects).map((f) => path.basename(f.file));
    for (const skipped of ['empty.jsonl', 'notes.txt', 'agent-1.jsonl', 'stray.jsonl']) assert.ok(!names.includes(skipped), skipped);
  });

  it('filters by modification time with sinceMs', () => {
    const names = listTranscripts(projects, { sinceMs: 1_760_000_000 * 1000 }).map((f) => path.basename(f.file));
    assert.deepEqual(names, ['newer.jsonl']);
  });

  it('reports size and mtime for each file', () => {
    const [first] = listTranscripts(projects);
    assert.equal(first.size, '{"type":"user"}\n'.length);
    assert.equal(Math.round(first.mtimeMs / 1000), 1_700_000_000);
  });

  it('returns an empty list when the projects directory does not exist', () => {
    assert.deepEqual(listTranscripts(path.join(projects, 'missing')), []);
  });
});

describe('scanTranscripts', () => {
  it('summarizes every fixture transcript and reports the scan totals', async () => {
    const res = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE });
    assert.equal(res.scanned, 3);
    assert.equal(res.cached, 0);
    assert.equal(res.sessions.length, 3);
    assert.deepEqual(res.errors, []);
    const total = ['a', 'b', 'c'].reduce((sum, k) => sum + fs.statSync(TRANSCRIPTS[k]).size, 0);
    assert.equal(res.bytes, total);
    assert.deepEqual(res.sessions.map((s) => s.sessionId).sort(), [SESSION_IDS.a, SESSION_IDS.b, SESSION_IDS.c].sort());
  });

  it('adds the file mtime and size to each session', async () => {
    const res = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE });
    for (const s of res.sessions) {
      assert.ok(Number.isFinite(Date.parse(s.mtime)), 'mtime must be an ISO date');
      assert.ok(s.bytes > 0);
    }
  });

  it('reads everything from the cache on the second run: cached === scanned', async () => {
    const cacheDir = path.join(makeTempDir('kaizen-cache-'), 'sessions');
    const first = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir });
    assert.equal(first.cached, 0);
    assert.equal(fs.readdirSync(cacheDir).length, 3);
    const second = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir });
    assert.equal(second.scanned, 3);
    assert.equal(second.cached, second.scanned);
    assert.deepEqual(second.sessions, first.sessions);
  });

  it('ignores the cache with useCache: false', async () => {
    const cacheDir = path.join(makeTempDir('kaizen-cache-'), 'sessions');
    await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir });
    const res = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir, useCache: false });
    assert.equal(res.cached, 0);
  });

  it('re-summarizes a transcript that changed after it was cached', async () => {
    const projects = path.join(makeTempDir('kaizen-cache-'), 'projects');
    copyTree(PROJECTS_FIXTURE, projects);
    const cacheDir = path.join(path.dirname(projects), 'cache');
    await scanTranscripts({ projectsDir: projects, cacheDir });
    fs.appendFileSync(path.join(projects, 'C--work-other', 'session-c.jsonl'), JSON.stringify(userLine('One more prompt for the importer', { uuid: 'extra-1', sessionId: SESSION_IDS.c })) + '\n');
    const res = await scanTranscripts({ projectsDir: projects, cacheDir });
    assert.equal(res.scanned, 3);
    assert.equal(res.cached, 2);
    const c = res.sessions.find((s) => s.sessionId === SESSION_IDS.c);
    assert.equal(c.userMessages, 4);
  });

  it('does not reuse a cache entry written by another summary version', async () => {
    const cacheDir = path.join(makeTempDir('kaizen-cache-'), 'sessions');
    await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir });
    for (const f of fs.readdirSync(cacheDir)) {
      const file = path.join(cacheDir, f);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      entry.v = SUMMARY_VERSION - 1;
      fs.writeFileSync(file, JSON.stringify(entry));
    }
    const res = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, cacheDir });
    assert.equal(res.cached, 0);
    assert.equal(res.sessions.length, 3);
  });

  it('calls onProgress once per file with (done, total, file)', async () => {
    const calls = [];
    await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, onProgress: (done, total, file) => calls.push([done, total, path.basename(file)]) });
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [[1, 3], [2, 3], [3, 3]]);
    assert.ok(calls.every((c) => c[2].endsWith('.jsonl')));
  });

  it('counts a transcript without user or assistant lines as scanned but does not return it as a session', async () => {
    const projects = path.join(makeTempDir('kaizen-scan-'), 'projects');
    writeText(path.join(projects, 'p', 'only-summary.jsonl'), '{"type":"summary","summary":"x","leafUuid":"u"}\n');
    const res = await scanTranscripts({ projectsDir: projects });
    assert.equal(res.scanned, 1);
    assert.equal(res.sessions.length, 0);
  });

  it('honours sinceMs', async () => {
    const res = await scanTranscripts({ projectsDir: PROJECTS_FIXTURE, sinceMs: Date.now() + 86400000 });
    assert.equal(res.scanned, 0);
    assert.deepEqual(res.sessions, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Round 7: subagent transcripts, forks, the --days window, PowerShell, machine-origin turns, corrections.
// All transcripts below are synthetic and live in temp dirs.

const TS = (d, hh = '09', mm = '00', ss = '00') => `2026-${d}T${hh}:${mm}:${ss}.000Z`;
const writeJsonl = (file, lines) => writeText(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const asstTools = (id, blocks, extra = {}) => ({ type: 'assistant', uuid: `a-${id}`, requestId: `r-${id}`, message: { id: `m-${id}`, role: 'assistant', content: blocks, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: TS('10-29'), ...extra });
const useTool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const resultOf = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, is_error: isError, content });

describe('subagent transcripts (<session>/subagents/*.jsonl)', () => {
  let projects;
  const SID = '44444444-dddd-4ddd-8ddd-dddddddddddd';
  const parentLines = () => [
    { type: 'cost-state', totalCostUSD: 1.5, totalLinesAdded: 3, totalLinesRemoved: 1 },
    userLine('implement the parser for the config file', { uuid: 'p-u1', sessionId: SID }),
    asstTools('p1', [useTool('e1', 'Edit', { file_path: '/w/src/p.js', old_string: 'a', new_string: 'b' })], { sessionId: SID }),
    userLine([resultOf('e1', 'ok')], { uuid: 'p-u2', sessionId: SID }),
    asstTools('p2', [useTool('ag1', 'Agent', { subagent_type: 'test-runner', prompt: 'run the tests' })], { sessionId: SID }),
  ];
  const subLines = () => [
    userLine('run the tests and report', { uuid: 's-u1', sessionId: SID, isSidechain: true }),
    asstTools('s1', [useTool('sb1', 'Bash', { command: 'npm test' })], { sessionId: SID, isSidechain: true, message: { id: 'm-s1', role: 'assistant', model: 'claude-test', content: [useTool('sb1', 'Bash', { command: 'npm test' })], usage: { input_tokens: 150000, output_tokens: 5 } } }),
    userLine([resultOf('sb1', 'FAIL src/p.test.js\nTests: 1 failed, 4 passed', true)], { uuid: 's-u2', sessionId: SID, isSidechain: true }),
    asstTools('s2', [useTool('sb2', 'mcp__context7__query-docs', { q: 'x' })], { sessionId: SID, isSidechain: true }),
    asstTools('s3', [useTool('sb3', 'Bash', { command: 'git commit -m x' })], { sessionId: SID, isSidechain: true }),
    { type: 'cost-state', totalCostUSD: 99, totalLinesAdded: 999, totalLinesRemoved: 999 },
    { type: 'system', subtype: 'compact_boundary', uuid: 's-c1', timestamp: TS('10-29') },
  ];

  before(() => {
    projects = path.join(makeTempDir('kaizen-sub-'), 'projects');
    writeJsonl(path.join(projects, 'p1', `${SID}.jsonl`), parentLines());
    writeJsonl(path.join(projects, 'p1', SID, 'subagents', 'agent-aaa.jsonl'), subLines());
  });

  it('listTranscripts attaches the subagent files to their session and does not list them as sessions', () => {
    const list = listTranscripts(projects);
    assert.equal(list.length, 1);
    assert.equal(path.basename(list[0].file), `${SID}.jsonl`);
    assert.deepEqual(list[0].subagents.map((x) => path.basename(x.file)), ['agent-aaa.jsonl']);
    assert.ok(list[0].subagents[0].size > 0);
  });

  it('keeps a session whose main file is old when one of its subagent files is newer than sinceMs', () => {
    const dir = path.join(makeTempDir('kaizen-sub-'), 'projects');
    writeJsonl(path.join(dir, 'p', 's1.jsonl'), [userLine('hello there friend', { uuid: 'u1' })]);
    writeJsonl(path.join(dir, 'p', 's1', 'subagents', 'agent-1.jsonl'), [userLine('sub', { uuid: 'u2', isSidechain: true })]);
    writeJsonl(path.join(dir, 'p', 's2.jsonl'), [userLine('hello there friend', { uuid: 'u3' })]);
    fs.utimesSync(path.join(dir, 'p', 's1.jsonl'), 1_700_000_000, 1_700_000_000);
    fs.utimesSync(path.join(dir, 'p', 's2.jsonl'), 1_700_000_000, 1_700_000_000);
    fs.utimesSync(path.join(dir, 'p', 's1', 'subagents', 'agent-1.jsonl'), 1_800_000_000, 1_800_000_000);
    assert.deepEqual(listTranscripts(dir, { sinceMs: 1_750_000_000 * 1000 }).map((f) => path.basename(f.file)), ['s1.jsonl']);
  });

  it('ignores empty subagent files and subagent directories without a main transcript', () => {
    const dir = path.join(makeTempDir('kaizen-sub-'), 'projects');
    writeJsonl(path.join(dir, 'p', 's1.jsonl'), [userLine('hello there friend', { uuid: 'u1' })]);
    writeText(path.join(dir, 'p', 's1', 'subagents', 'agent-empty.jsonl'), '');
    writeText(path.join(dir, 'p', 's1', 'subagents', 'notes.txt'), 'x');
    writeJsonl(path.join(dir, 'p', 'orphan', 'subagents', 'agent-1.jsonl'), [userLine('x', { uuid: 'u2', isSidechain: true })]);
    const list = listTranscripts(dir);
    assert.deepEqual(list.map((f) => path.basename(f.file)), ['s1.jsonl']);
    assert.deepEqual(list[0].subagents, []);
  });

  it('merges the subagent test runs, MCP calls and test failures into the parent session', async () => {
    const res = await scanTranscripts({ projectsDir: projects });
    assert.equal(res.sessions.length, 1);
    const s = res.sessions[0];
    assert.equal(s.testCommands, 1);
    assert.equal(s.sidechainTestCommands, 1);
    assert.equal(s.testFailures, 1);
    assert.deepEqual(s.mcp, { context7: { calls: 1, tools: { 'query-docs': 1 } } });
    assert.equal(s.sidechainMessages, 5);
    assert.equal(s.codeFilesEdited, 1);
  });

  it('keeps the main-session counters main-session: messages, tool uses, git, cost, compactions, context peak', async () => {
    const res = await scanTranscripts({ projectsDir: projects });
    const s = res.sessions[0];
    assert.equal(s.userMessages, 1);
    assert.equal(s.assistantMessages, 2);
    assert.deepEqual(s.toolUses, { Edit: 1, Agent: 1 });
    assert.deepEqual(s.git, {}, 'a subagent git command is not a main-session one');
    assert.equal(s.costUSD, 1.5, 'the cumulative cost-state of the main file wins');
    assert.equal(s.linesAdded, 3);
    assert.equal(s.compactions, 0);
    assert.ok(s.peakContextTokens < 1000, `peak ${s.peakContextTokens}`);
    assert.equal(s.sessionId, SID);
  });

  it('counts the same lines once when an older Claude Code version also mirrored them as sidechain lines of the parent', async () => {
    const dir = path.join(makeTempDir('kaizen-sub-'), 'projects');
    const mirrored = subLines().filter((l) => l.type !== 'cost-state');
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), [...parentLines(), ...mirrored]);
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'agent-aaa.jsonl'), mirrored);
    const res = await scanTranscripts({ projectsDir: dir });
    const s = res.sessions[0];
    assert.equal(s.testCommands, 1);
    assert.equal(s.testFailures, 1);
    assert.equal(s.sidechainMessages, 5);
    assert.equal(s.mcp.context7.calls, 1);
  });

  it('treats every line of a subagent file as sidechain even without the isSidechain flag', async () => {
    const dir = path.join(makeTempDir('kaizen-sub-'), 'projects');
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), parentLines());
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'agent-bbb.jsonl'), [
      userLine('run it', { uuid: 'x-u1' }),
      asstTools('x1', [useTool('xb1', 'Bash', { command: 'pytest -q' })]),
    ]);
    const s = (await scanTranscripts({ projectsDir: dir })).sessions[0];
    assert.equal(s.userMessages, 1, 'the subagent prompt is not a human prompt');
    assert.equal(s.assistantMessages, 2);
    assert.equal(s.sidechainTestCommands, 1);
  });

  it('re-summarizes the session when only its subagent file changed (the cache key covers it)', async () => {
    const dir = path.join(makeTempDir('kaizen-sub-'), 'projects');
    const cacheDir = path.join(path.dirname(dir), 'cache');
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), parentLines());
    const subFile = path.join(dir, 'p1', SID, 'subagents', 'agent-aaa.jsonl');
    writeJsonl(subFile, subLines().slice(0, 3));
    const first = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.equal(first.sessions[0].mcp.context7, undefined);
    assert.equal((await scanTranscripts({ projectsDir: dir, cacheDir })).cached, 1);
    fs.appendFileSync(subFile, JSON.stringify(subLines()[3]) + '\n');
    const again = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.equal(again.cached, 0);
    assert.equal(again.sessions[0].mcp.context7.calls, 1);
  });

  it('reports the subagent bytes in the scan total', async () => {
    const res = await scanTranscripts({ projectsDir: projects });
    const list = listTranscripts(projects)[0];
    assert.equal(res.bytes, list.size + list.subagents[0].size);
  });
});

describe('forks and copies of a session (uuid dedup across files)', () => {
  const history = (sid) => [
    userLine('Add a login page for the app', { uuid: 'h-u1', sessionId: sid, timestamp: TS('10-29', '09', '00') }),
    asstText('h1', { sessionId: sid, timestamp: TS('10-29', '09', '01') }),
    userLine('No, that is wrong, redo the layout', { uuid: 'h-u2', sessionId: sid, timestamp: TS('10-29', '09', '02') }),
    asstText('h2', { sessionId: sid, timestamp: TS('10-29', '09', '03') }),
    userLine('Stop adding comments to every line', { uuid: 'h-u3', sessionId: sid, timestamp: TS('10-29', '09', '04') }),
    asstText('h3', { sessionId: sid, timestamp: TS('10-29', '09', '05') }),
    userLine('Deploy the service to staging and report back', { uuid: 'h-u4', sessionId: sid, timestamp: TS('10-29', '09', '06') }),
    asstText('h4', { sessionId: sid, timestamp: TS('10-29', '09', '07') }),
  ];
  let dir;
  let cacheDir;
  const sidOf = (n) => `0000000${n}-ffff-4fff-8fff-ffffffffffff`;
  const setup = (parentMtime = 1_760_000_000, forkMtime = 1_760_000_100) => {
    dir = path.join(makeTempDir('kaizen-fork-'), 'projects');
    cacheDir = path.join(path.dirname(dir), 'cache');
    const parent = path.join(dir, 'p1', `${sidOf(1)}.jsonl`);
    const f1 = path.join(dir, 'p1', `${sidOf(2)}.jsonl`);
    const f2 = path.join(dir, 'p1', `${sidOf(3)}.jsonl`);
    writeJsonl(parent, history(sidOf(1)));
    writeJsonl(f1, [...history(sidOf(2)), userLine('Never touch the lockfile', { uuid: 'f1-u1', sessionId: sidOf(2), timestamp: TS('10-29', '10', '00') }), asstText('f1', { sessionId: sidOf(2), timestamp: TS('10-29', '10', '01') })]);
    writeJsonl(f2, [...history(sidOf(3)), userLine('Please add tests for the login page', { uuid: 'f2-u1', sessionId: sidOf(3), timestamp: TS('10-29', '11', '00') }), asstText('f2', { sessionId: sidOf(3), timestamp: TS('10-29', '11', '01') })]);
    fs.utimesSync(parent, parentMtime, parentMtime);
    fs.utimesSync(f1, forkMtime, forkMtime);
    fs.utimesSync(f2, forkMtime + 1, forkMtime + 1);
  };
  const totals = (sessions) => ({
    sessions: sessions.length,
    user: sessions.reduce((n, s) => n + s.userMessages, 0),
    asst: sessions.reduce((n, s) => n + s.assistantMessages, 0),
    corrections: sessions.reduce((n, s) => n + s.corrections, 0),
  });

  it('counts the replayed history once: the typed prompts, not once per fork', async () => {
    setup();
    const res = await scanTranscripts({ projectsDir: dir });
    // typed: 4 in the parent + 1 new in each fork; corrections: 2 in the history + "Never ..." in the first fork
    assert.deepEqual(totals(res.sessions), { sessions: 3, user: 6, asst: 6, corrections: 3 });
    const stems = {};
    for (const s of res.sessions) for (const [k, v] of Object.entries(s.promptStems)) stems[k] = (stems[k] || 0) + v;
    assert.ok(Object.values(stems).every((n) => n === 1), JSON.stringify(stems));
  });

  it('gives each fork only its own new lines and keeps the parent whole', async () => {
    setup();
    const res = await scanTranscripts({ projectsDir: dir });
    const byId = Object.fromEntries(res.sessions.map((s) => [s.file, s]));
    assert.equal(byId[`${sidOf(1)}.jsonl`].userMessages, 4);
    assert.equal(byId[`${sidOf(2)}.jsonl`].userMessages, 1);
    assert.equal(byId[`${sidOf(3)}.jsonl`].userMessages, 1);
    assert.equal(byId[`${sidOf(2)}.jsonl`].corrections, 1, 'a prompt after replayed assistant lines is a correction candidate');
    assert.equal(byId[`${sidOf(3)}.jsonl`].corrections, 0);
  });

  it('gives the same totals whichever file was modified last (the file that is read first keeps the shared history)', async () => {
    setup(1_760_000_500, 1_760_000_000);
    // the first fork now owns the history; the parent has no line of its own left and is not a session
    assert.deepEqual(totals((await scanTranscripts({ projectsDir: dir })).sessions), { sessions: 2, user: 6, asst: 6, corrections: 3 });
  });

  it('drops a copy that has no line of its own, also when it sits in another project directory', async () => {
    setup();
    fs.mkdirSync(path.join(dir, 'p2-copy'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'p1', `${sidOf(1)}.jsonl`), path.join(dir, 'p2-copy', 'copy.jsonl'));
    const res = await scanTranscripts({ projectsDir: dir });
    assert.deepEqual(totals(res.sessions), { sessions: 3, user: 6, asst: 6, corrections: 3 });
    assert.equal(res.scanned, 4);
  });

  it('is stable through the cache: the second scan reads the cache and returns the same sessions', async () => {
    setup();
    const first = await scanTranscripts({ projectsDir: dir, cacheDir });
    const second = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.equal(second.cached, 3);
    assert.deepEqual(second.sessions, first.sessions);
    assert.deepEqual(totals(second.sessions), { sessions: 3, user: 6, asst: 6, corrections: 3 });
  });

  it('keeps the cache correct when a later fork appears', async () => {
    setup();
    await scanTranscripts({ projectsDir: dir, cacheDir });
    writeJsonl(path.join(dir, 'p1', `${sidOf(4)}.jsonl`), [...history(sidOf(4)), userLine('Rename the helper to buildUrl', { uuid: 'f4-u1', sessionId: sidOf(4), timestamp: TS('10-29', '12', '00') })]);
    const res = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.deepEqual(totals(res.sessions), { sessions: 4, user: 7, asst: 6, corrections: 3 });
  });

  it('summarizeTranscript skips the uuid keys it is given and reports the keys it counted', async () => {
    setup();
    const keys = [];
    const file = path.join(dir, 'p1', `${sidOf(1)}.jsonl`);
    const s = await summarizeTranscript(file, { keysOut: keys });
    assert.equal(s.userMessages, 4);
    assert.equal(keys.length, 8);
    const skipped = await summarizeTranscript(file, { skipKeys: new Set(keys.slice(0, 4)) });
    assert.equal(skipped.userMessages, 2);
  });
});

describe('the --days window works on line timestamps', () => {
  const SINCE = Date.parse('2026-10-01T00:00:00.000Z');
  const lines = () => [
    userLine('Old prompt about the legacy exporter', { uuid: 'o-u1', timestamp: TS('08-01') }),
    asstText('o1', { timestamp: TS('08-01', '09', '01') }),
    userLine('No, that is wrong, do it again', { uuid: 'o-u2', timestamp: TS('08-01', '09', '02') }),
    asstText('o2', { timestamp: TS('08-01', '09', '03') }),
    { type: 'attachment', uuid: 'o-h1', timestamp: TS('08-01', '09', '04'), attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: 'node old-hook.mjs', durationMs: 5 } },
    { type: 'last-prompt', lastPrompt: 'x' },
    userLine('Fresh prompt about the new importer', { uuid: 'n-u1', timestamp: TS('10-29') }),
    asstText('n1', { timestamp: TS('10-29', '09', '01') }),
    userLine('No, that is wrong, use streams', { uuid: 'n-u2', timestamp: TS('10-29', '09', '02') }),
    asstText('n2', { timestamp: TS('10-29', '09', '03') }),
  ];
  const projectWith = (ls) => {
    const dir = path.join(makeTempDir('kaizen-win-'), 'projects');
    writeJsonl(path.join(dir, 'p', 's.jsonl'), ls);
    return dir;
  };

  it('summarizeTranscript counts only the lines stamped inside the window and marks the summary', async () => {
    const dir = projectWith(lines());
    const s = await summarizeTranscript(path.join(dir, 'p', 's.jsonl'), { sinceMs: SINCE });
    assert.equal(s.userMessages, 2);
    assert.equal(s.assistantMessages, 2);
    assert.equal(s.corrections, 1);
    assert.equal(s.startedAt, TS('10-29'));
    assert.equal(s.hooks.hookRuns, 0, 'an old hook attachment is outside the window as well');
    assert.deepEqual(Object.keys(s.promptStems), ['fresh prompt about the new importer', 'no that is wrong use streams']);
    assert.equal(s.winStart, SINCE);
    assert.equal(s.windowCut, true);
    assert.equal(s.minTs, Date.parse(TS('10-29')));
  });

  it('without a window every line counts', async () => {
    const dir = projectWith(lines());
    const s = await summarizeTranscript(path.join(dir, 'p', 's.jsonl'));
    assert.equal(s.userMessages, 4);
    assert.equal(s.windowCut, false);
    assert.equal(s.hooks.hookRuns, 1);
  });

  it('a file with a fresh mtime but only old lines is scanned and yields no session', async () => {
    const dir = projectWith(lines().slice(0, 6));
    const res = await scanTranscripts({ projectsDir: dir, sinceMs: SINCE });
    assert.equal(res.scanned, 1);
    assert.deepEqual(res.sessions, []);
  });

  it('a long-lived session keeps only its in-window part, and activeDays-style fields come from it', async () => {
    const dir = projectWith(lines());
    const res = await scanTranscripts({ projectsDir: dir, sinceMs: SINCE });
    assert.equal(res.sessions.length, 1);
    assert.equal(res.sessions[0].userMessages, 2);
    assert.equal(res.sessions[0].startedAt, TS('10-29'));
  });

  it('counts the first in-window prompt as a correction when an assistant turn before the window preceded it', async () => {
    const dir = projectWith([
      userLine('Build the exporter', { uuid: 'a-u1', timestamp: TS('08-01') }),
      asstText('a1', { timestamp: TS('08-01', '09', '01') }),
      userLine('No, that is wrong, do it again', { uuid: 'a-u2', timestamp: TS('10-29') }),
    ]);
    const s = await summarizeTranscript(path.join(dir, 'p', 's.jsonl'), { sinceMs: SINCE });
    assert.equal(s.corrections, 1);
  });

  it('reuses a cached summary only when it still answers the window, and rebuilds it otherwise', async () => {
    const dir = projectWith(lines());
    const cacheDir = path.join(path.dirname(dir), 'cache');
    const at = (d) => Date.parse(`2026-${d}T00:00:00.000Z`);
    const run = (sinceMs) => scanTranscripts({ projectsDir: dir, cacheDir, sinceMs });

    let r = await run(at('10-01'));
    assert.equal(r.cached, 0);
    assert.equal(r.sessions[0].userMessages, 2);
    r = await run(at('10-01'));
    assert.equal(r.cached, 1, 'the same window reads the cache');

    r = await run(at('07-01'));
    assert.equal(r.cached, 0, 'a longer window needs the lines that were left out');
    assert.equal(r.sessions[0].userMessages, 4);
    r = await run(at('10-20'));
    assert.equal(r.cached, 0, 'a shorter window must not keep the older lines');
    assert.equal(r.sessions[0].userMessages, 2);
    r = await run(at('10-28'));
    assert.equal(r.cached, 1, 'every counted line is inside the shorter window: the cache is exact');
    assert.equal(r.sessions[0].userMessages, 2);
    r = await run(at('10-30'));
    assert.equal(r.cached, 0, 'lines of the cached summary fall out of this window');
    assert.deepEqual(r.sessions, []);
  });

  it('a window that cuts nothing is cached once for any window that reaches back further', async () => {
    const dir = projectWith(lines().slice(6));
    const cacheDir = path.join(path.dirname(dir), 'cache');
    await scanTranscripts({ projectsDir: dir, cacheDir, sinceMs: Date.parse('2026-10-01T00:00:00.000Z') });
    const r = await scanTranscripts({ projectsDir: dir, cacheDir, sinceMs: Date.parse('2026-01-01T00:00:00.000Z') });
    assert.equal(r.cached, 1);
    assert.equal(r.sessions[0].userMessages, 2);
  });

  it('keeps lines that have no timestamp', async () => {
    const dir = projectWith([{ type: 'user', uuid: 'x1', message: { role: 'user', content: 'a prompt without any timestamp' } }]);
    const s = await summarizeTranscript(path.join(dir, 'p', 's.jsonl'), { sinceMs: SINCE });
    assert.equal(s.userMessages, 1);
  });
});

describe('the PowerShell tool feeds the shell metrics like Bash', () => {
  const run = async (tool) => {
    const ps = (id, name, input) => asstTools(id, [useTool(id, name, input)], { timestamp: TS('10-29', '09', '00', '00') });
    const result = (id, content, isError, sec) => userLine([resultOf(id, content, isError)], { uuid: `ur-${id}`, timestamp: TS('10-29', '09', '01', sec) });
    return summarizeLines([
      ps('e1', 'Edit', { file_path: 'src/a.js', old_string: 'a', new_string: 'b' }),
      ps('t1', tool, { command: 'npm test' }),
      result('t1', 'FAIL src/a.test.js\nTests: 1 failed, 2 passed', true, '00'),
      ps('g1', tool, { command: 'git commit -m fix' }),
      result('g1', 'done', false, '00'),
      ps('d1', tool, { command: 'Remove-Item -Recurse -Force build' }),
      result('d1', 'done', false, '00'),
      ps('f1', tool, { command: 'git push --force origin main' }),
      result('f1', 'done', false, '00'),
    ]);
  };

  it('counts test runs, git, destructive commands, force pushes and test failures for PowerShell exactly as for Bash', async () => {
    const ps = await run('PowerShell');
    const bash = await run('Bash');
    for (const s of [ps, bash]) {
      assert.equal(s.testCommands, 1);
      assert.equal(s.testFailures, 1);
      assert.deepEqual(s.errorClasses, { 'test-failure': 1 });
      assert.equal(s.forcePushes, 1);
      assert.equal(s.destructive, 1);
      assert.deepEqual(s.git, { commit: 1, push: 1 });
    }
    const verbs = { 'npm test': 1, 'git commit': 1, 'Remove-Item': 1, 'git push': 1 };
    assert.deepEqual(bash.bashVerbs, verbs);
    assert.deepEqual(bash.powershellVerbs, {});
    // PowerShell verbs are not Bash verbs: no Bash(...) allow rule is built from them
    assert.deepEqual(ps.bashVerbs, {});
    assert.deepEqual(ps.powershellVerbs, verbs);
    assert.deepEqual(ps.toolUses, { Edit: 1, PowerShell: 4 });
  });

  it('puts a slow PowerShell command into the slow-command list', async () => {
    const s = await summarizeLines([
      asstTools('s1', [useTool('sl1', 'PowerShell', { command: 'dotnet build' })], { timestamp: TS('10-29', '09', '00', '00') }),
      userLine([resultOf('sl1', 'ok')], { uuid: 'ur-sl1', timestamp: TS('10-29', '09', '01', '10') }),
    ]);
    assert.equal(s.slowCommandCount, 1);
    assert.deepEqual(s.slowCommands, [{ verb: 'dotnet build', ms: 70000 }]);
  });

  it('flags the PowerShell forms of a recursive force delete, and nothing harmless', async () => {
    const destructive = async (command) => (await summarizeLines([asstTools('x', [useTool('x', 'PowerShell', { command })])])).destructive;
    for (const c of ['Remove-Item -Recurse -Force C:\\work\\build', 'Remove-Item build -Force -Recurse', 'remove-item -r -fo ./dist', 'rm -Recurse -Force node_modules', 'ri .\\out -Recurse -Force']) {
      assert.equal(await destructive(c), 1, c);
    }
    for (const c of ['Remove-Item temp.txt', 'Remove-Item -Recurse build', 'Get-ChildItem -Recurse -Force', 'Get-Process | Where-Object Name -eq node']) {
      assert.equal(await destructive(c), 0, c);
    }
  });
});

describe('turns that Claude Code sent to itself are not prompts', () => {
  const scheduled = '<system-reminder>The user is not present.</system-reminder><scheduled-task>This is an automated run of a scheduled task. Run the nightly report for the team and email it to everyone.</scheduled-task>';

  it('skips a scheduled-task trigger by its origin', async () => {
    const s = await summarizeLines([
      userLine(scheduled, { uuid: 'u1', origin: { kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: 'scheduled' }, promptSource: 'system' }),
      userLine('Fix the typo in the readme', { uuid: 'u2', origin: { kind: 'human' } }),
    ]);
    assert.equal(s.userMessages, 1);
    assert.deepEqual(s.promptLengths, ['Fix the typo in the readme'.length]);
    assert.deepEqual(Object.keys(s.promptStems), ['fix the typo in the readme']);
    assert.equal(s.langSample.length, 1);
  });

  it('skips a scheduled-task body also when the line has no origin (older versions)', async () => {
    const s = await summarizeLines([userLine(scheduled, { uuid: 'u1' }), userLine('Fix the typo in the readme', { uuid: 'u2' })]);
    assert.equal(s.userMessages, 1);
    assert.equal(humanText(scheduled), '');
  });

  it('three runs of the same scheduled task never become a repeated stem', async () => {
    const lines = [1, 2, 3].map((i) => userLine(scheduled, { uuid: `u${i}`, origin: { kind: 'task-notification', subkind: 'scheduled-trigger' }, promptSource: 'system' }));
    const s = await summarizeLines(lines);
    assert.equal(s.userMessages, 0);
    assert.deepEqual(s.promptStems, {});
    assert.equal(s.hours.reduce((a, b) => a + b, 0), 0);
  });

  it('skips peer, coordinator and task-notification turns but keeps human ones and lines from before `origin` existed', async () => {
    const s = await summarizeLines([
      userLine('please review my branch now', { uuid: 'u1', origin: { kind: 'peer' } }),
      userLine('split the work between the workers', { uuid: 'u2', origin: { kind: 'coordinator' } }),
      userLine('the build finished with warnings', { uuid: 'u3', origin: { kind: 'task-notification' } }),
      userLine('Add a settings page to the app', { uuid: 'u4', origin: { kind: 'human' } }),
      userLine('Rename the helper to buildUrl', { uuid: 'u5' }),
      userLine('a system generated reminder text here', { uuid: 'u6', promptSource: 'system' }),
    ]);
    assert.equal(s.userMessages, 2);
    assert.deepEqual(Object.keys(s.promptStems).sort(), ['add a settings page to the', 'rename the helper to buildurl']);
  });

  it('still reads tool results of a line that carries an origin', async () => {
    const s = await summarizeLines([
      asstTools('t', [useTool('t1', 'Bash', { command: 'npm test' })]),
      userLine([resultOf('t1', 'Tests: 1 failed', true)], { uuid: 'u1', origin: { kind: 'human' } }),
    ]);
    assert.equal(s.testFailures, 1);
  });
});

describe('corrections need something to correct', () => {
  it('does not count an instruction-style opening prompt of a session', async () => {
    const s = await summarizeLines([
      userLine('Do not use any tools. From the skill list in your context, print ONLY the names.', { uuid: 'u1' }),
      asstText('1'),
    ]);
    assert.equal(s.userMessages, 1);
    assert.equal(s.corrections, 0);
    assert.deepEqual(s.correctionSamples, []);
  });

  it('counts the same words once Claude has answered', async () => {
    const s = await summarizeLines([
      userLine('Always write the changelog entry first', { uuid: 'u1' }),
      asstText('1'),
      userLine('Do not use any tools for this one', { uuid: 'u2' }),
    ]);
    assert.equal(s.corrections, 1);
    assert.ok(s.correctionSamples[0].startsWith('Do not use any tools'));
  });

  it('does not let a subagent answer make the first prompt of the main session a correction target', async () => {
    const s = await summarizeLines([
      userLine('Never touch the lockfile', { uuid: 'u1' }),
      asstText('1', { isSidechain: true }),
    ]);
    assert.equal(s.corrections, 0);
  });
});

// Round 8: per-hook run counters, PowerShell verbs, destructive PowerShell forms, sidechain attribution, workflow subagents.

describe('hook runs are counted per event and command (the key of errorsByCommand)', () => {
  const att = (type, hookEvent, command, extra = {}) => ({ type: 'attachment', uuid: `h-${Math.random()}`, attachment: { type, hookEvent, command, durationMs: 10, ...extra } });

  it('does not let two hooks that share a script name, or one command on two events, share a run counter', async () => {
    const A = 'node "/x/broken/index.mjs"';
    const B = 'node "/x/fine/index.mjs"';
    const G = 'node "/x/guard.mjs"';
    const lines = [];
    for (let i = 0; i < 3; i++) lines.push(att('hook_non_blocking_error', 'PreToolUse', A));
    for (let i = 0; i < 10; i++) lines.push(att('hook_success', 'PostToolUse', B));
    for (let i = 0; i < 2; i++) lines.push(att('hook_non_blocking_error', 'PostToolUse', G));
    for (let i = 0; i < 7; i++) lines.push(att('hook_success', 'PreToolUse', G));
    const s = await summarizeLines(lines);
    assert.deepEqual(s.hooks.runsByCommand, { [`PreToolUse|${A}`]: 3, [`PostToolUse|${B}`]: 10, [`PostToolUse|${G}`]: 2, [`PreToolUse|${G}`]: 7 });
    assert.deepEqual(s.hooks.errorsByCommand, { [`PreToolUse|${A}`]: 3, [`PostToolUse|${G}`]: 2 });
    assert.equal(s.hooks.durations['index.mjs'].n, 13, 'the by-script counter still mixes the two hooks: that is why rates do not use it');
  });

  it('counts a Stop hook run from its summary under the Stop event, once, and a cancelled run as a run', async () => {
    const cmd = 'node "/x/notify.mjs"';
    const s = await summarizeLines([
      att('hook_success', 'Stop', cmd),
      { type: 'system', subtype: 'stop_hook_summary', uuid: 'h2', hookCount: 1, hookInfos: [{ command: cmd, durationMs: 20 }], hookErrors: [] },
      att('hook_success', 'SubagentStop', cmd),
      att('hook_cancelled', 'PreToolUse', cmd, { timedOut: true, timeoutMs: 5000 }),
    ]);
    assert.deepEqual(s.hooks.runsByCommand, { [`Stop|${cmd}`]: 1, [`PreToolUse|${cmd}`]: 1 });
  });

  it('keeps the run count of every hook that has an error entry when the run map is trimmed', async () => {
    const lines = [att('hook_non_blocking_error', 'PreToolUse', 'node "/x/rare.mjs"')];
    for (let i = 0; i < 150; i++) lines.push(att('hook_success', 'PostToolUse', `node "/x/busy-${i}.mjs"`));
    const s = await summarizeLines(lines);
    assert.equal(s.hooks.runsByCommand['PreToolUse|node "/x/rare.mjs"'], 1);
    assert.ok(Object.keys(s.hooks.runsByCommand).length <= 101);
  });
});

describe('powershellVerb', () => {
  it('reads the command behind the call operator, quoted paths, environment assignments and Set-Location prefixes', () => {
    assert.equal(powershellVerb('& "C:\\Program Files\\nodejs\\npm.cmd" test'), 'npm test');
    assert.equal(powershellVerb('$env:CI=1; npm test'), 'npm test');
    assert.equal(powershellVerb('Set-Location C:\\work; git status'), 'git status');
    assert.equal(powershellVerb('cd "C:\\my work"; git diff --stat'), 'git diff');
    assert.equal(powershellVerb('Get-ChildItem -Recurse'), 'Get-ChildItem');
    assert.equal(powershellVerb('dotnet.exe build'), 'dotnet build');
  });

  it('answers (script) instead of a garbage verb for fragments that are not a command name', () => {
    for (const c of ["'PS5CameraDriver'; Get-Date", '$x = 1', '$(Get-Date).Year', '"unterminated']) {
      assert.match(powershellVerb(c), /^(\(script\)|[\w.@-]+( [\w.:@-]+)?)$/, c);
    }
    for (const bad of ['&', '$env:CI=1;']) assert.notEqual(powershellVerb(`${bad} npm test`), bad);
    assert.equal(powershellVerb(''), '(script)');
  });
});

describe('PowerShell commands stay out of the Bash verbs', () => {
  it('records PowerShell verbs apart and keeps PowerShell commands in the test, git, destructive and slow counters', async () => {
    const cmds = ['& "C:\\Program Files\\nodejs\\npm.cmd" ci', '$env:CI=1; npm test', 'Get-ChildItem | Remove-Item -Recurse -Force'];
    const s = await summarizeLines(cmds.map((c, i) => asstTools(`p${i}`, [useTool(`p${i}`, 'PowerShell', { command: c })])));
    assert.deepEqual(s.bashVerbs, {});
    assert.deepEqual(s.powershellVerbs, { 'npm ci': 1, 'npm test': 1, 'Get-ChildItem': 1 });
    assert.equal(s.testCommands, 1);
    assert.equal(s.destructive, 1);
    assert.equal(Object.keys(s.bashCommands).length, 3, 'repeated-command detection still sees them');
  });
});

describe('the PowerShell form of a recursive force delete is matched in command position only', () => {
  const destructive = async (command) => (await summarizeLines([asstTools('x', [useTool('x', 'PowerShell', { command })])])).destructive;

  it('does not flag a path that merely contains rd, rm or ri', async () => {
    for (const c of ['Copy-Item .\\src\\rd -Destination .\\x -Recurse -Force', 'Copy-Item C:\\a\\rm.txt D:\\ -Recurse -Force', 'Get-ChildItem .\\ri -Recurse -Force', 'Write-Host "rd -r -fo"']) {
      assert.equal(await destructive(c), 0, c);
    }
  });

  it('flags -Recurse:$true and -Force:$true, and not the explicit $false forms', async () => {
    assert.equal(await destructive('Remove-Item .\\build -Recurse:$true -Force'), 1);
    assert.equal(await destructive('Remove-Item .\\build -Recurse -Force:$true'), 1);
    assert.equal(await destructive('Remove-Item .\\build -Recurse:$false -Force'), 0);
    assert.equal(await destructive('Remove-Item .\\build -Recurse -Force:$false'), 0);
  });

  it('flags the command after a separator, a pipe, a block or inside -Command', async () => {
    for (const c of ['cd x; Remove-Item y -Recurse -Force', 'gci | % { rm $_ -r -fo }', 'powershell -Command "Remove-Item y -Recurse -Force"', 'if ($true) { Remove-Item y -Recurse -Force }']) {
      assert.equal(await destructive(c), 1, c);
    }
  });
});

describe('sidechain lines do not feed main-session counters', () => {
  const sideResult = (id, extra = {}) => userLine([resultOf(id, 'ok')], { uuid: `ur-${id}`, isSidechain: true, ...extra });

  it('keeps the permission mode, timeouts, interruptions, background tasks and manual edits of a subagent out', async () => {
    const s = await summarizeLines([
      userLine([resultOf('m1', 'ok')], { uuid: 'ur-m1', permissionMode: 'default', toolUseResult: { timedOutAfterMs: 5, interrupted: true, backgroundTaskId: 'b1', userModified: true } }),
      sideResult('s1', { permissionMode: 'bypassPermissions', toolUseResult: { timedOutAfterMs: 5, interrupted: true, backgroundTaskId: 'b2', userModified: true } }),
      sideResult('s2', { permissionMode: 'bypassPermissions' }),
    ]);
    assert.deepEqual(s.permissionModes, { default: 1 });
    assert.equal(s.toolTimeouts, 1);
    assert.equal(s.toolInterrupted, 1);
    assert.equal(s.backgroundTasks, 1);
    assert.equal(s.userModifiedEdits, 1);
  });

  it('still counts a permission decision that reached the user from a subagent', async () => {
    const s = await summarizeLines([sideResult('s1', { permissionDecision: { decision: 'accept', reasonType: 'rule', source: 'user_permanent' } })]);
    assert.deepEqual(s.permissionDecisions, { 'accept/rule/user_permanent': 1 });
  });

  it('does not count a subagent tool_result whose tool_use is unknown (outside the window) as a main-session error', async () => {
    const s = await summarizeLines([
      userLine([resultOf('gone', 'Error: ENOENT no such file', true)], { uuid: 'ur-gone', isSidechain: true }),
      userLine([resultOf('gone2', 'Error: ENOENT no such file', true)], { uuid: 'ur-gone2' }),
    ]);
    assert.deepEqual(s.toolErrors, { unknown: 1 }, 'only the main-session result is an error');
    assert.deepEqual(s.errorClasses, { 'not-found': 1 });
  });

  it('does the same for a subagent file read as a whole (its lines carry no isSidechain flag)', async () => {
    const dir = path.join(makeTempDir('kaizen-side-'), 'projects');
    writeJsonl(path.join(dir, 'p1', 'S1.jsonl'), [userLine('implement the parser for the config', { uuid: 'p-u1' })]);
    writeJsonl(path.join(dir, 'p1', 'S1', 'subagents', 'agent-1.jsonl'), [
      userLine([resultOf('lost', 'Error: ENOENT no such file', true)], { uuid: 's-u1', permissionMode: 'bypassPermissions', toolUseResult: { interrupted: true } }),
    ]);
    const s = (await scanTranscripts({ projectsDir: dir })).sessions[0];
    assert.deepEqual(s.toolErrors, {});
    assert.deepEqual(s.permissionModes, {});
    assert.equal(s.toolInterrupted, 0);
  });
});

describe('workflow subagent transcripts (<session>/subagents/workflows/<run>/agent-*.jsonl)', () => {
  const SID = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
  const mkdir = () => path.join(makeTempDir('kaizen-wf-'), 'projects');
  const main = () => [userLine('run the workflow for the release', { uuid: 'w-u1', sessionId: SID }), asstTools('w1', [useTool('ag1', 'Agent', { subagent_type: 'general-purpose', prompt: 'x' })], { sessionId: SID })];
  const agent = (n, cmd) => [asstTools(`wa${n}`, [useTool(`wb${n}`, 'Bash', { command: cmd })], { isSidechain: true, sessionId: SID })];

  it('lists agent files at the top of subagents/ and in workflows/<run>/, with a path that tells equal names apart', () => {
    const dir = mkdir();
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), main());
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'agent-top.jsonl'), agent(1, 'ls'));
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-a', 'agent-x.jsonl'), agent(2, 'ls'));
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-b', 'agent-x.jsonl'), agent(3, 'ls'));
    writeText(path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-b', 'meta.json'), '{}');
    const list = listTranscripts(dir);
    assert.equal(list.length, 1, 'the agent files are not sessions');
    assert.deepEqual(list[0].subagents.map((x) => x.rel), ['agent-top.jsonl', 'workflows/run-a/agent-x.jsonl', 'workflows/run-b/agent-x.jsonl']);
  });

  it('stops at a bounded depth', () => {
    const dir = mkdir();
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), main());
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'a', 'b', 'c', 'd', 'agent-ok.jsonl'), agent(1, 'ls'));
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'a', 'b', 'c', 'd', 'e', 'agent-deep.jsonl'), agent(2, 'ls'));
    assert.deepEqual(listTranscripts(dir)[0].subagents.map((x) => x.rel), ['a/b/c/d/agent-ok.jsonl']);
  });

  it('merges workflow agents into the parent as sidechain and counts a line shared by two agent files once', async () => {
    const dir = mkdir();
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), main());
    const shared = asstTools('shared', [useTool('sh1', 'Bash', { command: 'pytest -q' })], { isSidechain: true, sessionId: SID });
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-a', 'agent-1.jsonl'), [shared, ...agent(2, 'npm test')]);
    writeJsonl(path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-b', 'agent-1.jsonl'), [shared]);
    const res = await scanTranscripts({ projectsDir: dir });
    const s = res.sessions[0];
    assert.equal(res.sessions.length, 1);
    assert.equal(s.testCommands, 2);
    assert.equal(s.sidechainTestCommands, 2);
    assert.equal(s.sidechainMessages, 2);
    assert.equal(s.assistantMessages, 1, 'subagent responses are not main-session ones');
  });

  it('re-summarizes when only one of two same-named workflow agent files changed, and reports the bytes of all', async () => {
    const dir = mkdir();
    const cacheDir = path.join(path.dirname(dir), 'cache');
    writeJsonl(path.join(dir, 'p1', `${SID}.jsonl`), main());
    const a = path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-a', 'agent-x.jsonl');
    const b = path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-b', 'agent-x.jsonl');
    writeJsonl(a, agent(1, 'pytest -q'));
    writeJsonl(b, agent(2, 'ls'));
    const first = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.equal(first.sessions[0].sidechainTestCommands, 1);
    assert.equal((await scanTranscripts({ projectsDir: dir, cacheDir })).cached, 1);
    fs.appendFileSync(b, JSON.stringify(agent(3, 'npm test')[0]) + '\n');
    const again = await scanTranscripts({ projectsDir: dir, cacheDir });
    assert.equal(again.cached, 0);
    assert.equal(again.sessions[0].sidechainTestCommands, 2);
    const list = listTranscripts(dir)[0];
    assert.equal(again.bytes, list.size + list.subagents.reduce((n, x) => n + x.size, 0));
  });

  it('keeps a session whose only recent file is a workflow agent', () => {
    const dir = mkdir();
    const old = path.join(dir, 'p1', `${SID}.jsonl`);
    writeJsonl(old, main());
    const wf = path.join(dir, 'p1', SID, 'subagents', 'workflows', 'run-a', 'agent-1.jsonl');
    writeJsonl(wf, agent(1, 'ls'));
    fs.utimesSync(old, 1_700_000_000, 1_700_000_000);
    fs.utimesSync(wf, 1_800_000_000, 1_800_000_000);
    assert.equal(listTranscripts(dir, { sinceMs: 1_750_000_000 * 1000 }).length, 1);
  });
});

// Round 9: SubagentStop runs, PowerShell destructive forms and verbs, rule-accepted slow commands, Invoke-Pester.

describe('a stop_hook_summary inside a subagent transcript is a SubagentStop run', () => {
  const cmd = 'node "/x/subdone.mjs"';
  const att = (n, type) => ({ type: 'attachment', uuid: `sa${n}`, isSidechain: true, attachment: { type, hookName: 'SubagentStop', hookEvent: 'SubagentStop', command: cmd, durationMs: 10 } });
  const summary = (n, errs = []) => ({ type: 'system', subtype: 'stop_hook_summary', uuid: `ss${n}`, isSidechain: true, hookCount: 1, hookInfos: [{ command: cmd, durationMs: 10 }], hookErrors: errs });

  it('counts the runs under SubagentStop (the key of the errors), so the failure rate is errors / runs, not 100%', async () => {
    const dir = makeTempDir('kaizen-substop-');
    const main = path.join(dir, 'p', 's1.jsonl');
    const sub = path.join(dir, 'p', 's1', 'subagents', 'agent-a1.jsonl');
    writeJsonl(main, [userLine('hello there', { uuid: 'm0' })]);
    const lines = [];
    for (let k = 0; k < 10; k++) {
      const fail = k < 2;
      lines.push(att(k, fail ? 'hook_non_blocking_error' : 'hook_success'), summary(k, fail ? ['x'] : []));
    }
    writeJsonl(sub, lines);
    const s = await summarizeTranscript(main, { subagents: [sub] });
    assert.deepEqual(s.hooks.runsByCommand, { [`SubagentStop|${cmd}`]: 10 });
    assert.deepEqual(s.hooks.errorsByCommand, { [`SubagentStop|${cmd}`]: 2 });
  });

  it('also does so for an isSidechain summary line in the main file, and still counts a plain summary as Stop', async () => {
    const s = await summarizeLines([summary(1), { ...summary(2), isSidechain: false }]);
    assert.deepEqual(s.hooks.runsByCommand, { [`SubagentStop|${cmd}`]: 1, [`Stop|${cmd}`]: 1 });
  });
});

describe('PowerShell destructive forms after an assignment, unquoted -Command, and cmd rd /s', () => {
  const destructive = async (command) => (await summarizeLines([asstTools('x', [useTool('x', 'PowerShell', { command })])])).destructive;

  it('flags them', async () => {
    for (const c of ['$null = Remove-Item .\\b -Recurse -Force', '$x=Remove-Item .\\b -Recurse -Force', 'pwsh -NoProfile -Command Remove-Item .\\b -Recurse -Force', 'powershell -Command Remove-Item b -r -fo', 'rd /s /q C:\\work\\build', 'cmd /c rd /s /q build', 'rd /q /s build', 'rmdir /q /s build', 'cmd /c "rd /s /q build"', 'cd x; del /f /s /q *.log']) {
      assert.equal(await destructive(c), 1, c);
    }
  });

  it('keeps the path false positives fixed', async () => {
    for (const c of ['xcopy .\\src\\rd /s /i .\\out', 'dir .\\docs\\rd /s', 'robocopy C:\\a\\rd /s C:\\b', 'Copy-Item .\\src\\rd -Destination .\\x -Recurse -Force','Get-ChildItem .\\ri -Recurse -Force', 'Write-Host "rd -r -fo"', '$a = Get-Item .\\rm -Recurse -Force', 'Set-Content rd.txt -Value x -Force', 'Remove-Item temp.txt']) {
      assert.equal(await destructive(c), 0, c);
    }
  });
});

describe('powershellVerb reads only the first statement', () => {
  it('cuts at the first unquoted ; or |', () => {
    assert.equal(powershellVerb('git status; git diff'), 'git status');
    assert.equal(powershellVerb('npm test | Select-Object -Last 5'), 'npm test');
    assert.equal(powershellVerb('Push-Location x; npm test; Pop-Location'), 'npm test');
    assert.equal(powershellVerb('Write-Host "a"; git status'), 'Write-Host');
    assert.equal(powershellVerb('git status\ngit diff'), 'git status');
  });

  it('does not cut inside quotes', () => {
    assert.equal(powershellVerb('& "C:\\Program Files (x86)\\a;b\\tool.exe" run; git status'), 'tool');
    assert.equal(powershellVerb('& "C:\\Program Files\\Git\\bin\\git.exe" status'), 'git status');
    assert.equal(powershellVerb("git commit -m 'a; b'"), 'git commit');
  });
});

describe('slow commands accepted by a saved rule are not a wait for the user', () => {
  const at = (sec) => new Date(Date.UTC(2026, 9, 29, 9, 0, 0) + sec * 1000).toISOString();
  const run = (id, startSec, decision) => [
    { ...asstTools(id, [useTool(id, 'Bash', { command: 'npm run build' })]), timestamp: at(startSec) },
    { ...userLine([resultOf(id, 'ok')], { uuid: `ur-${id}` }), timestamp: at(startSec + 90), permissionDecision: decision },
  ];

  it('keeps a rule-accepted command (accept/rule/user_permanent) and drops a prompt answered by the user', async () => {
    const s = await summarizeLines([
      ...run('r1', 0, { decision: 'accept', reasonType: 'rule', source: 'user_permanent' }),
      ...run('r2', 200, { decision: 'accept', reasonType: 'prompt', source: 'user_temporary' }),
    ]);
    assert.deepEqual(s.slowCommands, [{ verb: 'npm run', ms: 90000 }]);
    assert.equal(s.slowCommandCount, 1);
  });
});

describe('Invoke-Pester is a test run', () => {
  it('counts it for PowerShell, and for a subagent as a sidechain test run', async () => {
    const s = await summarizeLines([
      asstTools('p1', [useTool('p1', 'PowerShell', { command: 'Invoke-Pester -Path .\\tests' })]),
      asstTools('p2', [useTool('p2', 'PowerShell', { command: 'invoke-pester' })], { isSidechain: true }),
      asstTools('p3', [useTool('p3', 'PowerShell', { command: 'INVOKE-PESTER ./t' })]),
    ]);
    assert.equal(s.testCommands, 3);
    assert.equal(s.sidechainTestCommands, 1);
  });
});

describe('hook runs Claude Code does not record (round 8)', () => {
  const att = (type, extra, command = 'node "/x/fmt.mjs"') => ({ type: 'attachment', uuid: `h-${Math.random()}`, attachment: { type, command, durationMs: 10, ...extra } });

  it('bumps the summary version so that caches written without the opportunity counters are rebuilt', () => {
    assert.ok(SUMMARY_VERSION >= 24, String(SUMMARY_VERSION));
    const hooks = newSessionSummary('/p/s.jsonl').hooks;
    assert.deepEqual(hooks.opps, { toolUses: {}, toolFailures: {} });
    assert.deepEqual(hooks.oppsSince, {});
  });

  it('puts an attachment that names the event only in hookName (PostToolUse:Edit) under the same key as one with hookEvent', async () => {
    const cmd = 'node "/x/fmt.mjs"';
    const s = await summarizeLines([att('hook_non_blocking_error', { hookName: 'PostToolUse:Edit' }), att('hook_success', { hookName: 'PostToolUse:Write', hookEvent: 'PostToolUse' }), att('hook_success', { hookName: 'PostToolUse:Edit' })]);
    assert.deepEqual(s.hooks.errorsByCommand, { [`PostToolUse|${cmd}`]: 1 });
    assert.deepEqual(s.hooks.runsByCommand, { [`PostToolUse|${cmd}`]: 3 });
  });

  it('counts the tool uses (main session and subagents) and the failed ones by tool name, as the runs a tool hook had the chance to make', async () => {
    const s = await summarizeLines([
      asstTools('m1', [useTool('t1', 'Edit', { file_path: '/x/a.js' }), useTool('t2', 'Bash', { command: 'ls' })]),
      asstTools('m2', [useTool('t3', 'Edit', { file_path: '/x/b.js' })], { isSidechain: true }),
      userLine([resultOf('t1', 'ok'), resultOf('t2', 'Error: ENOENT no such file', true)], { uuid: 'u-r1' }),
      userLine([resultOf('t3', 'old_string not found', true)], { uuid: 'u-r2', isSidechain: true }),
    ]);
    assert.deepEqual(s.hooks.opps, { toolUses: { Edit: 2, Bash: 1 }, toolFailures: { Bash: 1, Edit: 1 } });
    assert.deepEqual(s.toolUses, { Edit: 1, Bash: 1 }, 'the main-session counter is unchanged');
  });

  it('remembers the counters at the first record of a hook in the session, and only for hooks that left a record', async () => {
    const cmd = 'node "/x/fmt.mjs"';
    const s = await summarizeLines([
      userLine('please edit the files', { uuid: 'since-u1' }),
      asstTools('s1', [useTool('s1', 'Edit', { file_path: '/x/a.js' }), useTool('s2', 'Bash', { command: 'ls' })]),
      userLine([resultOf('s1', 'ok'), resultOf('s2', 'Error: boom', true)], { uuid: 'since-r1' }),
      att('hook_non_blocking_error', { hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse' }),
      asstTools('s3', [useTool('s3', 'Edit', { file_path: '/x/b.js' })]),
      att('hook_success', { hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse' }),
    ]);
    assert.deepEqual(s.hooks.oppsSince, { [`PostToolUse|${cmd}`]: { toolUses: { Edit: 1, Bash: 1 }, toolFailures: { Bash: 1 }, prompts: 1, compactions: 0 } }, 'taken once, at the first record');
    assert.deepEqual(s.hooks.opps.toolUses, { Edit: 2, Bash: 1 });
  });

  it('does not take a snapshot for a Stop hook (its runs are counted exactly from the summary line)', async () => {
    const s = await summarizeLines([att('hook_success', { hookName: 'Stop', hookEvent: 'Stop' })]);
    assert.deepEqual(s.hooks.oppsSince, {});
  });

  it('leaves the tool uses before the window out of the opportunity counters, like every other counter', async () => {
    const dir = path.join(makeTempDir('kaizen-opps-'), 'projects');
    writeJsonl(path.join(dir, 'p', 's.jsonl'), [
      asstTools('o1', [useTool('o1', 'Edit', { file_path: '/x/a.js' })], { timestamp: TS('08-01') }),
      asstTools('n1', [useTool('n1', 'Edit', { file_path: '/x/a.js' })], { timestamp: TS('10-29') }),
    ]);
    const res = await scanTranscripts({ projectsDir: dir, sinceMs: Date.parse('2026-10-01T00:00:00Z'), useCache: false });
    assert.deepEqual(res.sessions[0].hooks.opps.toolUses, { Edit: 1 });
  });
});

describe('cost-state totals are cumulative per session (round 8)', () => {
  const SID = '0000000a-ffff-4fff-8fff-ffffffffffff';
  const cost = (total, lines, sid = SID) => ({ type: 'cost-state', sessionId: sid, totalCostUSD: total, totalLinesAdded: lines, totalLinesRemoved: 1 });
  const base = (sid = SID) => [
    userLine('Add a login page for the app', { uuid: 'c-u1', sessionId: sid, timestamp: TS('10-10', '09', '00') }),
    asstText('c1', { sessionId: sid, timestamp: TS('10-10', '09', '01') }),
    userLine('Deploy the service to staging and report back', { uuid: 'c-u2', sessionId: sid, timestamp: TS('10-20', '09', '00') }),
    asstText('c2', { sessionId: sid, timestamp: TS('10-20', '09', '01') }),
  ];
  const scan = async (files, opts = {}) => {
    const dir = path.join(makeTempDir('kaizen-cost-'), 'projects');
    for (const [rel, ls] of Object.entries(files)) writeJsonl(path.join(dir, rel), ls);
    return scanTranscripts({ projectsDir: dir, useCache: false, ...opts });
  };
  const costOf = (res) => res.sessions.reduce((n, s) => n + (s.costUSD || 0), 0);
  const linesOf = (res) => res.sessions.reduce((n, s) => n + s.linesAdded, 0);

  it('counts a relocated copy of a session once: the larger total, not the sum of both files', async () => {
    const res = await scan({
      'p1/a.jsonl': [...base(), cost(5, 10)],
      'p2/a.jsonl': [...base(), userLine('One more thing to do here', { uuid: 'c-u3', sessionId: SID, timestamp: TS('10-25', '09', '00') }), asstText('c3', { sessionId: SID, timestamp: TS('10-25', '09', '01') }), cost(6, 12)],
    });
    assert.equal(costOf(res), 6);
    assert.equal(linesOf(res), 12);
    assert.equal(res.sessions.filter((s) => typeof s.costUSD === 'number').length, 1);
  });

  it('keeps the total when the copy that holds it has no messages of its own left', async () => {
    const res = await scan({ 'p1/a.jsonl': [...base(), cost(5, 10)], 'p2/a.jsonl': [...base(), cost(6, 12)] });
    assert.equal(res.sessions.length, 1, 'the second copy replays nothing new');
    assert.equal(res.sessions[0].costUSD, 6);
    assert.equal(res.sessions[0].linesAdded, 12);
  });

  it('keys a cost-state line without its own sessionId by the session of the lines around it', async () => {
    const bare = (total) => ({ type: 'cost-state', totalCostUSD: total, totalLinesAdded: 3, totalLinesRemoved: 0 });
    const res = await scan({
      'p1/a.jsonl': [...base(), bare(5)],
      'p2/a.jsonl': [...base(), userLine('One more thing to do here', { uuid: 'c-u3', sessionId: SID, timestamp: TS('10-25', '09', '00') }), bare(7)],
    });
    assert.equal(costOf(res), 7);
  });

  it('keeps the cost of different sessions apart, a fork with a session id of its own included', async () => {
    const FORK = '0000000b-ffff-4fff-8fff-ffffffffffff';
    const res = await scan({
      'p1/a.jsonl': [...base(), cost(5, 10)],
      'p1/b.jsonl': [...base(FORK), userLine('Fork work that is new here', { uuid: 'f-u1', sessionId: FORK, timestamp: TS('10-26', '09', '00') }), cost(2, 4, FORK)],
    });
    assert.equal(costOf(res), 7);
  });

  it('marks the cost of a session that began before the window as whole-session cost', async () => {
    const SINCE = Date.parse('2026-10-15T00:00:00Z');
    const inside = '0000000c-ffff-4fff-8fff-ffffffffffff';
    const res = await scan(
      {
        'p1/a.jsonl': [...base(), cost(5, 10)],
        'p1/c.jsonl': [userLine('A session entirely inside the window', { uuid: 'i-u1', sessionId: inside, timestamp: TS('10-21', '09', '00') }), asstText('i1', { sessionId: inside, timestamp: TS('10-21', '09', '01') }), cost(1, 2, inside)],
      },
      { sinceMs: SINCE },
    );
    const byFile = Object.fromEntries(res.sessions.map((s) => [s.file, s]));
    assert.equal(byFile['a.jsonl'].userMessages, 1, 'only the line inside the window is counted');
    assert.equal(byFile['a.jsonl'].costUSD, 5, 'but the cost is the whole session');
    assert.equal(byFile['a.jsonl'].windowCut, true);
    assert.equal(byFile['c.jsonl'].windowCut, false);
  });

  it('remembers that some copy of a session had lines before the window', async () => {
    const SINCE = Date.parse('2026-10-15T00:00:00Z');
    const res = await scan({ 'p1/a.jsonl': [...base(), cost(5, 10)], 'p2/a.jsonl': [...base(), cost(5, 10)] }, { sinceMs: SINCE });
    assert.equal(res.sessions.length, 1);
    assert.equal(res.sessions[0].costWindowCut, true);
  });
});
