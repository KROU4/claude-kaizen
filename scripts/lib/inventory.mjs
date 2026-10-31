// Inventory of the user's current Claude Code configuration: settings files,
// hooks, permissions, skills, agents, plugins, MCP servers, CLAUDE.md files.
// Reads structure and sizes only; never copies secrets (env values are masked).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, exists, globalConfigPath, homeDir, managedSettingsFiles, projectConfigKey, readJsonSafe, settingsFiles } from './paths.mjs';

export function estimateTokens(text) {
  if (!text) return 0;
  // ~4 chars per token for English prose, ~2.5 for Cyrillic. Blend by script share.
  let cyr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  const share = text.length ? cyr / text.length : 0;
  const cpt = 4 - 1.5 * share;
  return Math.round(text.length / cpt);
}

/**
 * Frontmatter as flat strings. A leading BOM is ignored (Claude Code strips it), `key: >` / `|` block scalars and
 * indented continuation lines are joined, and a block list (`paths:` + `- item` lines) becomes "item, item".
 */
function frontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-][\w-]*):[ \t]*(.*)$/);
    if (!kv) continue;
    const block = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || /^-(\s|$)/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
    while (block.length && !block[block.length - 1]) block.pop();
    const inline = kv[2].trim();
    let value;
    if (/^[>|][+-]?\d*$/.test(inline)) value = block.join(inline[0] === '>' ? ' ' : '\n').replace(/\s+$/, '');
    else if (inline) value = [inline, ...block.filter(Boolean)].join(' ');
    else if (block.length && block.every((b) => !b || b.startsWith('-'))) value = block.filter(Boolean).map((b) => b.replace(/^-\s*/, '').replace(/^["']|["']$/g, '')).join(', ');
    else value = block.filter(Boolean).join(' ');
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

/** A rule file with a non-empty `paths:` frontmatter loads only when matching files are touched, not on every request. */
function isPathScoped(text) {
  const p = (frontmatter(text).paths || '').trim();
  return p !== '' && p !== '[]';
}

function listSkills(dir, source) {
  const out = [];
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(dir, e.name, 'SKILL.md');
    if (!exists(skillFile)) continue;
    let text = '';
    try {
      text = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    out.push({
      name: fm.name || e.name,
      source,
      dir: path.join(dir, e.name),
      descriptionChars: (fm.description || '').length,
      bodyTokens: estimateTokens(text),
      userInvocable: fm['user-invocable'] !== 'false',
      modelInvocable: fm['disable-model-invocation'] !== 'true',
    });
  }
  return out;
}

function listAgents(dir, source) {
  const out = [];
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, e.name), 'utf8');
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    out.push({
      name: fm.name || e.name.replace(/\.md$/, ''),
      source,
      model: fm.model || null,
      tools: fm.tools ? fm.tools.split(',').map((s) => s.trim()).filter(Boolean).length : null,
      descriptionChars: (fm.description || '').length,
      bodyTokens: estimateTokens(text),
    });
  }
  return out;
}

function summarizeHooks(hooks) {
  const events = {};
  const commands = [];
  if (!hooks || typeof hooks !== 'object') return { events, commands, total: 0 };
  let total = 0;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const list = Array.isArray(m && m.hooks) ? m.hooks : [];
      for (const h of list) {
        if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
        total++;
        events[event] = (events[event] || 0) + 1;
        commands.push({
          event,
          matcher: m.matcher || '',
          type: h.type || 'command',
          command: typeof h.command === 'string' ? h.command.slice(0, 200) : h.type === 'prompt' ? '(prompt)' : '(agent)',
          timeout: h.timeout || null,
          async: h.async === true,
        });
      }
    }
  }
  return { events, commands, total };
}

function maskEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const sensitive = /key|token|secret|password|passwd|auth/i.test(k);
    out[k] = sensitive ? '[masked]' : String(v).length > 60 ? String(v).slice(0, 57) + '…' : String(v);
  }
  return out;
}

