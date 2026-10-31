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

  it('keeps subagent edits out of filesEdited and extensions, like subagent test runs', async () => {
    const s = await summarizeLines([
      asst('1', [toolUse('e1', 'Edit', { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' }), toolUse('b1', 'Bash', { command: 'npm test' })], { isSidechain: true }),
      asst('2', [toolUse('e2', 'Write', { file_path: '/w/src/main.py', content: 'x' })]),
    ]);
    assert.equal(s.filesEdited, 1);
    assert.deepEqual(s.extensions, { '.py': 1 });
    assert.equal(s.testCommands, 0);
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
    write('proj1/older/subagents/agent-1.jsonl', '{"type":"user"}\n', 1_800_000_300);
    write('proj2/other.jsonl', '{"type":"user"}\n', 1_750_000_000);
    write('stray.jsonl', '{"type":"user"}\n', 1_800_000_400);
  });

  it('lists *.jsonl files of project directories, oldest first', () => {
    const names = listTranscripts(projects).map((f) => path.basename(f.file));
    assert.deepEqual(names, ['older.jsonl', 'other.jsonl', 'newer.jsonl']);
  });

  it('skips empty files, non-jsonl files, nested subagent transcripts and files outside project directories', () => {
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
