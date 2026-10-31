// Inventory of the user's current Claude Code configuration: settings files,
// hooks, permissions, skills, agents, plugins, MCP servers, CLAUDE.md files.
// Reads structure and sizes only; never copies secrets (env values are masked).
import fs from 'node:fs';
import path from 'node:path';
import { configDir, exists, homeDir, readJsonSafe, settingsFiles } from './paths.mjs';

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

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
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
  };
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

function claudeMdFiles(projectDir, cfg) {
  const candidates = [
    { scope: 'user', file: path.join(cfg, 'CLAUDE.md') },
    { scope: 'user-rules', dir: path.join(cfg, 'rules') },
  ];
  if (projectDir) {
    candidates.push({ scope: 'project', file: path.join(projectDir, 'CLAUDE.md') });
    candidates.push({ scope: 'project', file: path.join(projectDir, '.claude', 'CLAUDE.md') });
    candidates.push({ scope: 'local', file: path.join(projectDir, 'CLAUDE.local.md') });
    candidates.push({ scope: 'project-rules', dir: path.join(projectDir, '.claude', 'rules') });
    candidates.push({ scope: 'agents-md', file: path.join(projectDir, 'AGENTS.md') });
  }
  const out = [];
  for (const c of candidates) {
    if (c.file && exists(c.file)) {
      const text = fs.readFileSync(c.file, 'utf8');
      const imports = (text.match(/^@[^\s]+$/gm) || []).length;
      out.push({ scope: c.scope, file: c.file, chars: text.length, tokens: estimateTokens(text), lines: text.split('\n').length, imports, hints: claudeMdHints(text), kaizenBlocks: (text.match(/<!-- kaizen:start /g) || []).length });
    } else if (c.dir && exists(c.dir)) {
      let chars = 0;
      let files = 0;
      for (const f of fs.readdirSync(c.dir)) {
        if (!f.endsWith('.md')) continue;
        files++;
        chars += fs.statSync(path.join(c.dir, f)).size;
      }
      if (files) out.push({ scope: c.scope, file: c.dir, files, chars, tokens: estimateTokens(' '.repeat(chars)) });
    }
  }
  return out;
}

function mcpServers(projectDir, cfg) {
  const out = { user: [], project: [], local: [], disabledProject: [] };
  const globalCfg = readJsonSafe(path.join(homeDir(), '.claude.json'));
  if (globalCfg && globalCfg.mcpServers && typeof globalCfg.mcpServers === 'object') {
    out.user = Object.keys(globalCfg.mcpServers);
  }
  if (projectDir) {
    const mcpJson = readJsonSafe(path.join(projectDir, '.mcp.json'));
    if (mcpJson && mcpJson.mcpServers) out.project = Object.keys(mcpJson.mcpServers);
    const proj = globalCfg && globalCfg.projects ? globalCfg.projects[projectDir] : null;
    if (proj) {
      if (proj.mcpServers) out.local = Object.keys(proj.mcpServers);
      if (Array.isArray(proj.disabledMcpjsonServers)) out.disabledProject = proj.disabledMcpjsonServers;
    }
  }
  // plugin-provided servers are visible in transcripts as mcp__plugin_<plugin>_<server>__tool
  void cfg;
  return out;
}

function plugins(cfg) {
  const installed = readJsonSafe(path.join(cfg, 'plugins', 'installed_plugins.json'));
  const list = [];
  if (installed && installed.plugins) {
    for (const [key, entries] of Object.entries(installed.plugins)) {
      const e = Array.isArray(entries) ? entries[0] : entries;
      const [name, marketplace] = key.split('@');
      const installPath = e && e.installPath;
      let components = null;
      if (installPath && exists(installPath)) {
        components = {
          skills: listSkills(path.join(installPath, 'skills'), 'plugin').length,
          agents: listAgents(path.join(installPath, 'agents'), 'plugin').length,
          hooks: exists(path.join(installPath, 'hooks', 'hooks.json')),
          mcp: exists(path.join(installPath, '.mcp.json')),
        };
      }
      list.push({ name, marketplace, version: e && e.version, installPath, components });
    }
  }
  const marketplaces = readJsonSafe(path.join(cfg, 'plugins', 'known_marketplaces.json')) || {};
  return { installed: list, marketplaces: Object.keys(marketplaces) };
}

/**
 * Build the configuration inventory.
 * @param {{projectDir?: string}} opts
 */
export function inventory({ projectDir = null } = {}) {
  const cfg = configDir();
  const settings = [];
  for (const { scope, file } of settingsFiles(projectDir, cfg)) {
    const s = readSettings(file);
    if (s) settings.push({ scope, ...s });
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
  const pl = plugins(cfg);
  for (const p of pl.installed) {
    if (p.installPath && exists(p.installPath)) {
      skills.push(...listSkills(path.join(p.installPath, 'skills'), `plugin:${p.name}`));
      agents.push(...listAgents(path.join(p.installPath, 'agents'), `plugin:${p.name}`));
    }
  }
  const claudeMd = claudeMdFiles(projectDir, cfg);
  const memoryDir = path.join(cfg, 'projects');
  const hooksTotal = settings.reduce((a, s) => a + s.hooks.total, 0);
  const hookEvents = {};
  for (const s of settings) for (const [ev, n] of Object.entries(s.hooks.events)) hookEvents[ev] = (hookEvents[ev] || 0) + n;

  return {
    configDir: cfg,
    projectDir,
    settings,
    hooks: { total: hooksTotal, events: hookEvents, commands: settings.flatMap((s) => s.hooks.commands.map((c) => ({ scope: s.scope, ...c }))) },
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
    mcp: mcpServers(projectDir, cfg),
    claudeMd,
    claudeMdTokens: claudeMd.reduce((a, f) => a + (f.tokens || 0), 0),
    skillDescriptionTokens: skills.reduce((a, s) => a + estimateTokens(' '.repeat(s.descriptionChars)), 0),
    hasAutoMemory: exists(memoryDir),
  };
}