function readSettings(file) {
  const raw = readJsonSafe(file);
  if (!raw) return null;
  const perms = raw.permissions || {};
  return {
    file,
    keys: Object.keys(raw),
    hooks: summarizeHooks(raw.hooks),
    permissions: {
      allow: Array.isArray(perms.allow) ? perms.allow.length : 0,
      deny: Array.isArray(perms.deny) ? perms.deny.length : 0,
      ask: Array.isArray(perms.ask) ? perms.ask.length : 0,
      defaultMode: perms.defaultMode || null,
      allowRules: Array.isArray(perms.allow) ? perms.allow.slice(0, 200) : [],
      denyRules: Array.isArray(perms.deny) ? perms.deny.slice(0, 200) : [],
    },
    statusLine: !!raw.statusLine,
    model: raw.model || null,
    env: maskEnv(raw.env),
    enabledPlugins: raw.enabledPlugins && typeof raw.enabledPlugins === 'object' ? Object.entries(raw.enabledPlugins).filter(([, v]) => v).map(([k]) => k) : [],
    disabledPlugins: raw.enabledPlugins && typeof raw.enabledPlugins === 'object' ? Object.entries(raw.enabledPlugins).filter(([, v]) => !v).map(([k]) => k) : [],
    extraKnownMarketplaces: raw.extraKnownMarketplaces ? Object.keys(raw.extraKnownMarketplaces) : [],
    outputStyle: raw.outputStyle || null,
    cleanupPeriodDays: raw.cleanupPeriodDays ?? null,
    alwaysThinkingEnabled: raw.alwaysThinkingEnabled ?? null,
    language: raw.language || null,
    attribution: raw.attribution || (raw.includeCoAuthoredBy === false ? { commit: 'off' } : null),
    disableAllHooks: raw.disableAllHooks === true,
    autoMemory: raw.autoMemoryEnabled ?? null,
    enableAllProjectMcpServers: raw.enableAllProjectMcpServers === true,
    enabledMcpjsonServers: stringList(raw.enabledMcpjsonServers),
    disabledMcpjsonServers: stringList(raw.disabledMcpjsonServers),
  };
}

function stringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/**
 * Which topics a CLAUDE.md already covers, so recipes do not add duplicate rules.
 * JS `\w` and `\b` only know ASCII letters, so the Russian alternatives use \p{L} and a Unicode-aware lookahead (flag u).
 */
export function claudeMdHints(text) {
  const t = String(text || '');
  return {
    language: /(respond|answer|reply|write)\s+(?:always\s+)?in\s+[a-z]+|отвеча\p{L}+\s+(?:всегда\s+)?(?:на|по-)\s*русск|по-русски|на русском|язык ответ|language:/iu.test(t),
    tests: /\b(run|execute)\s+(the\s+)?tests?\b|\btests?\s+(before|after|must)|запус\p{L}+\s+тест|прогон\p{L}+\s+тест|перед коммитом.*тест/iu.test(t),
    commits: /\bcommit(s)?\b.*\b(message|style|convention|format)|коммит\p{L}*\s.*(сообщен|стил|формат)|co-authored-by/iu.test(t),
    autonomy: /don'?t ask|without asking|autonomous|не спрашива|без подтвержден|автономн/iu.test(t),
    readBeforeEdit: /read\b.*\bbefore\b.*\bedit|re-?read\b|перед (правкой|редактированием).*(прочит|чита)|перечит/iu.test(t),
    verification: /verify\b|verification|before (saying|claiming|calling it) done|проверь(?![\p{L}\p{N}_])|перед словом «?готово|ship-check/iu.test(t),
  };
}

/** `@path` imports of a CLAUDE.md, resolved against the importing file. */
function importedFiles(file, text) {
  const out = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) out.push(path.resolve(path.dirname(file), m[1]));
  return out;
}

