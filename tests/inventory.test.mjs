// scripts/lib/inventory.mjs: what the user's Claude Code configuration looks like right now.
// The fixture home (tests/fixtures/claude-home + claude.json) is copied to a temp dir and selected through
// CLAUDE_CONFIG_DIR / HOME / USERPROFILE; scenario tests build their own small configurations next to it.
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { claudeMdHints, estimateTokens, inventory } from '../scripts/lib/inventory.mjs';
import { cleanupTempDirs, makeTempDir, materializeHome, setEnv, writeJson, writeText } from './helpers.mjs';

let home;
let restoreEnv;

beforeEach(() => {
  home = materializeHome();
  restoreEnv = setEnv({ ...home.env, CLAUDE_PROJECT_DIR: undefined, KAIZEN_MANAGED_SETTINGS_DIR: path.join(home.root, 'managed') });
});
afterEach(() => restoreEnv());
after(() => cleanupTempDirs());

describe('estimateTokens', () => {
  it('is zero for empty text', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(null), 0);
  });

  it('counts about four characters per token for English text', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });

  it('counts Cyrillic text denser, 2.5 characters per token', () => {
    assert.equal(estimateTokens('я'.repeat(400)), 160);
  });

  it('blends the two by the share of Cyrillic characters', () => {
    const text = 'я'.repeat(200) + 'a'.repeat(200); // half Cyrillic: 400 / 3.25
    assert.equal(estimateTokens(text), Math.round(400 / 3.25));
  });
});

describe('claudeMdHints', () => {
  const only = (text, key) => claudeMdHints(text)[key];

  it('is all false for empty or missing text', () => {
    for (const text of ['', undefined, null]) assert.deepEqual(claudeMdHints(text), { language: false, tests: false, commits: false, autonomy: false, readBeforeEdit: false, verification: false });
  });

  describe('English', () => {
    const cases = {
      language: ['Always answer in English.', 'Respond in Spanish when asked in Spanish', 'language: de'],
      tests: ['Run the tests before committing.', 'Execute tests after every change', 'Tests must pass'],
      commits: ['Commit message style: conventional commits', 'commits follow this format', 'Co-Authored-By lines are required'],
      autonomy: ["Don't ask for confirmation", 'Work without asking me', 'Act autonomously'],
      readBeforeEdit: ['Read the file again before you edit it', 'Always re-read a file first'],
      verification: ['Verify before saying done', 'Run a verification step', 'Before claiming done, check the output', 'See ship-check'],
    };
    for (const [key, texts] of Object.entries(cases)) {
      for (const text of texts) {
        it(`recognises ${key}: "${text}"`, () => assert.equal(only(text, key), true));
      }
    }

    it('does not mix the topics up', () => {
      assert.equal(only('Always answer in English.', 'tests'), false);
      assert.equal(only('Run the tests before committing.', 'language'), false);
      assert.equal(only('The service answers requests quickly', 'language'), false);
    });
  });

  describe('Russian', () => {
    const cases = {
      language: ['Отвечай всегда на русском языке', 'Всегда отвечай по-русски', 'Отвечай на русском', 'Язык ответов: русский'],
      tests: ['Запускай тесты перед коммитом', 'Прогоняй тесты после правок', 'Перед коммитом запусти тесты'],
      commits: ['Коммиты пиши в стиле conventional commits', 'Коммит должен иметь понятное сообщение'],
      autonomy: ['Не спрашивай подтверждения, действуй автономно', 'Работай без подтверждения'],
      readBeforeEdit: ['Перед правкой файла перечитай его', 'Перед редактированием прочитай файл ещё раз'],
      verification: ['Перед словом «готово» проверь результат', 'Всегда проверь результат командой'],
    };
    for (const [key, texts] of Object.entries(cases)) {
      for (const text of texts) {
        it(`recognises ${key}: "${text}"`, () => assert.equal(only(text, key), true));
      }
    }

    it('does not fire on unrelated Russian text', () => {
      const text = 'Сервис хранит настройки в каталоге config и пишет логи в формате JSON.';
      assert.deepEqual(claudeMdHints(text), { language: false, tests: false, commits: false, autonomy: false, readBeforeEdit: false, verification: false });
    });
  });
});

