// Apply engine: turns chosen recipes into settings/file changes with a journal
// that `undo` can replay backwards. Every write is idempotent and backed up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, ensureDir, exists, expandHome, homeDir, kitRoot, readJsonSafe, settingsFiles, stateDir, toPosix, writeJsonAtomic } from './paths.mjs';
import { nodeCommand } from './platform.mjs';
import { actionApplies, loadCatalog, resolvePath } from './recipes.mjs';
import { translator } from './i18n.mjs';

const TEMPLATES = path.join(kitRoot(), 'recipes', 'templates');

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readJsonOrEmpty(file) {
  if (!exists(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw); // let a corrupt settings file fail loudly before we touch it
}

function writeJsonPretty(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.kaizen-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur && cur[parts[i]];
    if (!cur) return;
  }
  delete cur[parts[parts.length - 1]];
}

/** Resolve {placeholders} in action strings. */
export function buildContext({ scope = 'user', projectDir = null, params = {} }) {
  const cfg = configDir();
  const home = stateDir();
  const proj = projectDir ? path.resolve(projectDir) : null;
  if (scope === 'project' && !proj) throw new Error('project scope requested but no project directory given (use --project DIR or run inside the project)');
  const ctx = {
    scope,
    node: nodeCommand().replace(/\\/g, '/'),
    kaizenHome: toPosix(home),
    configDir: toPosix(cfg),
    projectDir: proj ? toPosix(proj) : '',
    skillsDir: scope === 'project' ? toPosix(path.join(proj, '.claude', 'skills')) : toPosix(path.join(cfg, 'skills')),
    agentsDir: scope === 'project' ? toPosix(path.join(proj, '.claude', 'agents')) : toPosix(path.join(cfg, 'agents')),
    claudeMd: scope === 'project' ? toPosix(path.join(proj, 'CLAUDE.md')) : toPosix(path.join(cfg, 'CLAUDE.md')),
    settingsFile: scope === 'project' ? path.join(proj, '.claude', 'settings.json') : path.join(cfg, 'settings.json'),
    globalConfig: path.join(homeDir(), '.claude.json'),
    params,
  };
  return ctx;
}

export function fill(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{(node|kaizenHome|configDir|projectDir|skillsDir|agentsDir|claudeMd)\}/g, (m, k) => ctx[k] ?? m).replace(/\{params\.([a-zA-Z0-9_]+)\}/g, (m, k) => {
    const v = ctx.params[k];
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v.join(',') : String(v);
  });
}

function fillDeep(value, ctx) {
  if (typeof value === 'string') return fill(value, ctx);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, ctx)]));
  return value;
}

/**
 * Template files use {{param}} placeholders. Arrays join with commas.
 * In JavaScript templates the placeholders sit inside single-quoted string
 * literals, so values are escaped for that context (`\`, `'`, newlines).
 */
export function renderTemplate(text, params, { js = false } = {}) {
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (m, k) => {
    const v = params[k];
    if (v === undefined || v === null) return m; // leave unreplaced; scripts fall back to defaults
    const str = Array.isArray(v) ? v.join(',') : String(v);
    return js ? str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') : str;
  });
}

function renderTemplateFile(template, params) {
  return renderTemplate(fs.readFileSync(path.join(TEMPLATES, template), 'utf8'), params, { js: /\.(mjs|cjs|js)$/.test(template) });
}

function hookIdentity(h) {
  return `${h.type || 'command'}|${h.command || h.prompt || ''}`;
}

// ------------------------------------------------------------- action handlers
// Each returns a journal entry (or null when nothing changed). `dry` = describe only.