function sameFile(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function claudeMdEntry(scope, file, text) {
  const imports = (text.match(/^@[^\s]+$/gm) || []).length;
  return { scope, file, chars: text.length, tokens: estimateTokens(text), lines: text.split('\n').length, imports, hints: claudeMdHints(text), kaizenBlocks: (text.match(/<!-- kaizen:start /g) || []).length };
}

/** Every *.md file under a rules directory, subdirectories included (Claude Code walks them), symlinks followed once. */
function ruleFiles(dir, seen = new Set(), depth = 0) {
  let real;
  let entries;
  try {
    real = fs.realpathSync(dir);
    if (seen.has(real) || depth > 10) return [];
    seen.add(real);
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // dangling symlink
    }
    if (st.isDirectory()) out.push(...ruleFiles(full, seen, depth + 1));
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Rules directory: only rules that load on every request count toward tokens. A rule with `paths:` frontmatter loads
 * when matching files are touched, so it is reported separately. Unreadable entries (dangling symlinks) are skipped.
 */
function rulesEntry(scope, dir) {
  let files = 0;
  let chars = 0;
  let conditionalFiles = 0;
  let conditionalChars = 0;
  for (const full of ruleFiles(dir)) {
    let size;
    let text;
    try {
      size = fs.statSync(full).size;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (isPathScoped(text)) {
      conditionalFiles++;
      conditionalChars += size;
    } else {
      files++;
      chars += size;
    }
  }
  if (!files && !conditionalFiles) return null;
  return { scope, file: dir, files, chars, tokens: estimateTokens(' '.repeat(chars)), conditionalFiles, conditionalChars };
}

/**
 * CLAUDE.md files of the directories above the project (parent up to, not including, the filesystem root), read but not
 * counted: they only decide whether AGENTS.md is used. The user's own CLAUDE.md (config dir, or ~/.claude of the
 * default profile) is the user file, not a project file, and does not count for that.
 */
function ancestorClaudeMds(projectDir, cfg) {
  const out = [];
  const userFiles = [path.join(cfg, 'CLAUDE.md'), path.join(homeDir(), '.claude', 'CLAUDE.md')];
  try {
    userFiles.push(path.join(os.userInfo().homedir, '.claude', 'CLAUDE.md'));
  } catch {
    // no user record
  }
  let dir = path.resolve(projectDir);
  for (let up = path.dirname(dir); up !== dir && up !== path.parse(up).root; up = path.dirname(dir)) {
    dir = up;
    for (const file of [path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md')]) {
      if (userFiles.some((u) => sameFile(file, u))) continue;
      const text = readTextSafe(file);
      if (text !== null) out.push({ file, text });
    }
  }
  return out;
}

function claudeMdFiles(projectDir, cfg) {
  const out = [];
  const add = (entry) => entry && out.push(entry);
  const read = (scope, file) => {
    if (!exists(file)) return null;
    const text = readTextSafe(file);
    if (text === null) return null;
    add(claudeMdEntry(scope, file, text));
    return text;
  };
  read('user', path.join(cfg, 'CLAUDE.md'));
  if (exists(path.join(cfg, 'rules'))) add(rulesEntry('user-rules', path.join(cfg, 'rules')));
  if (!projectDir) return out;
  const texts = [];
  for (const [scope, file] of [
    ['project', path.join(projectDir, 'CLAUDE.md')],
    ['project', path.join(projectDir, '.claude', 'CLAUDE.md')],
    ['local', path.join(projectDir, 'CLAUDE.local.md')],
  ]) {
    const text = read(scope, file);
    if (text !== null) texts.push({ file, text });
  }
  if (exists(path.join(projectDir, '.claude', 'rules'))) add(rulesEntry('project-rules', path.join(projectDir, '.claude', 'rules')));
  // Claude Code reads AGENTS.md / .claude/AGENTS.md only when neither the project nor any ancestor directory has a
  // CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md; with one, AGENTS.md counts only when a CLAUDE.md imports it.
  texts.push(...ancestorClaudeMds(projectDir, cfg));
  const imported = texts.flatMap((t) => importedFiles(t.file, t.text));
  for (const file of [path.join(projectDir, 'AGENTS.md'), path.join(projectDir, '.claude', 'AGENTS.md')]) {
    if (!texts.length || imported.some((i) => sameFile(i, file))) read('agents-md', file);
  }
  return out;
}

function uniq(list) {
  return [...new Set(list)];
}

/**
 * MCP servers by scope. Servers of the shared .mcp.json need approval: they are active only when enabled
 * (enableAllProjectMcpServers, enabledMcpjsonServers) and not in disabledMcpjsonServers; the lists come from every
 * settings file (managed included) and from the project's entry in the global config.
 */
function mcpServers(projectDir, settings) {
  const out = { user: [], project: [], local: [], disabledProject: [], pendingProject: [], disabledHere: [] };
  const globalCfg = readJsonSafe(globalConfigPath());
  if (globalCfg && globalCfg.mcpServers && typeof globalCfg.mcpServers === 'object') {
    out.user = Object.keys(globalCfg.mcpServers);
  }
  if (projectDir) {
    const mcpJson = readJsonSafe(path.join(projectDir, '.mcp.json'));
    if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') out.project = Object.keys(mcpJson.mcpServers);
    // the project's entry is keyed with forward slashes on Windows, so the native path is matched normalised
    const key = globalCfg ? projectConfigKey(globalCfg.projects, projectDir) : null;
    const proj = key ? globalCfg.projects[key] : null;
    if (proj && proj.mcpServers && typeof proj.mcpServers === 'object') out.local = Object.keys(proj.mcpServers);
    const disabled = uniq([...stringList(proj && proj.disabledMcpjsonServers), ...settings.flatMap((s) => s.disabledMcpjsonServers)]);
    const enabled = new Set([...stringList(proj && proj.enabledMcpjsonServers), ...settings.flatMap((s) => s.enabledMcpjsonServers)]);
    const enableAll = (proj && proj.enableAllProjectMcpServers === true) || settings.some((s) => s.enableAllProjectMcpServers);
    out.disabledProject = disabled;
    // switched off with /mcp for this project: not connected, so it costs no context here
    out.disabledHere = uniq(stringList(proj && proj.disabledMcpServers));
    out.pendingProject = enableAll ? [] : out.project.filter((n) => !disabled.includes(n) && !enabled.has(n));
  }
  return out;
}

/**
 * The installed_plugins.json entry that applies here: local-scope for this project, then project-scope, then user
 * (an entry without a scope is a legacy user install). Undefined when the plugin is installed only for other projects.
 */
function pickInstall(entries, projectDir) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && typeof e === 'object');
  const here = (e) => projectDir && typeof e.projectPath === 'string' && sameFile(e.projectPath, projectDir);
  return list.find((e) => e.scope === 'local' && here(e)) || list.find((e) => e.scope === 'project' && here(e)) || list.find((e) => e.scope === 'user' || e.scope === 'managed' || typeof e.scope !== 'string');
}

function plugins(cfg, projectDir, enabledMap) {
  const installed = readJsonSafe(path.join(cfg, 'plugins', 'installed_plugins.json'));
  const list = [];
  if (installed && installed.plugins && typeof installed.plugins === 'object') {
    for (const [key, entries] of Object.entries(installed.plugins)) {
      const e = pickInstall(entries, projectDir);
      if (!e) continue; // installed with local or project scope for another project only: not present here
      const [name, marketplace] = key.split('@');
      const installPath = e.installPath;
      let components = null;
      if (installPath && exists(installPath)) {
        components = {
          skills: listSkills(path.join(installPath, 'skills'), 'plugin').length,
          agents: listAgents(path.join(installPath, 'agents'), 'plugin').length,
          hooks: pluginHookMaps(installPath).length > 0,
          mcp: exists(path.join(installPath, '.mcp.json')),
        };
      }
      list.push({ name, marketplace, version: e.version, installPath, components, enabled: enabledMap[key] !== false });
    }
  }
  const marketplaces = readJsonSafe(path.join(cfg, 'plugins', 'known_marketplaces.json')) || {};
  return { installed: list, marketplaces: Object.keys(marketplaces) };
}

/** The event map of a hooks file or inline manifest value: `{"hooks": {...}}` wrapper or the bare map. */
function hookMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : raw;
}

/**
 * Hook maps a plugin declares: the conventional hooks/hooks.json, plus whatever .claude-plugin/plugin.json `hooks` holds
 * (an inline object, a path, or an array of paths/objects; paths are relative to the plugin and must stay inside it).
 */
function pluginHookMaps(installPath) {
  const maps = [];
  const seen = new Set();
  const addFile = (file) => {
    const real = path.resolve(file);
    if (seen.has(real.toLowerCase())) return;
    seen.add(real.toLowerCase());
    const m = hookMap(readJsonSafe(real));
    if (m) maps.push(m);
  };
  addFile(path.join(installPath, 'hooks', 'hooks.json'));
  const manifest = readJsonSafe(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const declared = manifest && typeof manifest === 'object' ? manifest.hooks : null;
  for (const item of Array.isArray(declared) ? declared : [declared]) {
    if (typeof item === 'string') {
      const file = path.resolve(installPath, item);
      const rel = path.relative(path.resolve(installPath), file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) addFile(file);
    } else {
      const m = hookMap(item);
      if (m) maps.push(m);
    }
  }
  return maps.filter((m) => summarizeHooks(m).total > 0);
}

/** Hooks an enabled plugin registers (hooks/hooks.json and the manifest). Kaizen's own nudge hook is not counted. */
function pluginHooks(p) {
  if (p.name === 'kaizen' || !p.installPath) return null;
  const parts = pluginHookMaps(p.installPath).map(summarizeHooks);
  if (!parts.length) return null;
  const hooks = { events: {}, commands: [], total: 0 };
  for (const part of parts) {
    hooks.total += part.total;
    hooks.commands.push(...part.commands);
    for (const [ev, n] of Object.entries(part.events)) hooks.events[ev] = (hooks.events[ev] || 0) + n;
  }
  return { scope: `plugin:${p.name}`, hooks };
}

/**
 * Build the configuration inventory.
 * @param {{projectDir?: string}} opts
 */
export function inventory({ projectDir = null } = {}) {
  const cfg = configDir();
  const settings = [];
  // managed settings come last (highest precedence) and are only ever read
  for (const { scope, file } of [...settingsFiles(projectDir, cfg), ...managedSettingsFiles()]) {
    const s = readSettings(file);
    if (s) settings.push({ scope, ...s });
  }
  // effective enabledPlugins: later (higher-precedence) files override earlier ones
  const enabledMap = {};
  for (const s of settings) {
    for (const k of s.enabledPlugins) enabledMap[k] = true;
    for (const k of s.disabledPlugins) enabledMap[k] = false;
  }
  const skills = [
    ...listSkills(path.join(cfg, 'skills'), 'user'),
    ...(projectDir ? listSkills(path.join(projectDir, '.claude', 'skills'), 'project') : []),
  ];
  const legacyCommands = [cfg, projectDir ? path.join(projectDir, '.claude') : null]
    .filter(Boolean)
    .map((d) => path.join(d, 'commands'))
    .filter(exists)
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => ({ name: f.replace(/\.md$/, ''), dir: d })));
  const agents = [
    ...listAgents(path.join(cfg, 'agents'), 'user'),
    ...(projectDir ? listAgents(path.join(projectDir, '.claude', 'agents'), 'project') : []),
  ];
  const pl = plugins(cfg, projectDir, enabledMap);
  const fromPlugins = [];
  for (const p of pl.installed) {
    // a plugin switched off in enabledPlugins contributes no skills, agents or hooks to Claude Code
    if (!p.enabled || !p.installPath || !exists(p.installPath)) continue;
    skills.push(...listSkills(path.join(p.installPath, 'skills'), `plugin:${p.name}`));
    agents.push(...listAgents(path.join(p.installPath, 'agents'), `plugin:${p.name}`));
    const ph = pluginHooks(p);
    if (ph) fromPlugins.push(ph);
  }
  const claudeMd = claudeMdFiles(projectDir, cfg);
  const memoryDir = path.join(cfg, 'projects');
  const hookSources = [...settings.map((s) => ({ scope: s.scope, hooks: s.hooks })), ...fromPlugins];
  const hooksTotal = hookSources.reduce((a, s) => a + s.hooks.total, 0);
  const hookEvents = {};
  for (const s of hookSources) for (const [ev, n] of Object.entries(s.hooks.events)) hookEvents[ev] = (hookEvents[ev] || 0) + n;

  return {
    configDir: cfg,
    projectDir,
    settings,
    hooks: { total: hooksTotal, events: hookEvents, commands: hookSources.flatMap((s) => s.hooks.commands.map((c) => ({ scope: s.scope, ...c }))) },
    permissions: {
      allow: settings.reduce((a, s) => a + s.permissions.allow, 0),
      deny: settings.reduce((a, s) => a + s.permissions.deny, 0),
      ask: settings.reduce((a, s) => a + s.permissions.ask, 0),
      defaultMode: settings.map((s) => s.permissions.defaultMode).filter(Boolean).pop() || 'default',
      allowRules: settings.flatMap((s) => s.permissions.allowRules),
      denyRules: settings.flatMap((s) => s.permissions.denyRules),
    },
    statusLine: settings.some((s) => s.statusLine),
    skills,
    legacyCommands,
    agents,
    plugins: pl,
    mcp: mcpServers(projectDir, settings),
    claudeMd,
    claudeMdTokens: claudeMd.reduce((a, f) => a + (f.tokens || 0), 0),
    skillDescriptionTokens: skills.reduce((a, s) => a + estimateTokens(' '.repeat(s.descriptionChars)), 0),
    hasAutoMemory: exists(memoryDir),
  };
}