describe('inventory of the fixture home', () => {
  let inv;
  before(() => {
    const boot = materializeHome();
    const restore = setEnv({ ...boot.env, CLAUDE_PROJECT_DIR: undefined });
    try {
      inv = inventory({ projectDir: null });
    } finally {
      restore();
    }
  });

  it('knows where it looked', () => {
    assert.equal(inv.projectDir, null);
    assert.ok(inv.configDir.endsWith('.claude'));
  });

  it('reads the user settings file only (no project)', () => {
    assert.equal(inv.settings.length, 1);
    assert.equal(inv.settings[0].scope, 'user');
    assert.ok(inv.settings[0].file.endsWith('settings.json'));
  });

  it('summarizes hooks per event with matcher, timeout and async flag', () => {
    assert.equal(inv.hooks.total, 2);
    assert.deepEqual(inv.hooks.events, { PostToolUse: 1, Stop: 1 });
    assert.deepEqual(
      inv.hooks.commands.map(({ scope, event, matcher, type, command, timeout, async }) => ({ scope, event, matcher, type, command, timeout, async })),
      [
        { scope: 'user', event: 'PostToolUse', matcher: 'Edit|Write', type: 'command', command: 'npx prettier --write', timeout: 30, async: false },
        { scope: 'user', event: 'Stop', matcher: '', type: 'command', command: 'node "C:/Program Files/nodejs/node.exe" x.mjs', timeout: null, async: false },
      ],
    );
  });

  it('counts permission rules and keeps their text', () => {
    assert.deepEqual(inv.permissions, { allow: 2, deny: 0, ask: 0, defaultMode: 'default', allowRules: ['Bash(git diff:*)', 'Read(./docs/**)'], denyRules: [] });
  });

  it('masks environment values whose names look like secrets', () => {
    assert.deepEqual(inv.settings[0].env, { DEMO_API_KEY: '[masked]', LOG_LEVEL: 'debug' });
  });

  it('separates enabled and disabled plugins', () => {
    assert.deepEqual(inv.settings[0].enabledPlugins, ['demo@fixture-market', 'idle@fixture-market']);
    assert.deepEqual(inv.settings[0].disabledPlugins, ['retired@fixture-market']);
  });

  it('reports no status line, language or cleanup period', () => {
    assert.equal(inv.statusLine, false);
    assert.equal(inv.settings[0].language, null);
    assert.equal(inv.settings[0].cleanupPeriodDays, null);
  });

  it('lists user skills and plugin skills with their source', () => {
    // user skills come in directory-listing order (differs between file systems); plugin skills follow, in plugin order
    assert.deepEqual(inv.skills.filter((s) => s.source === 'user').map((s) => s.name).sort(), ['demo-skill', 'idle-skill']);
    assert.deepEqual(inv.skills.filter((s) => s.source.startsWith('plugin:')).map((s) => [s.name, s.source]), [
      ['demo-plugin-skill', 'plugin:demo'],
      ['idle-plugin-skill', 'plugin:idle'],
    ]);
    assert.ok(inv.skills.slice(0, 2).every((s) => s.source === 'user'), 'user skills are listed before plugin skills');
    const demo = inv.skills.find((s) => s.name === 'demo-skill');
    assert.equal(demo.userInvocable, true);
    assert.equal(demo.modelInvocable, true);
    assert.ok(demo.descriptionChars > 20 && demo.bodyTokens > 10);
    assert.ok(inv.skillDescriptionTokens > 0);
  });

  it('lists user agents and plugin agents with model and tool count', () => {
    assert.deepEqual(inv.agents.map((a) => [a.name, a.source, a.model, a.tools]), [
      ['helper', 'user', 'haiku', 2],
      ['demo-agent', 'plugin:demo', 'sonnet', null],
    ]);
  });

  it('describes installed plugins, their components and the known marketplaces', () => {
    assert.deepEqual(inv.plugins.installed.map((p) => [p.name, p.marketplace, p.version]), [
      ['demo', 'fixture-market', '1.0.0'],
      ['idle', 'fixture-market', '0.2.0'],
    ]);
    assert.deepEqual(inv.plugins.installed[0].components, { skills: 1, agents: 1, hooks: false, mcp: true });
    assert.deepEqual(inv.plugins.installed[1].components, { skills: 1, agents: 0, hooks: false, mcp: false });
    assert.deepEqual(inv.plugins.marketplaces, ['fixture-market']);
  });

  it('reads the MCP servers of ~/.claude.json as user-scope servers', () => {
    assert.deepEqual(inv.mcp, { user: ['used-srv', 'dead-srv'], project: [], local: [], disabledProject: [], pendingProject: [], disabledHere: [] });
  });

  it('measures CLAUDE.md', () => {
    assert.equal(inv.claudeMd.length, 1);
    const md = inv.claudeMd[0];
    assert.equal(md.scope, 'user');
    assert.equal(md.lines, 121);
    assert.equal(md.imports, 0);
    assert.equal(md.kaizenBlocks, 0);
    assert.equal(md.hints.language, true);
    assert.equal(inv.claudeMdTokens, md.tokens);
  });

  it('has no legacy commands and no auto-memory directory yet', () => {
    assert.deepEqual(inv.legacyCommands, []);
    assert.equal(inv.hasAutoMemory, false);
  });
});

