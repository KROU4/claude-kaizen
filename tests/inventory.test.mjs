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
  restoreEnv = setEnv({ ...home.env, CLAUDE_PROJECT_DIR: undefined });
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
    assert.deepEqual(inv.mcp, { user: ['used-srv', 'dead-srv'], project: [], local: [], disabledProject: [] });
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
      assert.deepEqual(inv.mcp, { user: [], project: [], local: [], disabledProject: [] });
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
    assert.deepEqual(inv.claudeMd.map((f) => f.scope), ['user', 'project', 'local', 'project-rules', 'agents-md']);
    assert.equal(inv.claudeMd[1].imports, 1);
    assert.equal(inv.claudeMd[3].files, 1, 'only *.md files of the rules directory count');
    assert.deepEqual(inv.skills.filter((s) => s.source === 'project').map((s) => s.name).sort(), ['deploy', 'no-frontmatter']);
    const deploy = inv.skills.find((s) => s.name === 'deploy');
    assert.equal(deploy.userInvocable, false);
    assert.equal(deploy.modelInvocable, false);
    assert.equal(deploy.descriptionChars, 'Deploys it'.length, 'quotes around frontmatter values are stripped');
    assert.deepEqual(inv.agents.filter((a) => a.source === 'project').map((a) => [a.name, a.model, a.tools]).sort(), [['no-name', null, null], ['reviewer', 'opus', 3]], 'an agent without frontmatter is named after its file');
    assert.deepEqual(inv.legacyCommands.map((c) => c.name), ['old-command']);
    assert.deepEqual(inv.mcp, { user: ['used-srv', 'dead-srv'], project: ['proj-srv'], local: ['local-srv'], disabledProject: ['proj-srv'] });
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