const handlers = {
  'settings.hook'(a, ctx, io) {
    const file = ctx.settingsFile;
    const settings = io.load(file);
    settings.hooks ||= {};
    const list = (settings.hooks[a.event] ||= []);
    const entry = { type: 'command', command: fill(a.command, ctx) };
    if (a.timeout) entry.timeout = a.timeout;
    if (a.async) entry.async = true;
    if (a.if) entry.if = a.if;
    const id = hookIdentity(entry);
    for (const group of list) for (const h of group.hooks || []) if (hookIdentity(h) === id) return { skipped: true, reason: 'hook already present', file, event: a.event, command: entry.command };
    const group = { hooks: [entry] };
    if (a.matcher) group.matcher = a.matcher;
    io.describe(`${file}: add ${a.event} hook${a.matcher ? ` [${a.matcher}]` : ''} → ${entry.command}`);
    if (!io.dry) {
      list.push(group);
      io.save(file, settings);
    }
    return { type: 'settings.hook', file, event: a.event, matcher: a.matcher || null, identity: id };
  },

  'settings.set'(a, ctx, io) {
    const file = ctx.settingsFile;
    const settings = io.load(file);
    const value = fillDeep(a.value, ctx);
    const prev = getPath(settings, a.path);
    if (JSON.stringify(prev) === JSON.stringify(value)) return { skipped: true, reason: 'already set', file, path: a.path };
    io.describe(`${file}: set ${a.path} = ${JSON.stringify(value)}${prev !== undefined ? ` (was ${JSON.stringify(prev)})` : ''}`);
    if (!io.dry) {
      setPath(settings, a.path, value);
      io.save(file, settings);
    }
    return { type: 'settings.set', file, path: a.path, previous: prev === undefined ? null : prev, hadPrevious: prev !== undefined, value };
  },

  'settings.append'(a, ctx, io) {
    const file = ctx.settingsFile;
    const settings = io.load(file);
    let values = a.values ? fillDeep(a.values, ctx) : [];
    if (a.valuesFrom) {
      const src = resolvePath(io.measure || {}, a.valuesFrom) || [];
      values = values.concat(src.map((x) => (a.field && x && typeof x === 'object' ? x[a.field] : x)).filter((x) => typeof x === 'string'));
    }
    if (a.limit) values = values.slice(0, a.limit);
    const current = getPath(settings, a.path);
    const arr = Array.isArray(current) ? current : [];
    const added = values.filter((v) => !arr.includes(v));
    if (!added.length) return { skipped: true, reason: 'nothing new to add', file, path: a.path };
    io.describe(`${file}: append to ${a.path}: ${added.join(', ')}`);
    if (!io.dry) {
      setPath(settings, a.path, arr.concat(added));
      io.save(file, settings);
    }
    return { type: 'settings.append', file, path: a.path, added };
  },

  file(a, ctx, io) {
    const target = expandHome(fill(a.target, ctx));
    const content = a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx);
    return writeManaged(target, content, io, { executable: !!a.executable });
  },

  skill(a, ctx, io) {
    const name = fill(a.name, ctx).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('skill action: empty name');
    if (a.content && paramsUnfilled(a.content, ctx.params)) return { skipped: true, reason: `skill ${name}: text parameter not filled in (ask Claude to draft it, then re-apply)` };
    let content = a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx);
    if (!content.trim()) throw new Error(`skill ${name}: empty content`);
    if (!/^---\r?\n/.test(content)) content = `---\nname: ${name}\ndescription: ${name.replace(/-/g, ' ')}\n---\n\n${content}`;
    const target = path.join(ctx.skillsDir, name, 'SKILL.md');
    return writeManaged(target, content, io, { createdDir: path.join(ctx.skillsDir, name) });
  },

  agent(a, ctx, io) {
    const name = fill(a.name, ctx).trim();
    const content = a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx);
    const target = path.join(ctx.agentsDir, `${name}.md`);
    return writeManaged(target, content, io);
  },

  'claude-md.block'(a, ctx, io) {
    const target = expandHome(fill(a.target || '{claudeMd}', ctx));
    const id = a.id || io.recipeId;
    if (a.content && paramsUnfilled(a.content, ctx.params)) return { skipped: true, reason: 'text parameter not filled in (ask Claude to draft it, then re-apply)', id };
    const body = (a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx)).trim();
    if (!body) throw new Error(`claude-md.block ${id}: empty content`);
    const start = `<!-- kaizen:start ${id} -->`;
    const end = `<!-- kaizen:end ${id} -->`;
    const block = `${start}\n${body}\n${end}`;
    const existing = exists(target) ? fs.readFileSync(target, 'utf8') : '';
    const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
    let next;
    let had = false;
    if (re.test(existing)) {
      had = true;
      if (existing.match(re)[0] === block) return { skipped: true, reason: 'block unchanged', file: target, id };
      next = existing.replace(re, block);
    } else {
      next = existing.replace(/\s*$/, '') + (existing.trim() ? '\n\n' : '') + block + '\n';
    }
    io.describe(`${target}: ${had ? 'update' : 'add'} rules block "${id}" (${body.split('\n').length} lines)`);
    if (!io.dry) {
      io.backup(target);
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, next, 'utf8');
    }
    return { type: 'claude-md.block', file: target, id, existedBefore: exists(target) && existing.length > 0, previousBlock: had ? existing.match(re)[0] : null };
  },

  'mcp.disable'(a, ctx, io) {
    const servers = (Array.isArray(a.servers) ? a.servers : String(fill(a.servers, ctx)).split(',')).map((s) => s.trim()).filter(Boolean);
    if (!servers.length) return { skipped: true, reason: 'no servers selected' };
    const file = ctx.globalConfig;
    const cfg = io.load(file);
    const removed = [];
    for (const name of servers) {
      if (cfg.mcpServers && cfg.mcpServers[name]) {
        removed.push({ name, config: cfg.mcpServers[name] });
        if (!io.dry) delete cfg.mcpServers[name];
      }
    }
    if (!removed.length) return { skipped: true, reason: 'servers not found in ~/.claude.json mcpServers', file };
    io.describe(`${file}: remove MCP servers ${removed.map((r) => r.name).join(', ')} (definitions kept in the journal)`);
    if (!io.dry) io.save(file, cfg);
    return { type: 'mcp.disable', file, removed };
  },

  'settings.hook.remove'(a, ctx, io) {
    const commands = (Array.isArray(a.commands) ? a.commands : String(fill(a.commands, ctx)).split(/\n|,(?=\S*(?:node|"|\/|[A-Za-z]:))/)).map((s) => s.trim()).filter(Boolean);
    if (!commands.length) return { skipped: true, reason: 'no hooks selected' };
    const norm = (c) => String(c).replace(/\s+/g, ' ').trim();
    const wanted = new Set(commands.map(norm));
    const removed = [];
    for (const { file } of settingsFiles(ctx.projectDir || null, configDir())) {
      if (!exists(file)) continue;
      const settings = io.load(file);
      let changed = false;
      for (const [event, groups] of Object.entries(settings.hooks || {})) {
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          const keep = [];
          for (const h of g.hooks || []) {
            if (typeof h.command === 'string' && wanted.has(norm(h.command))) {
              removed.push({ file, event, matcher: g.matcher || null, hook: h });
              changed = true;
            } else keep.push(h);
          }
          g.hooks = keep;
        }
        settings.hooks[event] = groups.filter((g) => g.hooks && g.hooks.length);
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (changed) {
        io.describe(`${file}: remove ${removed.filter((r) => r.file === file).length} failing hook entr${removed.filter((r) => r.file === file).length === 1 ? 'y' : 'ies'}`);
        if (!io.dry) io.save(file, settings);
      }
    }
    if (!removed.length) return { skipped: true, reason: 'selected hook commands not found in settings files' };
    return { type: 'settings.hook.remove', removed };
  },

  'plugins.disable'(a, ctx, io) {
    const plugins = (Array.isArray(a.plugins) ? a.plugins : String(fill(a.plugins, ctx)).split(',')).map((s) => s.trim()).filter(Boolean);
    if (!plugins.length) return { skipped: true, reason: 'no plugins selected' };
    const file = path.join(configDir(), 'settings.json');
    const settings = io.load(file);
    settings.enabledPlugins ||= {};
    const changed = [];
    for (const p of plugins) {
      if (settings.enabledPlugins[p] === false) continue;
      changed.push({ plugin: p, previous: settings.enabledPlugins[p] === undefined ? null : settings.enabledPlugins[p] });
      if (!io.dry) settings.enabledPlugins[p] = false;
    }
    if (!changed.length) return { skipped: true, reason: 'already disabled', file };
    io.describe(`${file}: disable plugins ${changed.map((c) => c.plugin).join(', ')}`);
    if (!io.dry) io.save(file, settings);
    return { type: 'plugins.disable', file, changed };
  },
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the content references {params.x} placeholders and every one of them is empty. */
function paramsUnfilled(content, params) {
  const refs = [...String(content).matchAll(/\{params\.([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]);
  if (!refs.length) return false;
  return refs.every((k) => {
    const v = params[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
  });
}

function writeManaged(target, content, io, extra = {}) {
  const existed = exists(target);
  const current = existed ? fs.readFileSync(target, 'utf8') : null;
  if (existed && current === content) return { skipped: true, reason: 'identical file exists', file: target };
  const ours = io.ownedFiles.has(path.resolve(target));
  if (existed && !ours && !io.force && !target.replace(/\\/g, '/').includes(toPosix(stateDir()))) {
    return { skipped: true, reason: 'file exists and was not created by Kaizen (use --force to overwrite)', file: target };
  }
  io.describe(`${target}: ${existed ? 'overwrite' : 'create'} (${content.length} chars)`);
  if (!io.dry) {
    if (existed) io.backup(target);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content, 'utf8');
    if (extra.executable && process.platform !== 'win32') fs.chmodSync(target, 0o755);
  }
  return { type: 'file', file: target, existedBefore: existed, hash: sha(content), createdDir: extra.createdDir || null };
}

// ------------------------------------------------------------- journal helpers

function journalDir() {
  return path.join(stateDir(), 'applied');
}

function listManifests() {
  const dir = journalDir();
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((id) => ({ id, dir: path.join(dir, id), manifest: readJsonSafe(path.join(dir, id, 'manifest.json')) }))
    .filter((m) => m.manifest);
}

function ownedFiles() {
  const set = new Set();
  for (const m of listManifests()) {
    if (m.manifest.undone) continue;
    for (const r of m.manifest.recipes || []) for (const a of r.actions || []) if (a.type === 'file' && a.file) set.add(path.resolve(a.file));
  }
  return set;
}

function makeIo({ dry, force, measure, batchDir, recipeId }) {
  const cache = new Map();
  const described = [];
  const backedUp = new Set();
  return {
    dry,
    force,
    measure,
    recipeId,
    ownedFiles: ownedFiles(),
    described,
    describe(line) {
      described.push(line);
    },
    load(file) {
      if (!cache.has(file)) cache.set(file, readJsonOrEmpty(file));
      return cache.get(file);
    },
    save(file, data) {
      this.backup(file);
      writeJsonPretty(file, data);
      cache.set(file, data);
    },
    backup(file) {
      if (dry || backedUp.has(file) || !exists(file)) return;
      backedUp.add(file);
      const dest = path.join(batchDir, 'backups', file.replace(/[:\\/]/g, '_'));
      ensureDir(path.dirname(dest));
      fs.copyFileSync(file, dest);
    },
  };
}

// ------------------------------------------------------------- apply

export function loadChoices(args) {
  const state = stateDir();
  const file = args._[1] ? path.resolve(args._[1]) : path.join(state, 'choices.json');
  if (args.flags.recipe) {
    const rec = readJsonSafe(path.join(state, 'recommendations.json'));
    const ids = String(args.flags.recipe).split(',').map((s) => s.trim()).filter(Boolean);
    const selected = ids.map((id) => {
      const r = rec && rec.recommendations.find((x) => x.id === id);
      return { id, scope: args.flags.scope || (r && r.scope) || 'user', params: Object.fromEntries((r ? r.params : []).map((p) => [p.name, p.value])) };
    });
    return { version: 1, source: 'cli', selected, discuss: [], notes: '' };
  }
  const choices = readJsonSafe(file);
  if (!choices) throw new Error(`No choices file at ${file}. Run \`kaizen console\` or pass --recipe id[,id].`);
  return choices;
}

function applyParamOverrides(selected, flags) {
  const list = Array.isArray(flags.param) ? flags.param : flags.param ? [flags.param] : [];
  for (const spec of list) {
    const m = String(spec).match(/^([a-z0-9.-]+)\.([a-zA-Z0-9_]+)=(.*)$/);
    if (!m) throw new Error(`--param expects recipe.id.param=value, got: ${spec}`);
    const sel = selected.find((s) => s.id === m[1]);
    if (sel) sel.params = { ...(sel.params || {}), [m[2]]: m[3].includes(',') ? m[3].split(',') : m[3] };
  }
}

export async function cmdApply(args, { loadMeasure, pickLang }) {
  const flags = args.flags;
  const dry = !!flags['dry-run'];
  const measure = loadMeasure();
  const lang = pickLang(flags, measure);
  const t = translator(lang);
  const catalog = loadCatalog();
  const rec = readJsonSafe(path.join(stateDir(), 'recommendations.json'));
  const choices = loadChoices(args);
  applyParamOverrides(choices.selected || [], flags);
  const projectDir = flags.project ? path.resolve(String(flags.project)) : process.env.CLAUDE_PROJECT_DIR || measure.env.projectDir || process.cwd();
  if (!choices.selected || !choices.selected.length) {
    process.stdout.write(t('cli.apply_nothing') + '\n');
    return { applied: 0 };
  }
  const batchId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const batchDir = path.join(journalDir(), batchId);
  const manifest = { id: batchId, at: new Date().toISOString(), kitVersion: catalog.version, lang, projectDir, dry, recipes: [], notes: choices.notes || '', discuss: choices.discuss || [] };
  const lines = [];
  for (const sel of choices.selected) {
    const recipe = catalog.recipes.find((r) => r.id === sel.id);
    if (!recipe) {
      lines.push(`! unknown recipe ${sel.id} (skipped)`);
      continue;
    }
    const recommended = rec && rec.recommendations.find((r) => r.id === sel.id);
    const params = {};
    for (const p of recipe.params || []) params[p.name] = p.default;
    if (recommended) for (const p of recommended.params || []) params[p.name] = p.value;
    Object.assign(params, sel.params || {});
    const scope = flags.scope || sel.scope || recipe.defaultScope || 'user';
    const ctx = buildContext({ scope, projectDir, params });
    const io = makeIo({ dry, force: !!flags.force, measure, batchDir, recipeId: recipe.id });
    const entries = [];
    for (const action of recipe.actions || []) {
      if (!actionApplies(action, measure)) {
        lines.push(`  · ${recipe.id}: ${action.type} skipped (condition not met)`);
        continue;
      }
      const handler = handlers[action.type];
      if (!handler) {
        lines.push(`! ${recipe.id}: unsupported action ${action.type}`);
        continue;
      }
      try {
        const entry = handler(action, ctx, io);
        if (entry && !entry.skipped) entries.push(entry);
        else if (entry && entry.skipped) lines.push(`  · ${recipe.id}: ${entry.reason}${entry.file ? ` (${entry.file})` : ''}`);
      } catch (err) {
        lines.push(`! ${recipe.id}: ${err.message}`);
      }
    }
    for (const d of io.described) lines.push(`  ${dry ? '→' : '✓'} ${d}`);
    manifest.recipes.push({ id: recipe.id, scope, params, actions: entries, advice: !(recipe.actions && recipe.actions.length) });
  }
  if (!dry) {
    ensureDir(batchDir);
    writeJsonAtomic(path.join(batchDir, 'manifest.json'), manifest);
    writeJsonAtomic(path.join(stateDir(), 'last-apply.json'), { id: batchId, at: manifest.at, recipes: manifest.recipes.map((r) => r.id) });
  }
  const out = lines.join('\n');
  if (out) process.stdout.write(out + '\n');
  const n = manifest.recipes.filter((r) => r.actions.length).length;
  process.stdout.write((dry ? t('cli.apply_dry', { n: manifest.recipes.reduce((a, r) => a + r.actions.length, 0) }) : t('cli.apply_done', { n, file: path.join(batchDir, 'manifest.json') })) + '\n');
  if (flags.json) process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ------------------------------------------------------------- undo

function undoEntry(e, io) {
  switch (e.type) {
    case 'settings.hook': {
      const s = io.load(e.file);
      const list = s.hooks && s.hooks[e.event];
      if (!Array.isArray(list)) return 'hook list missing';
      let removed = 0;
      for (const group of list) {
        const before = (group.hooks || []).length;
        group.hooks = (group.hooks || []).filter((h) => hookIdentity(h) !== e.identity);
        removed += before - group.hooks.length;
      }
      s.hooks[e.event] = list.filter((g) => g.hooks && g.hooks.length);
      if (!s.hooks[e.event].length) delete s.hooks[e.event];
      if (!Object.keys(s.hooks).length) delete s.hooks;
      io.describe(`${e.file}: remove ${e.event} hook ${e.identity.split('|')[1]}`);
      if (!io.dry) io.save(e.file, s);
      return removed ? 'ok' : 'hook was already gone';
    }
    case 'settings.set': {
      const s = io.load(e.file);
      const cur = getPath(s, e.path);
      if (JSON.stringify(cur) !== JSON.stringify(e.value)) return `kept: ${e.path} changed since apply`;
      if (e.hadPrevious) setPath(s, e.path, e.previous);
      else deletePath(s, e.path);
      io.describe(`${e.file}: restore ${e.path}`);
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'settings.append': {
      const s = io.load(e.file);
      const arr = getPath(s, e.path);
      if (!Array.isArray(arr)) return 'list missing';
      setPath(s, e.path, arr.filter((v) => !e.added.includes(v)));
      io.describe(`${e.file}: remove ${e.added.length} item(s) from ${e.path}`);
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'file': {
      if (!exists(e.file)) return 'file already removed';
      const cur = fs.readFileSync(e.file, 'utf8');
      if (sha(cur) !== e.hash) return `kept: ${e.file} modified since apply`;
      io.describe(`${e.file}: delete`);
      if (!io.dry) {
        io.backup(e.file);
        fs.unlinkSync(e.file);
        if (e.createdDir && exists(e.createdDir) && !fs.readdirSync(e.createdDir).length) fs.rmdirSync(e.createdDir);
      }
      return 'ok';
    }
    case 'claude-md.block': {
      if (!exists(e.file)) return 'file missing';
      const text = fs.readFileSync(e.file, 'utf8');
      const start = `<!-- kaizen:start ${e.id} -->`;
      const end = `<!-- kaizen:end ${e.id} -->`;
      const re = new RegExp(`\\n?\\n?${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`);
      if (!re.test(text)) return 'block already gone';
      const next = e.previousBlock ? text.replace(re, `\n\n${e.previousBlock}\n`) : text.replace(re, '\n');
      io.describe(`${e.file}: remove rules block "${e.id}"`);
      if (!io.dry) {
        io.backup(e.file);
        fs.writeFileSync(e.file, next.replace(/\n{3,}/g, '\n\n'), 'utf8');
      }
      return 'ok';
    }
    case 'mcp.disable': {
      const cfg = io.load(e.file);
      cfg.mcpServers ||= {};
      let restored = 0;
      for (const r of e.removed) if (!cfg.mcpServers[r.name]) {
        cfg.mcpServers[r.name] = r.config;
        restored++;
      }
      io.describe(`${e.file}: restore MCP servers ${e.removed.map((r) => r.name).join(', ')}`);
      if (!io.dry) io.save(e.file, cfg);
      return restored ? 'ok' : 'servers already present';
    }
    case 'settings.hook.remove': {
      let restored = 0;
      for (const r of e.removed) {
        const s = io.load(r.file);
        s.hooks ||= {};
        const list = (s.hooks[r.event] ||= []);
        const present = list.some((g) => (g.hooks || []).some((h) => hookIdentity(h) === hookIdentity(r.hook)));
        if (present) continue;
        const group = { hooks: [r.hook] };
        if (r.matcher) group.matcher = r.matcher;
        list.push(group);
        restored++;
        io.describe(`${r.file}: restore ${r.event} hook ${hookIdentity(r.hook).split('|')[1]}`);
        if (!io.dry) io.save(r.file, s);
      }
      return restored ? 'ok' : 'hooks already present';
    }
    case 'plugins.disable': {
      const s = io.load(e.file);
      s.enabledPlugins ||= {};
      for (const c of e.changed) {
        if (c.previous === null) delete s.enabledPlugins[c.plugin];
        else s.enabledPlugins[c.plugin] = c.previous;
      }
      io.describe(`${e.file}: re-enable plugins ${e.changed.map((c) => c.plugin).join(', ')}`);
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    default:
      return `unknown action type ${e.type}`;
  }
}

export async function cmdUndo(args, { pickLang }) {
  const flags = args.flags;
  const dry = !!flags['dry-run'];
  const t = translator(pickLang(flags, null));
  const manifests = listManifests().filter((m) => !m.manifest.undone && !m.manifest.dry);
  let targets;
  if (flags.all) targets = manifests.slice().reverse();
  else if (args._[1]) targets = manifests.filter((m) => m.id === args._[1]);
  else targets = manifests.slice(-1);
  if (!targets.length) {
    process.stdout.write(t('cli.undo_nothing') + '\n');
    return { undone: 0 };
  }
  let total = 0;
  for (const m of targets) {
    const io = makeIo({ dry, force: true, measure: null, batchDir: path.join(m.dir, 'undo'), recipeId: null });
    const results = [];
    for (const r of [...m.manifest.recipes].reverse()) {
      for (const e of [...(r.actions || [])].reverse()) {
        try {
          results.push({ recipe: r.id, type: e.type, result: undoEntry(e, io) });
        } catch (err) {
          results.push({ recipe: r.id, type: e.type, result: `error: ${err.message}` });
        }
      }
    }
    for (const d of io.described) process.stdout.write(`  ${dry ? '→' : '✓'} ${d}\n`);
    for (const r of results.filter((x) => x.result !== 'ok')) process.stdout.write(`  · ${r.recipe} ${r.type}: ${r.result}\n`);
    const n = results.filter((x) => x.result === 'ok').length;
    total += n;
    if (!dry) {
      m.manifest.undone = true;
      m.manifest.undoneAt = new Date().toISOString();
      m.manifest.undoResults = results;
      writeJsonAtomic(path.join(m.dir, 'manifest.json'), m.manifest);
    }
    process.stdout.write(t('cli.undo_done', { n, id: m.id }) + '\n');
  }
  return { undone: total };
}

export const __test = { handlers, undoEntry, makeIo, writeManaged, getPath, setPath, deletePath, hookIdentity, sha, TEMPLATES, os };