describe('inventory of other configurations', () => {
  it('copes with an empty configuration directory', () => {
    const root = makeTempDir('kaizen-inv-');
    const restore = setEnv({ HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude') });
    try {
      const inv = inventory({ projectDir: null });
      assert.deepEqual(inv.settings, []);
      assert.equal(inv.hooks.total, 0);
      assert.deepEqual(inv.skills, []);
      assert.deepEqual(inv.agents, []);
      assert.deepEqual(inv.plugins, { installed: [], marketplaces: [] });
      assert.deepEqual(inv.mcp, { user: [], project: [], local: [], disabledProject: [], pendingProject: [], disabledHere: [] });
      assert.deepEqual(inv.claudeMd, []);
      assert.equal(inv.permissions.defaultMode, 'default');
      assert.equal(inv.statusLine, false);
    } finally {
      restore();
    }
  });

  it('skips a settings file that is not valid JSON instead of failing', () => {
    writeText(home.settingsFile, '{ broken');
    assert.deepEqual(inventory({ projectDir: null }).settings, []);
  });

  it('reads project and local settings, project skills, agents, rules, legacy commands and MCP servers', () => {
    const project = makeTempDir('kaizen-proj-');
    writeJson(path.join(project, '.claude', 'settings.json'), { permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' }, statusLine: { type: 'command', command: 'x' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi', async: true }] }] } });
    writeJson(path.join(project, '.claude', 'settings.local.json'), { language: 'russian', cleanupPeriodDays: 90 });
    writeText(path.join(project, 'CLAUDE.md'), '# Project\n\nUse tabs.\n@docs/extra.md\n');
    writeText(path.join(project, 'CLAUDE.local.md'), 'Local notes.\n');
    writeText(path.join(project, 'AGENTS.md'), 'Agents file.\n');
    writeText(path.join(project, '.claude', 'rules', 'api.md'), 'Rule about the api.\n');
    writeText(path.join(project, '.claude', 'rules', 'readme.txt'), 'ignored');
    writeText(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: "Deploys it"\nuser-invocable: false\ndisable-model-invocation: true\n---\nBody');
    writeText(path.join(project, '.claude', 'skills', 'no-frontmatter', 'SKILL.md'), 'Just text');
    writeText(path.join(project, '.claude', 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here');
    writeText(path.join(project, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep, Glob\nmodel: opus\n---\nPrompt');
    writeText(path.join(project, '.claude', 'agents', 'no-name.md'), 'plain agent');
    writeText(path.join(project, '.claude', 'commands', 'old-command.md'), 'legacy');
    writeJson(path.join(project, '.mcp.json'), { mcpServers: { 'proj-srv': { command: 'x' } } });
    const cfg = JSON.parse(fs.readFileSync(home.claudeJson, 'utf8'));
    cfg.projects = { [project]: { mcpServers: { 'local-srv': { command: 'y' } }, disabledMcpjsonServers: ['proj-srv'] } };
    writeJson(home.claudeJson, cfg);

    const inv = inventory({ projectDir: project });
    assert.deepEqual(inv.settings.map((s) => s.scope), ['user', 'project', 'local']);
    assert.equal(inv.hooks.total, 3);
    assert.equal(inv.hooks.commands.at(-1).async, true);
    assert.equal(inv.permissions.defaultMode, 'acceptEdits', 'the last non-empty defaultMode wins');
    assert.equal(inv.permissions.allow, 3);
    assert.deepEqual(inv.permissions.denyRules, ['Read(./.env)']);
    assert.equal(inv.statusLine, true);
    assert.equal(inv.settings[2].language, 'russian');
    assert.equal(inv.settings[2].cleanupPeriodDays, 90);
    assert.deepEqual(inv.claudeMd.map((f) => f.scope), ['user', 'project', 'local', 'project-rules'], 'AGENTS.md is not read when the project has a CLAUDE.md');
    assert.equal(inv.claudeMd[1].imports, 1);
    assert.equal(inv.claudeMd[3].files, 1, 'only *.md files of the rules directory count');
    assert.deepEqual(inv.skills.filter((s) => s.source === 'project').map((s) => s.name).sort(), ['deploy', 'no-frontmatter']);
    const deploy = inv.skills.find((s) => s.name === 'deploy');
    assert.equal(deploy.userInvocable, false);
    assert.equal(deploy.modelInvocable, false);
    assert.equal(deploy.descriptionChars, 'Deploys it'.length, 'quotes around frontmatter values are stripped');
    assert.deepEqual(inv.agents.filter((a) => a.source === 'project').map((a) => [a.name, a.model, a.tools]).sort(), [['no-name', null, null], ['reviewer', 'opus', 3]], 'an agent without frontmatter is named after its file');
    assert.deepEqual(inv.legacyCommands.map((c) => c.name), ['old-command']);
    assert.deepEqual(inv.mcp, { user: ['used-srv', 'dead-srv'], project: ['proj-srv'], local: ['local-srv'], disabledProject: ['proj-srv'], pendingProject: [], disabledHere: [] });
  });

  it('detects Kaizen blocks in CLAUDE.md', () => {
    writeText(path.join(home.configDir, 'CLAUDE.md'), 'Top.\n\n<!-- kaizen:start a -->\nx\n<!-- kaizen:end a -->\n\n<!-- kaizen:start b -->\ny\n<!-- kaizen:end b -->\n');
    assert.equal(inventory({ projectDir: null }).claudeMd[0].kaizenBlocks, 2);
  });

  it('notices an existing projects directory (auto memory)', () => {
    fs.mkdirSync(path.join(home.configDir, 'projects'), { recursive: true });
    assert.equal(inventory({ projectDir: null }).hasAutoMemory, true);
  });

  it('masks long and secret-looking environment values and stringifies the rest', () => {
    writeJson(home.settingsFile, { env: { MY_TOKEN: 'abc', SECRET_THING: 'x', DB_PASSWORD: 'y', AUTH_URL: 'z', LONG_VALUE: 'v'.repeat(100), NUMBER: 42, FLAG: true, SHORT: 'ok' } });
    const env = inventory({ projectDir: null }).settings[0].env;
    assert.deepEqual(env, { MY_TOKEN: '[masked]', SECRET_THING: '[masked]', DB_PASSWORD: '[masked]', AUTH_URL: '[masked]', LONG_VALUE: `${'v'.repeat(57)}…`, NUMBER: '42', FLAG: 'true', SHORT: 'ok' });
  });

  it('describes prompt and agent hooks without a command, truncates long commands and ignores malformed hook lists', () => {
    writeJson(home.settingsFile, {
      hooks: {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the work' }, { type: 'agent' }, { type: 'command', command: `echo ${'x'.repeat(300)}` }] }],
        PreToolUse: 'not a list',
        Notification: [null, { hooks: 'nope' }, { matcher: 'idle' }],
      },
      disableAllHooks: true,
    });
    const inv = inventory({ projectDir: null });
    assert.deepEqual(inv.hooks.commands.map((c) => [c.type, c.command.length > 100 ? 'long' : c.command]), [['prompt', '(prompt)'], ['agent', '(agent)'], ['command', 'long']]);
    assert.equal(inv.hooks.commands[2].command.length, 200);
    assert.deepEqual(inv.hooks.events, { Stop: 3 });
    assert.equal(inv.settings[0].disableAllHooks, true);
  });

  it('records the legacy attribution switch includeCoAuthoredBy: false as a commit attribution of "off"', () => {
    writeJson(home.settingsFile, { includeCoAuthoredBy: false });
    assert.deepEqual(inventory({ projectDir: null }).settings[0].attribution, { commit: 'off' });
    writeJson(home.settingsFile, { attribution: { commit: '', pr: '' }, includeCoAuthoredBy: false });
    assert.deepEqual(inventory({ projectDir: null }).settings[0].attribution, { commit: '', pr: '' });
  });

  it('takes a plugin entry that is a single object as well as an array of installs', () => {
    writeJson(path.join(home.configDir, 'plugins', 'installed_plugins.json'), { plugins: { 'solo@market': { installPath: path.join(home.root, 'missing'), version: '3.0.0' }, 'multi@market': [{ version: '1.0.0' }, { version: '0.9.0' }] } });
    const { installed } = inventory({ projectDir: null }).plugins;
    assert.deepEqual(installed.map((p) => [p.name, p.marketplace, p.version, p.components]), [
      ['solo', 'market', '3.0.0', null],
      ['multi', 'market', '1.0.0', null],
    ]);
  });
});

describe('global config location (CLAUDE_CONFIG_DIR)', () => {
  it('reads the MCP servers of $CLAUDE_CONFIG_DIR/.claude.json, not of the default profile ~/.claude.json', () => {
    writeJson(path.join(home.home, '.claude.json'), { mcpServers: { 'default-profile-srv': { command: 'x' } } });
    writeJson(home.claudeJson, { mcpServers: { 'relocated-srv': { command: 'y' } }, projects: {} });
    assert.deepEqual(inventory({ projectDir: null }).mcp.user, ['relocated-srv']);
  });

  it('reads ~/.claude.json when CLAUDE_CONFIG_DIR is not set', () => {
    const root = makeTempDir('kaizen-inv-');
    const restore = setEnv({ HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: undefined });
    try {
      writeJson(path.join(root, '.claude.json'), { mcpServers: { 'home-srv': {} } });
      assert.deepEqual(inventory({ projectDir: null }).mcp.user, ['home-srv']);
    } finally {
      restore();
    }
  });
});

describe('robustness against odd files', () => {
  it('does not crash on a dangling symlink in a rules directory and still counts the other rules', (t) => {
    const rules = path.join(home.configDir, 'rules');
    writeText(path.join(rules, 'ok.md'), 'x'.repeat(400));
    const gone = path.join(home.root, 'gone.md');
    writeText(gone, 'shared');
    try {
      fs.symlinkSync(gone, path.join(rules, 'shared.md'));
    } catch (e) {
      t.skip(`cannot create symlinks here: ${e.code}`);
      return;
    }
    fs.rmSync(gone);
    const rulesEntry = inventory({ projectDir: null }).claudeMd.find((f) => f.scope === 'user-rules');
    assert.equal(rulesEntry.files, 1);
    assert.equal(rulesEntry.chars, 400);
  });

  it('does not crash on a rules entry that is a directory named *.md', () => {
    fs.mkdirSync(path.join(home.configDir, 'rules', 'dir.md'), { recursive: true });
    writeText(path.join(home.configDir, 'rules', 'ok.md'), 'x'.repeat(40));
    assert.equal(inventory({ projectDir: null }).claudeMd.find((f) => f.scope === 'user-rules').files, 1);
  });

  it('skips null and non-object hook handlers instead of crashing', () => {
    const project = makeTempDir('kaizen-proj-');
    writeJson(path.join(project, '.claude', 'settings.local.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [null, 'x', 7, [], { type: 'command', command: 'echo ok' }] }] } });
    const inv = inventory({ projectDir: project });
    assert.equal(inv.hooks.commands.filter((c) => c.event === 'PreToolUse').length, 1);
    assert.equal(inv.hooks.commands.find((c) => c.event === 'PreToolUse').command, 'echo ok');
  });
});

describe('frontmatter of skills and agents', () => {
  const skill = (dir, text) => writeText(path.join(home.configDir, 'skills', dir, 'SKILL.md'), text);
  const find = (name) => inventory({ projectDir: null }).skills.find((s) => s.name === name);

  it('ignores a leading BOM', () => {
    skill('bom', `﻿---\nname: bom-skill\ndescription: ${'d'.repeat(300)}\ndisable-model-invocation: true\n---\nBody`);
    const s = find('bom-skill');
    assert.ok(s, 'the name comes from the frontmatter, not from the directory');
    assert.equal(s.descriptionChars, 300);
    assert.equal(s.modelInvocable, false);
  });

  it('reads folded (>, >-) and literal (|, |-) block scalars', () => {
    const para = `${'a'.repeat(100)}\n  ${'b'.repeat(100)}\n  ${'c'.repeat(100)}`;
    skill('folded', `---\nname: folded\ndescription: >-\n  ${para}\n---\nBody`);
    skill('literal', `---\nname: literal\ndescription: |\n  line one\n  line two\n---\nBody`);
    skill('after', `---\ndescription: >\n  first\n  second\nname: after-name\nuser-invocable: false\n---\nBody`);
    assert.equal(find('folded').descriptionChars, 100 * 3 + 2, 'lines are joined with a space');
    assert.equal(find('literal').descriptionChars, 'line one\nline two'.length);
    assert.equal(find('after-name').descriptionChars, 'first second'.length);
    assert.equal(find('after-name').userInvocable, false, 'keys after a block scalar are still read');
  });

  it('reads a multi-line plain scalar and a block list of tools', () => {
    skill('multi', '---\nname: multi\ndescription: first part\n  second part\n---\nBody');
    assert.equal(find('multi').descriptionChars, 'first part second part'.length);
    writeText(path.join(home.configDir, 'agents', 'lister.md'), '---\nname: lister\ndescription: x\ntools:\n  - Read\n  - Grep\n  - "Glob"\n---\nBody');
    assert.equal(inventory({ projectDir: null }).agents.find((a) => a.name === 'lister').tools, 3);
  });
});

describe('CLAUDE.md, AGENTS.md and rules that really load', () => {
  const project = () => makeTempDir('kaizen-proj-');

  it('counts AGENTS.md when the project has no CLAUDE.md of its own (also .claude/AGENTS.md)', () => {
    const p = project();
    writeText(path.join(p, 'AGENTS.md'), 'Always answer in Russian.\n');
    writeText(path.join(p, '.claude', 'AGENTS.md'), 'Run the tests before commit.\n');
    const inv = inventory({ projectDir: p });
    assert.deepEqual(inv.claudeMd.map((f) => f.scope), ['user', 'agents-md', 'agents-md']);
    assert.equal(inv.claudeMd[1].hints.language, true);
  });

  it('ignores AGENTS.md next to a CLAUDE.md, a .claude/CLAUDE.md or a CLAUDE.local.md, and so does not take its hints', () => {
    for (const mine of [['CLAUDE.md'], ['.claude', 'CLAUDE.md'], ['CLAUDE.local.md']]) {
      const p = project();
      writeText(path.join(p, ...mine), 'build with make\n');
      const baseline = inventory({ projectDir: p }).claudeMdTokens;
      writeText(path.join(p, 'AGENTS.md'), `Always answer in Russian.\n${'x'.repeat(4000)}\n`);
      const inv = inventory({ projectDir: p });
      assert.ok(!inv.claudeMd.some((f) => f.scope === 'agents-md'), mine.join('/'));
      assert.equal(inv.claudeMdTokens, baseline, 'the tokens of AGENTS.md are not added');
      assert.ok(!inv.claudeMd.some((f) => f.hints && f.hints.language && f.scope !== 'user'), 'its language rule does not count as covered');
    }
  });

  it('counts AGENTS.md when CLAUDE.md imports it', () => {
    const p = project();
    writeText(path.join(p, 'CLAUDE.md'), 'See below.\n@AGENTS.md\n');
    writeText(path.join(p, 'AGENTS.md'), 'Agents rules.\n');
    assert.deepEqual(inventory({ projectDir: p }).claudeMd.map((f) => f.scope), ['user', 'project', 'agents-md']);
  });

  it('does not count path-scoped rules (frontmatter paths:) as loaded on every request', () => {
    const rules = path.join(home.configDir, 'rules');
    writeText(path.join(rules, 'always.md'), 'y'.repeat(800));
    writeText(path.join(rules, 'python.md'), `---\npaths: ["**/*.py"]\n---\n${'x'.repeat(14000)}`);
    writeText(path.join(rules, 'block.md'), `---\npaths:\n  - "src/**/*.ts"\n  - "lib/**"\n---\n${'x'.repeat(5000)}`);
    writeText(path.join(rules, 'empty-paths.md'), `---\npaths: []\n---\n${'z'.repeat(400)}`);
    const before = inventory({ projectDir: null });
    const entry = before.claudeMd.find((f) => f.scope === 'user-rules');
    assert.equal(entry.files, 2, 'always.md and the rule with an empty paths list');
    assert.equal(entry.chars, 800 + `---\npaths: []\n---\n${'z'.repeat(400)}`.length);
    assert.equal(entry.conditionalFiles, 2);
    assert.equal(entry.tokens, estimateTokens(' '.repeat(entry.chars)));
    assert.ok(entry.tokens < 400, `tokens ${entry.tokens}`);
  });

  it('keeps a rules directory that holds only path-scoped rules, with no tokens', () => {
    writeText(path.join(home.configDir, 'rules', 'only.md'), '---\npaths: ["a/**"]\n---\nbody');
    const entry = inventory({ projectDir: null }).claudeMd.find((f) => f.scope === 'user-rules');
    assert.equal(entry.files, 0);
    assert.equal(entry.tokens, 0);
    assert.equal(entry.conditionalFiles, 1);
  });
});

describe('plugins switched off in enabledPlugins', () => {
  it('contribute no skills, agents or plugin hooks, and are marked disabled', () => {
    writeJson(home.settingsFile, { enabledPlugins: { 'demo@fixture-market': true, 'idle@fixture-market': false } });
    const inv = inventory({ projectDir: null });
    assert.deepEqual(inv.skills.filter((s) => s.source.startsWith('plugin:')).map((s) => s.source), ['plugin:demo']);
    assert.deepEqual(inv.plugins.installed.map((p) => [p.name, p.enabled]), [['demo', true], ['idle', false]]);
  });

  it('are decided by the highest-precedence file that mentions them', () => {
    const project = makeTempDir('kaizen-proj-');
    writeJson(home.settingsFile, { enabledPlugins: { 'idle@fixture-market': false } });
    writeJson(path.join(project, '.claude', 'settings.local.json'), { enabledPlugins: { 'idle@fixture-market': true } });
    assert.ok(inventory({ projectDir: project }).skills.some((s) => s.source === 'plugin:idle'));
    assert.ok(!inventory({ projectDir: null }).skills.some((s) => s.source === 'plugin:idle'));
  });

  it('are still counted when enabledPlugins does not mention them at all', () => {
    writeJson(home.settingsFile, {});
    assert.equal(inventory({ projectDir: null }).skills.filter((s) => s.source.startsWith('plugin:')).length, 2);
  });

  it('picks the install entry of the current project over entries for other projects', () => {
    const project = makeTempDir('kaizen-proj-');
    const other = makeTempDir('kaizen-other-');
    writeJson(path.join(home.configDir, 'plugins', 'installed_plugins.json'), {
      plugins: { 'multi@market': [{ scope: 'local', projectPath: other, version: '9.9.9' }, { scope: 'user', version: '1.0.0' }, { scope: 'local', projectPath: project, version: '2.0.0' }] },
    });
    assert.equal(inventory({ projectDir: project }).plugins.installed[0].version, '2.0.0');
    assert.equal(inventory({ projectDir: null }).plugins.installed[0].version, '1.0.0');
  });
});

describe('hooks provided by plugins', () => {
  const addPlugin = (name, hooksJson, { enabled = true } = {}) => {
    const dir = path.join(home.root, 'plugins-src', name);
    if (hooksJson) writeJson(path.join(dir, 'hooks', 'hooks.json'), hooksJson);
    const file = path.join(home.configDir, 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    installed.plugins[`${name}@market`] = [{ scope: 'user', installPath: dir, version: '1.0.0' }];
    writeJson(file, installed);
    const settings = JSON.parse(fs.readFileSync(home.settingsFile, 'utf8'));
    settings.enabledPlugins[`${name}@market`] = enabled;
    writeJson(home.settingsFile, settings);
  };

  it('are counted in hooks.total, hooks.events and hooks.commands with scope plugin:<name>', () => {
    addPlugin('memory', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/start.mjs' }] }], PreCompact: [{ hooks: [{ type: 'command', command: 'node pre.mjs' }] }] } });
    const inv = inventory({ projectDir: null });
    assert.equal(inv.hooks.total, 4);
    assert.equal(inv.hooks.events.SessionStart, 1);
    assert.equal(inv.hooks.events.PreCompact, 1);
    assert.deepEqual(inv.hooks.commands.filter((c) => c.scope === 'plugin:memory').map((c) => c.event), ['SessionStart', 'PreCompact']);
    assert.equal(inv.settings.reduce((a, s) => a + s.hooks.total, 0), 2, 'settings hooks are unchanged');
  });

  it('are ignored for a disabled plugin, for Kaizen itself and for a hooks.json that is not valid', () => {
    addPlugin('off', { hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }, { enabled: false });
    addPlugin('kaizen', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node kaizen.mjs nudge' }] }] } });
    const broken = path.join(home.root, 'plugins-src', 'broken', 'hooks');
    writeText(path.join(broken, 'hooks.json'), '{ nope');
    addPlugin('broken', null);
    const inv = inventory({ projectDir: null });
    assert.equal(inv.hooks.total, 2);
    assert.deepEqual(inv.hooks.events, { PostToolUse: 1, Stop: 1 });
  });

  it('accept the bare event map without the "hooks" wrapper', () => {
    addPlugin('bare', { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] });
    assert.equal(inventory({ projectDir: null }).hooks.events.Stop, 2);
  });
});

describe('managed settings', () => {
  const managedDir = () => path.join(home.root, 'managed');

  it('are read last, read-only, from managed-settings.json and its managed-settings.d drop-ins in order', () => {
    writeJson(path.join(managedDir(), 'managed-settings.json'), { permissions: { deny: ['Read(./.env)'], defaultMode: 'plan' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node block-force-push.mjs' }] }] } });
    writeJson(path.join(managedDir(), 'managed-settings.d', '20-b.json'), { permissions: { defaultMode: 'acceptEdits' } });
    writeJson(path.join(managedDir(), 'managed-settings.d', '10-a.json'), { enabledPlugins: { 'demo@fixture-market': false } });
    writeText(path.join(managedDir(), 'managed-settings.d', 'notes.txt'), 'ignored');
    const before = fs.readFileSync(path.join(managedDir(), 'managed-settings.json'), 'utf8');
    const inv = inventory({ projectDir: null });
    assert.deepEqual(inv.settings.map((s) => s.scope), ['user', 'managed', 'managed', 'managed']);
    assert.deepEqual(inv.permissions.denyRules, ['Read(./.env)']);
    assert.equal(inv.permissions.defaultMode, 'acceptEdits', 'the last drop-in wins');
    assert.ok(inv.hooks.commands.some((c) => c.scope === 'managed' && /block-force-push/.test(c.command)));
    assert.ok(!inv.skills.some((s) => s.source === 'plugin:demo'), 'a plugin disabled by managed settings is not inventoried');
    assert.equal(fs.readFileSync(path.join(managedDir(), 'managed-settings.json'), 'utf8'), before);
  });

  it('are absent without a managed directory', () => {
    assert.deepEqual(inventory({ projectDir: null }).settings.map((s) => s.scope), ['user']);
  });
});

describe('MCP servers of the shared .mcp.json', () => {
  const setup = (cfgProject, settings = {}) => {
    const project = makeTempDir('kaizen-proj-');
    writeJson(path.join(project, '.mcp.json'), { mcpServers: { a: {}, b: {}, c: {} } });
    const cfg = JSON.parse(fs.readFileSync(home.claudeJson, 'utf8'));
    cfg.projects = { [project]: cfgProject };
    writeJson(home.claudeJson, cfg);
    if (Object.keys(settings).length) writeJson(path.join(project, '.claude', 'settings.local.json'), settings);
    return inventory({ projectDir: project }).mcp;
  };

  it('are pending until approved: enabledMcpjsonServers, enableAllProjectMcpServers', () => {
    assert.deepEqual(setup({}).pendingProject, ['a', 'b', 'c']);
    assert.deepEqual(setup({ enabledMcpjsonServers: ['a'] }).pendingProject, ['b', 'c']);
    assert.deepEqual(setup({}, { enabledMcpjsonServers: ['b'] }).pendingProject, ['a', 'c']);
    assert.deepEqual(setup({ enableAllProjectMcpServers: true }).pendingProject, []);
    assert.deepEqual(setup({}, { enableAllProjectMcpServers: true }).pendingProject, []);
  });

  it('merge disabledMcpjsonServers of the global config and of every settings file, and disabled wins over enabled', () => {
    const mcp = setup({ disabledMcpjsonServers: ['a'], enabledMcpjsonServers: ['a', 'b'] }, { disabledMcpjsonServers: ['b', 7] });
    assert.deepEqual(mcp.disabledProject, ['a', 'b']);
    assert.deepEqual(mcp.pendingProject, ['c']);
  });
});

describe('the project entry of ~/.claude.json is found the way Claude Code keys it', () => {
  const posix = (p) => p.replace(/\\/g, '/');
  const withEntry = (key, entry, project) => {
    const cfg = JSON.parse(fs.readFileSync(home.claudeJson, 'utf8'));
    cfg.projects = { [key]: entry };
    writeJson(home.claudeJson, cfg);
    writeJson(path.join(project, '.mcp.json'), { mcpServers: { shared: {}, other: {} } });
    return inventory({ projectDir: project }).mcp;
  };

  it('matches a forward-slash key (Windows) for local servers and for recorded approvals', () => {
    const project = makeTempDir('kaizen-proj-');
    const mcp = withEntry(posix(project), { mcpServers: { 'local-srv': {} }, enabledMcpjsonServers: ['shared'] }, project);
    assert.deepEqual(mcp.local, ['local-srv']);
    assert.deepEqual(mcp.pendingProject, ['other'], 'the approved server is not pending any more');
  });

  it('matches a key with a trailing slash, and on Windows a different drive-letter case', () => {
    const project = makeTempDir('kaizen-proj-');
    assert.deepEqual(withEntry(`${posix(project)}/`, { mcpServers: { a: {} } }, project).local, ['a']);
    if (process.platform === 'win32') {
      const flipped = project[0] === project[0].toUpperCase() ? project[0].toLowerCase() + project.slice(1) : project[0].toUpperCase() + project.slice(1);
      assert.deepEqual(withEntry(posix(flipped), { mcpServers: { b: {} } }, project).local, ['b']);
    }
  });

  it('still matches the native path key, and ignores the entry of another project', () => {
    const project = makeTempDir('kaizen-proj-');
    assert.deepEqual(withEntry(project, { mcpServers: { native: {} } }, project).local, ['native']);
    assert.deepEqual(withEntry(path.join(project, 'sub'), { mcpServers: { sub: {} } }, project).local, []);
  });

  it('reports servers switched off with /mcp for this project (disabledMcpServers) as disabledHere', () => {
    const project = makeTempDir('kaizen-proj-');
    const mcp = withEntry(posix(project), { mcpServers: { 'local-off': {}, 'local-on': {} }, disabledMcpServers: ['local-off', 'used-srv', 5] }, project);
    assert.deepEqual(mcp.local, ['local-off', 'local-on']);
    assert.deepEqual(mcp.disabledHere, ['local-off', 'used-srv']);
    const other = makeTempDir('kaizen-proj-');
    assert.deepEqual(inventory({ projectDir: other }).mcp.disabledHere, [], 'the list belongs to its project');
  });
});

describe('plugins installed for another project', () => {
  const install = (entries, { skill = 's1', hooks = true } = {}) => {
    const dir = path.join(home.root, 'plugins-src', 'onlyother');
    writeText(path.join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: x\n---\nBody`);
    if (hooks) writeJson(path.join(dir, 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node start.mjs' }] }] } });
    const file = path.join(home.configDir, 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    installed.plugins['onlyother@market'] = entries(dir);
    writeJson(file, installed);
  };
  const names = (inv) => inv.plugins.installed.map((p) => p.name);

  it('a plugin installed only at local scope for another project is not installed here (no skills, agents, hooks)', () => {
    const project = makeTempDir('kaizen-proj-');
    const other = makeTempDir('kaizen-other-');
    install((dir) => [{ scope: 'local', projectPath: other, installPath: dir, version: '1.0.0' }]);
    for (const projectDir of [project, null]) {
      const inv = inventory({ projectDir });
      assert.ok(!names(inv).includes('onlyother'), `projectDir ${projectDir}`);
      assert.ok(!inv.skills.some((s) => s.name === 's1'));
      assert.equal(inv.hooks.events.SessionStart, undefined);
    }
  });

  it('the same install counts in the project it belongs to, at local and at project scope', () => {
    const project = makeTempDir('kaizen-proj-');
    for (const scope of ['local', 'project']) {
      install((dir) => [{ scope, projectPath: project, installPath: dir, version: '1.0.0' }]);
      const inv = inventory({ projectDir: project });
      assert.ok(names(inv).includes('onlyother'), scope);
      assert.ok(inv.skills.some((s) => s.name === 's1'), scope);
      assert.equal(inv.hooks.events.SessionStart, 1, scope);
    }
  });

  it('a user-scope install still applies everywhere, next to local installs elsewhere', () => {
    const other = makeTempDir('kaizen-other-');
    install((dir) => [{ scope: 'local', projectPath: other, installPath: path.join(dir, 'nowhere'), version: '9.9.9' }, { scope: 'user', installPath: dir, version: '1.0.0' }]);
    const inv = inventory({ projectDir: null });
    assert.equal(inv.plugins.installed.find((p) => p.name === 'onlyother').version, '1.0.0');
    assert.ok(inv.skills.some((s) => s.name === 's1'));
  });
});

describe('AGENTS.md and the CLAUDE.md files of ancestor directories', () => {
  const tree = () => {
    const parent = makeTempDir('kaizen-mono-');
    const project = path.join(parent, 'packages', 'app');
    writeText(path.join(project, 'AGENTS.md'), `Always answer in Russian.\n${'x'.repeat(4000)}\n`);
    return { parent, project };
  };
  const agentsCounted = (project) => inventory({ projectDir: project }).claudeMd.some((f) => f.scope === 'agents-md');

  it('counts AGENTS.md when no directory above has a CLAUDE.md', () => {
    assert.equal(agentsCounted(tree().project), true);
  });

  it('skips AGENTS.md when any ancestor has CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md (Claude Code skips it too)', () => {
    for (const [dir, file] of [[[], 'CLAUDE.md'], [['packages'], 'CLAUDE.md'], [[], '.claude/CLAUDE.md'], [['packages'], 'CLAUDE.local.md']]) {
      const { parent, project } = tree();
      writeText(path.join(parent, ...dir, ...file.split('/')), 'build with make\n');
      const inv = inventory({ projectDir: project });
      assert.ok(!inv.claudeMd.some((f) => f.scope === 'agents-md'), `${dir.join('/')}/${file}`);
      assert.ok(!inv.claudeMd.some((f) => f.hints && f.hints.language && f.scope !== 'user'), 'its hints are not taken either');
    }
  });

  it('counts AGENTS.md when a CLAUDE.md of an ancestor imports it', () => {
    const { parent, project } = tree();
    writeText(path.join(parent, 'CLAUDE.md'), 'See @packages/app/AGENTS.md\n@packages/app/AGENTS.md\n');
    assert.equal(agentsCounted(project), true);
  });

  it('does not take the user CLAUDE.md for an ancestor project file', () => {
    // <home>/.claude/CLAUDE.md is the user file; a project below the home directory keeps its AGENTS.md
    const project = path.join(home.home, 'work', 'app');
    writeText(path.join(home.configDir, 'CLAUDE.md'), 'user rules\n');
    writeText(path.join(project, 'AGENTS.md'), 'Agent notes.\n');
    assert.equal(agentsCounted(project), true);
  });
});

describe('rules in subdirectories of .claude/rules', () => {
  it('counts nested rules and reports nested path-scoped ones as conditional', () => {
    const project = makeTempDir('kaizen-proj-');
    const rules = path.join(project, '.claude', 'rules');
    writeText(path.join(rules, 'top.md'), 'x'.repeat(400));
    writeText(path.join(rules, 'frontend', 'style.md'), 'y'.repeat(800));
    writeText(path.join(rules, 'frontend', 'deep', 'more.md'), 'z'.repeat(200));
    writeText(path.join(rules, 'frontend', 'scoped.md'), `---\npaths: ["src/**/*.tsx"]\n---\n${'s'.repeat(300)}`);
    writeText(path.join(rules, 'backend', 'notes.txt'), 'ignored');
    const entry = inventory({ projectDir: project }).claudeMd.find((f) => f.scope === 'project-rules');
    assert.equal(entry.files, 3);
    assert.equal(entry.chars, 400 + 800 + 200);
    assert.equal(entry.conditionalFiles, 1);
  });

  it('counts a rule once when a symlinked directory loops back, and skips dangling links', (t) => {
    const project = makeTempDir('kaizen-proj-');
    const rules = path.join(project, '.claude', 'rules');
    writeText(path.join(rules, 'sub', 'a.md'), 'a'.repeat(100));
    try {
      fs.symlinkSync(rules, path.join(rules, 'sub', 'loop'), 'junction');
      fs.symlinkSync(path.join(project, 'missing'), path.join(rules, 'sub', 'gone'), 'junction');
    } catch (e) {
      t.skip(`cannot create symlinks here: ${e.code}`);
      return;
    }
    const entry = inventory({ projectDir: project }).claudeMd.find((f) => f.scope === 'project-rules');
    assert.equal(entry.files, 1);
    assert.equal(entry.chars, 100);
  });
});

describe('hooks declared in the plugin manifest', () => {
  const hook = (event, command) => ({ [event]: [{ hooks: [{ type: 'command', command }] }] });
  const addPlugin = (name, manifest, files = {}) => {
    const dir = path.join(home.root, 'plugins-src', name);
    writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name, ...manifest });
    for (const [rel, data] of Object.entries(files)) writeJson(path.join(dir, rel), data);
    const file = path.join(home.configDir, 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    installed.plugins[`${name}@market`] = [{ scope: 'user', installPath: dir, version: '1.0.0' }];
    writeJson(file, installed);
    return dir;
  };
  const plugin = (name) => inventory({ projectDir: null }).plugins.installed.find((p) => p.name === name);

  it('counts an inline hooks object (also with the "hooks" wrapper)', () => {
    addPlugin('inl', { hooks: hook('PostToolUse', 'prettier --write') });
    addPlugin('wrapped', { hooks: { hooks: hook('Notification', 'notify') } });
    const inv = inventory({ projectDir: null });
    assert.ok(inv.hooks.commands.some((c) => c.scope === 'plugin:inl' && c.event === 'PostToolUse' && c.command === 'prettier --write'));
    assert.ok(inv.hooks.commands.some((c) => c.scope === 'plugin:wrapped' && c.event === 'Notification'));
    assert.equal(plugin('inl').components.hooks, true);
  });

  it('counts hook files named by a path or an array of paths, relative to the plugin', () => {
    addPlugin('ref', { hooks: './config/my-hooks.json' }, { 'config/my-hooks.json': { hooks: hook('SessionStart', 'node a.mjs') } });
    addPlugin('multi', { hooks: ['./one.json', './two.json', { Stop: [{ hooks: [{ type: 'command', command: 'inline' }] }] }] }, { 'one.json': hook('PreCompact', 'node b.mjs'), 'two.json': { hooks: hook('Stop', 'node c.mjs') } });
    const inv = inventory({ projectDir: null });
    assert.deepEqual(inv.hooks.commands.filter((c) => c.scope === 'plugin:ref').map((c) => c.command), ['node a.mjs']);
    assert.deepEqual(inv.hooks.commands.filter((c) => c.scope === 'plugin:multi').map((c) => c.command).sort(), ['inline', 'node b.mjs', 'node c.mjs']);
    assert.equal(inv.hooks.events.PreCompact, 1);
  });

  it('adds the manifest hooks to hooks/hooks.json without counting the same file twice', () => {
    addPlugin('both', { hooks: ['./hooks/hooks.json', { Stop: [{ hooks: [{ type: 'command', command: 'extra' }] }] }] }, { 'hooks/hooks.json': { hooks: hook('SessionStart', 'node s.mjs') } });
    const mine = inventory({ projectDir: null }).hooks.commands.filter((c) => c.scope === 'plugin:both');
    assert.deepEqual(mine.map((c) => c.command).sort(), ['extra', 'node s.mjs']);
  });

  it('ignores manifest paths that leave the plugin directory, missing files and a disabled plugin', () => {
    const outside = path.join(home.root, 'outside.json');
    writeJson(outside, hook('Stop', 'escaped'));
    addPlugin('escape', { hooks: ['../../outside.json', './missing.json', path.join(home.root, 'outside.json')] });
    addPlugin('off', { hooks: hook('Stop', 'disabled') });
    const settings = JSON.parse(fs.readFileSync(home.settingsFile, 'utf8'));
    settings.enabledPlugins['off@market'] = false;
    writeJson(home.settingsFile, settings);
    const inv = inventory({ projectDir: null });
    assert.ok(!inv.hooks.commands.some((c) => c.scope === 'plugin:escape' || c.scope === 'plugin:off'));
    assert.equal(plugin('escape').components.hooks, false);
  });
});
