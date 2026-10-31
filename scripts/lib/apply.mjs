// Apply engine: turns chosen recipes into settings/file changes with a journal
// that `undo` can replay backwards. Every write is idempotent and backed up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, ensureDir, exists, expandHome, globalConfigPath, kitRoot, projectConfigKey, readJsonSafe, settingsFiles, stateDir, toPosix, writeJsonAtomic } from './paths.mjs';
import { nodeCommand } from './platform.mjs';
import { actionApplies, addExtraRecipes, closeMatches, loadCatalog, readExtraRecipes, rememberedExtraFile, resolveExtraFile, resolvePath } from './recipes.mjs';
import { UserError, translator } from './i18n.mjs';
import { validateChoices } from './console.mjs';

const SCOPES = ['user', 'project'];
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
  if (scope === 'project' && !proj) throw new UserError(translator('en')('err.project_scope'));
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
    globalConfig: globalConfigPath(),
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

/**
 * The items of a list-valued action field (servers, plugins, hook commands). A literal array is taken as it is. A field
 * that is exactly one `{params.x}` placeholder whose parameter is an array uses that array directly: joining it with
 * commas and splitting again would glue together items that are not comma-delimited (hook commands such as
 * `bash x.sh` or `npx eslint --fix`). Any other string is split with `splitter`.
 */
function listParam(value, ctx, splitter) {
  let items;
  if (Array.isArray(value)) items = value;
  else {
    const m = typeof value === 'string' ? value.match(/^\{params\.([a-zA-Z0-9_]+)\}$/) : null;
    items = m && Array.isArray(ctx.params[m[1]]) ? ctx.params[m[1]] : String(fill(value, ctx)).split(splitter);
  }
  return items.map((s) => String(s).trim()).filter(Boolean);
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

/** The alternatives of a hook matcher; null stands for "every event" (no matcher, or `*`). */
function tokensOf(matcher) {
  return matcher && matcher !== '*' ? String(matcher).split('|').filter(Boolean) : null;
}

/** What a journaled settings.hook entry needs to be covered: the matcher its recipe asked for (older journals: the one it added). */
function needOf(entry) {
  return entry.wanted !== undefined ? entry.wanted : entry.matcher;
}

const UNFILLED = /\{\{[a-zA-Z0-9_]+\}\}/;

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function cmpSeq(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
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
    // The same command can already be wired to part of the matchers this recipe wants (precompact-handoff installs
    // session-context for compact|resume|fork, the session-context recipe wants startup|resume|clear|compact|fork).
    // Add only the matcher alternatives that are still missing, so neither a hook is silently dropped nor does it fire twice.
    const theirs = list.filter((group) => (group.hooks || []).some((h) => hookIdentity(h) === id));
    let matcher = a.matcher || null;
    if (theirs.length) {
      const covered = new Set();
      let all = !matcher;
      for (const g of theirs) {
        if (!g.matcher || g.matcher === '*') all = true;
        else for (const tok of String(g.matcher).split('|')) covered.add(tok);
      }
      const missing = matcher && !all ? matcher.split('|').filter((tok) => !covered.has(tok)) : [];
      if (!missing.length) {
        // Wired by another recipe that is still applied (its group is what this recipe relies on): record that, so that
        // undoing the other recipe leaves this coverage in place. Wired by the user, or by this same recipe: nothing to record.
        const wantT = tokensOf(a.matcher);
        const lenders = io
          .live()
          .filter((p) => p.entry.type === 'settings.hook' && !p.entry.shared && p.entry.event === a.event && p.entry.identity === id && samePath(p.entry.file, file) && p.recipe.id !== io.recipeId)
          .filter((p) => {
            const pt = tokensOf(p.entry.matcher);
            return !wantT || !pt || pt.some((x) => wantT.includes(x));
          });
        const own = io.live().some((p) => p.entry.type === 'settings.hook' && p.entry.event === a.event && p.entry.identity === id && samePath(p.entry.file, file) && p.recipe.id === io.recipeId);
        if (!lenders.length || own) return { skipped: true, reason: io.t('apply.skip.hook_present'), file, event: a.event, command: entry.command };
        io.describe(io.say(`hook for ${a.event} is already installed by ${[...new Set(lenders.map((p) => p.recipe.id))].join(', ')}; shared`, `хук ${a.event} уже установлен рецептом ${[...new Set(lenders.map((p) => p.recipe.id))].join(', ')}; используется совместно`));
        return { type: 'settings.hook', file, event: a.event, matcher: null, wanted: a.matcher || null, identity: id, shared: true };
      }
      matcher = missing.join('|');
    }
    const group = { hooks: [entry] };
    if (matcher) group.matcher = matcher;
    io.describe(io.t('apply.plan.hook_add', { file, event: a.event, matcher: matcher ? ` [${matcher}]` : '', command: entry.command }));
    if (!io.dry) {
      list.push(group);
      io.save(file, settings);
    }
    // wanted: the whole matcher the recipe asked for (matcher is only what this batch added), so that undoing another
    // batch can put back the part of the coverage this recipe still depends on
    return { type: 'settings.hook', file, event: a.event, matcher, wanted: a.matcher || null, identity: id };
  },

  'settings.set'(a, ctx, io) {
    const file = ctx.settingsFile;
    const settings = io.load(file);
    const value = fillDeep(a.value, ctx);
    const prev = getPath(settings, a.path);
    if (JSON.stringify(prev) === JSON.stringify(value)) return { skipped: true, reason: io.t('apply.skip.already_set'), file, path: a.path };
    io.describe(io.t(prev !== undefined ? 'apply.plan.set_was' : 'apply.plan.set', { file, path: a.path, value: JSON.stringify(value), prev: JSON.stringify(prev) }));
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
    if (!added.length) return { skipped: true, reason: io.t('apply.skip.nothing_new'), file, path: a.path };
    io.describe(io.t('apply.plan.append', { file, path: a.path, items: added.join(', ') }));
    if (!io.dry) {
      setPath(settings, a.path, arr.concat(added));
      io.save(file, settings);
    }
    return { type: 'settings.append', file, path: a.path, added };
  },

  file(a, ctx, io) {
    const target = expandHome(fill(a.target, ctx));
    const content = a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx);
    return writeManaged(target, content, io, { executable: !!a.executable, template: !!a.template });
  },

  skill(a, ctx, io) {
    const name = fill(a.name, ctx).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('skill action: empty name');
    if (a.content && paramsUnfilled(a.content, ctx.params)) return { skipped: true, reason: io.t('apply.skip.skill_unfilled', { name }) };
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
    if (a.content && paramsUnfilled(a.content, ctx.params)) return { skipped: true, reason: io.t('apply.skip.unfilled'), id };
    // LF only: a CRLF body (a --param-file saved on Windows) would be hashed as written but compared LF-normalised by undo
    const body = (a.template ? renderTemplateFile(a.template, ctx.params) : fill(a.content, ctx)).replace(/\r\n?/g, '\n').trim();
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
      if (existing.match(re)[0].replace(/\r\n/g, '\n') === block) return { skipped: true, reason: io.t('apply.skip.block_unchanged'), file: target, id };
      next = existing.replace(re, () => block); // function form: the text may contain $&, $', $` or $$
    } else {
      next = existing.replace(/\s*$/, '') + (existing.trim() ? '\n\n' : '') + block + '\n';
    }
    io.describe(io.t(had ? 'apply.plan.block_update' : 'apply.plan.block_add', { target, id, lines: body.split('\n').length }));
    if (!io.dry) {
      io.backup(target);
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, next, 'utf8');
    }
    // tail: the whitespace an append trimmed from the end of the file, so that undo can give it back exactly
    // hash: of the block as written, so that undo can tell whether the user edited it since
    return { type: 'claude-md.block', file: target, id, existedBefore: exists(target) && existing.length > 0, previousBlock: had ? existing.match(re)[0] : null, tail: had ? null : existing.match(/\s*$/)[0], hash: sha(block) };
  },

  'mcp.disable'(a, ctx, io) {
    const servers = listParam(a.servers, ctx, /[,\n]/);
    if (!servers.length) return { skipped: true, reason: io.t('apply.skip.no_servers') };
    const file = ctx.globalConfig;
    const cfg = io.load(file);
    // Servers can live in three places: user scope (mcpServers), local scope (projects[<dir>].mcpServers, the default of
    // `claude mcp add`) and the shared project file <dir>/.mcp.json. The first two sit in ~/.claude.json and are removed
    // (with the definition kept in the journal); .mcp.json belongs to the repository and is never edited.
    const localKey = ctx.projectDir ? findProjectKey(cfg, ctx.projectDir) : null;
    const local = localKey ? cfg.projects[localKey].mcpServers : null;
    const projectFile = ctx.projectDir ? path.join(ctx.projectDir, '.mcp.json') : null;
    const projectServers = projectFile ? (readJsonSafe(projectFile, null) || {}).mcpServers : null;
    const removed = [];
    const inProjectFile = [];
    const notFound = [];
    for (const name of servers) {
      if (cfg.mcpServers && cfg.mcpServers[name]) {
        removed.push({ name, config: cfg.mcpServers[name] }); // user scope: no `where`, as in older journals
        if (!io.dry) delete cfg.mcpServers[name];
      } else if (local && local[name]) {
        removed.push({ name, config: local[name], where: 'local', projectKey: localKey });
        if (!io.dry) delete local[name];
      } else if (projectServers && projectServers[name]) {
        inProjectFile.push(name);
      } else notFound.push(name);
    }
    if (inProjectFile.length) io.note(io.t('apply.note.mcp_project_file', { file: projectFile, names: inProjectFile.join(', ') }));
    if (!removed.length) {
      const why = [...notFound, ...inProjectFile.map((name) => io.t('apply.skip.in_project_mcp', { name }))];
      return { skipped: true, reason: io.t('apply.skip.servers_not_found', { why: why.join(', ') }), file };
    }
    if (notFound.length) io.note(io.t('apply.note.mcp_not_found', { names: notFound.join(', ') }));
    io.describe(io.t('apply.plan.mcp_remove', { file, names: removed.map((r) => (r.where === 'local' ? io.t('apply.plan.local_scope', { name: r.name }) : r.name)).join(', ') }));
    if (!io.dry) io.save(file, cfg);
    return { type: 'mcp.disable', file, removed };
  },

  'settings.hook.remove'(a, ctx, io) {
    const commands = listParam(a.commands, ctx, /\r?\n/);
    if (!commands.length) return { skipped: true, reason: io.t('apply.skip.no_hooks') };
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
        const n = removed.filter((r) => r.file === file).length;
        io.describe(io.t(n === 1 ? 'apply.plan.hook_remove_one' : 'apply.plan.hook_remove_many', { file, n }));
        if (!io.dry) io.save(file, settings);
      }
    }
    if (!removed.length) return { skipped: true, reason: io.t('apply.skip.hooks_not_found') };
    return { type: 'settings.hook.remove', removed };
  },

  'plugins.disable'(a, ctx, io) {
    const plugins = listParam(a.plugins, ctx, /[,\n]/);
    if (!plugins.length) return { skipped: true, reason: io.t('apply.skip.no_plugins') };
    const file = path.join(configDir(), 'settings.json');
    const settings = io.load(file);
    settings.enabledPlugins ||= {};
    const changed = [];
    for (const p of plugins) {
      if (settings.enabledPlugins[p] === false) continue;
      changed.push({ plugin: p, previous: settings.enabledPlugins[p] === undefined ? null : settings.enabledPlugins[p] });
      if (!io.dry) settings.enabledPlugins[p] = false;
    }
    if (!changed.length) return { skipped: true, reason: io.t('apply.skip.already_disabled'), file };
    io.describe(io.t('apply.plan.plugins_disable', { file, names: changed.map((c) => c.plugin).join(', ') }));
    if (!io.dry) io.save(file, settings);
    return { type: 'plugins.disable', file, changed };
  },
};

/** The key of ~/.claude.json `projects` that stands for this directory and has servers (same lookup as inventory). */
function findProjectKey(cfg, projectDir) {
  return projectConfigKey(cfg.projects, projectDir, (v) => v && v.mcpServers);
}

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
  // The file is also written by another recipe that is still applied (two recipes can share one hook script). A recipe
  // that wants the very same content, or whose template leaves placeholders unfilled because the parameters belong to
  // the other recipe, keeps the file as it is and records that it uses it: undoing the other recipe then leaves the file.
  const owners = existed ? io.live().filter((p) => p.entry.type === 'file' && samePath(p.entry.file, target)) : [];
  const foreign = owners.filter((p) => p.recipe.id !== io.recipeId);
  if (existed && (current === content || (foreign.length && extra.template && UNFILLED.test(content)))) {
    if (!foreign.length || foreign.length < owners.length) return { skipped: true, reason: current === content ? io.t('apply.skip.identical_file') : io.say('kept as it is: its parameters belong to another recipe', 'оставлен как есть: его параметры заданы другим рецептом'), file: target };
    const names = [...new Set(foreign.map((p) => p.recipe.id))].join(', ');
    io.describe(io.say(`${target}: shared with ${names}, kept as it is`, `${target}: общий файл рецепта ${names}, оставлен как есть`));
    return { type: 'file', file: target, existedBefore: true, hash: sha(current), createdDir: null, shared: true };
  }
  const ours = io.ownedFiles.has(path.resolve(target));
  if (existed && !ours && !io.force && !target.replace(/\\/g, '/').includes(toPosix(stateDir()))) {
    return { skipped: true, reason: io.t('apply.skip.not_ours'), file: target };
  }
  io.describe(io.t(existed ? 'apply.plan.file_overwrite' : 'apply.plan.file_create', { target, chars: content.length }));
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
    for (const r of m.manifest.recipes || []) for (const a of r.actions || []) if (a.type === 'file' && a.file && !a.undone) set.add(path.resolve(a.file));
  }
  return set;
}

/**
 * Every journal entry that is still in force: from batches that are not undone, minus entries already reverted
 * (`e.undone`, or listed in `done` during a run that has not written yet). `extra` is a batch being built.
 * `seq` orders entries in time: batch id, then recipe, then action.
 */
function collectLive(boxes, { done = new Set(), extra = null } = {}) {
  const out = [];
  const add = (box) => {
    (box.manifest.recipes || []).forEach((recipe, ri) => {
      (recipe.actions || []).forEach((entry, ei) => {
        if (!entry.undone && !done.has(entry)) out.push({ entry, recipe, box, seq: [box.id, ri, ei] });
      });
    });
  };
  for (const box of boxes) if (!box.manifest.undone && !box.manifest.dry) add(box);
  if (extra) add(extra);
  return out;
}

function makeIo({ dry, force, measure, batchDir, recipeId, t = translator('en'), lang = 'en', live = null, applyDir = null }) {
  const cache = new Map();
  const described = [];
  const notes = [];
  const backedUp = new Set();
  const touched = new Set();
  const liveEntries = live || (() => collectLive(listManifests()));
  return {
    dry,
    force,
    measure,
    recipeId,
    t,
    lang,
    applyDir,
    ownedFiles: ownedFiles(),
    touched,
    described,
    notes,
    /** A message that is not in the locale files: the English text, or the Russian one when the run is in Russian. */
    say(en, ru) {
      return lang === 'ru' ? ru : en;
    },
    live: liveEntries,
    /** The other entries in force that touch the same file / hook as this journal entry. */
    peers(e) {
      const same =
        e.type === 'file'
          ? (p) => p.entry.type === 'file' && samePath(p.entry.file, e.file)
          : (p) => p.entry.type === 'settings.hook' && p.entry.event === e.event && p.entry.identity === e.identity && samePath(p.entry.file, e.file);
      return liveEntries()
        .filter((p) => p.entry !== e && same(p))
        .sort((x, y) => cmpSeq(x.seq, y.seq));
    },
    /** A journal entry of another batch was changed: its manifest has to be written back. */
    touch(box) {
      if (!dry) touched.add(box);
    },
    describe(line) {
      described.push(line);
    },
    /** A message for the user that is not a change (something left alone, something not found). */
    note(line) {
      notes.push(line);
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
      // makeIo() is created once per recipe but the backup folder is shared by the whole batch: the first copy is the
      // file as it was before the batch, and a later recipe touching the same file must not replace it
      if (exists(dest)) return;
      ensureDir(path.dirname(dest));
      fs.copyFileSync(file, dest);
    },
  };
}

// ------------------------------------------------------------- apply

export function loadChoices(args, t = translator('en')) {
  const state = stateDir();
  const file = args._[1] ? path.resolve(expandHome(args._[1])) : path.join(state, 'choices.json');
  if (args.flags.recipe) {
    const rec = readJsonSafe(path.join(state, 'recommendations.json'));
    // ids that only appear in a `recommend --all` listing take their parameter values from there
    const recAll = readJsonSafe(path.join(state, 'recommendations.all.json'));
    const ids = String(args.flags.recipe).split(',').map((s) => s.trim()).filter(Boolean);
    const selected = ids.map((id) => {
      const find = (x) => x && Array.isArray(x.recommendations) && x.recommendations.find((y) => y.id === id);
      const r = find(rec) || find(recAll);
      return { id, scope: args.flags.scope || (r && r.scope) || 'user', params: Object.fromEntries((r ? r.params : []).map((p) => [p.name, p.value])) };
    });
    return { version: 1, source: 'cli', selected, discuss: [], notes: '' };
  }
  const choices = readJsonSafe(file);
  if (!choices) throw new UserError(t('err.no_choices', { file }));
  // the file may come from a browser page or an artifact database: same checks as `choices --import`
  return { ...validateChoices(choices), ...(choices.source ? { source: String(choices.source) } : {}) };
}

/**
 * The recipe a --param / --param-file spec names must be among the selected ones and must declare that parameter;
 * otherwise the recipe would silently run with its defaults.
 */
function declaredParam(spec, id, name, selected, catalog, t) {
  const sel = selected.find((s) => s.id === id);
  const recipe = catalog.recipes.find((r) => r.id === id);
  if (!sel || !recipe) throw new UserError(t('err.param_unknown_recipe', { spec, id, selected: selected.map((s) => s.id).join(', ') }));
  const declared = recipe.params || [];
  const param = declared.find((p) => p.name === name);
  if (!param) throw new UserError(declared.length ? t('err.param_unknown_name', { spec, id, name, valid: declared.map((p) => p.name).join(', ') }) : t('err.param_no_params', { spec, id }));
  return { sel, param };
}

function applyParamOverrides(selected, flags, catalog, t) {
  const list = Array.isArray(flags.param) ? flags.param : flags.param ? [flags.param] : [];
  for (const spec of list) {
    const m = String(spec).match(/^([a-z0-9.-]+)\.([a-zA-Z0-9_]+)=([\s\S]*)$/);
    if (!m) throw new UserError(t('err.param_shape', { spec }));
    const { sel, param } = declaredParam(spec, m[1], m[2], selected, catalog, t);
    // a select with a fixed option list takes only those values (a dynamic list, optionsFrom, is not known here)
    if ((param.type === 'select' || param.type === 'multiselect') && Array.isArray(param.options) && param.options.length && !param.optionsFrom) {
      const bad = m[3].split(param.type === 'multiselect' ? ',' : '\u0000').filter((v) => !param.options.includes(v));
      if (bad.length) throw new UserError(t('err.param_bad_value', { spec, value: bad.join(', '), id: m[1], name: m[2], options: param.options.join(', ') }));
    }
    sel.params = { ...(sel.params || {}), [m[2]]: m[3].includes(',') ? m[3].split(',') : m[3] };
  }
  // --param-file recipe.id.param=PATH : the UTF-8 content of the file is the value as it is (multi-line text, commas
  // included), which is how a drafted rules block or skill body reaches a recipe without shell quoting
  const files = Array.isArray(flags['param-file']) ? flags['param-file'] : flags['param-file'] ? [flags['param-file']] : [];
  for (const spec of files) {
    const m = String(spec).match(/^([a-z0-9.-]+)\.([a-zA-Z0-9_]+)=([\s\S]+)$/);
    if (!m) throw new UserError(t('err.param_file_shape', { spec }));
    const file = path.resolve(expandHome(m[3]));
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new UserError(t('err.param_file_read', { id: m[1], name: m[2], file, code: err.code || err.message }));
    }
    const sel = selected.find((s) => s.id === m[1]);
    if (!sel) throw new UserError(t('err.param_file_unselected', { id: m[1], name: m[2] }));
    declaredParam(spec, m[1], m[2], selected, catalog, t);
    sel.params = { ...(sel.params || {}), [m[2]]: text.replace(/^﻿/, '') };
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
  // Custom recipes (ids like custom.*) drafted for this run live in an extra-recipes file: the one given with --add, or
  // else the one `recommend --add` recorded in recommendations.json (when it is still there).
  let extraFile = null;
  if (flags.add && flags.add !== true) extraFile = resolveExtraFile(flags.add);
  else if (flags.add === true) throw new UserError(t('err.add_expects_file'));
  else extraFile = rememberedExtraFile(stateDir()); // `recommend --all --add FILE` records the path only in recommendations.all.json
  if (extraFile) {
    const extra = readExtraRecipes(extraFile);
    if (!extra) {
      if (flags.add) throw new UserError(t('err.add_unreadable', { file: flags.add }));
    } else addExtraRecipes(catalog, extra);
  }
  const choices = loadChoices(args, t);
  const selectedIds = (choices.selected || []).map((s) => s.id);
  // Ids that are not in the catalog (or in the --add file) are skipped with a warning when other recipes are selected too;
  // when nothing selected is known the run is a mistake (usually a typo): fail before anything is written.
  const knownIds = new Set(catalog.recipes.map((r) => r.id));
  const unknownIds = selectedIds.filter((id) => !knownIds.has(id));
  if (selectedIds.length && unknownIds.length === selectedIds.length) {
    const close = [...new Set(unknownIds.flatMap((id) => closeMatches(id, knownIds)))];
    const hint = (close.length ? t('err.did_you_mean', { suggestions: close.join(', ') }) : '') + (unknownIds.some((id) => /^custom\./.test(id)) ? t('err.custom_hint') : '');
    throw new UserError(t('err.apply_unknown', { ids: unknownIds.join(', '), hint }));
  }
  applyParamOverrides(choices.selected || [], flags, catalog, t);
  const projectDir = flags.project ? path.resolve(expandHome(String(flags.project))) : process.env.CLAUDE_PROJECT_DIR || measure.env.projectDir || process.cwd();
  if (!choices.selected || !choices.selected.length) {
    process.stdout.write(t('cli.apply_nothing') + '\n');
    return { applied: 0 };
  }
  // Validate every scope before the first write: anything but user|project would silently resolve to the user files.
  const scopeOf = (sel, recipe) => flags.scope || sel.scope || (recipe && recipe.defaultScope) || 'user';
  for (const sel of choices.selected) {
    const scope = scopeOf(sel, catalog.recipes.find((r) => r.id === sel.id));
    if (!SCOPES.includes(scope)) throw new UserError(t(sel && sel.id ? 'err.bad_scope' : 'err.bad_scope_plain', { scope: JSON.stringify(scope), id: sel && sel.id, allowed: SCOPES.join(' or ') }));
  }
  // One journal directory per apply. The id has a resolution of one second, so a second apply in the same second
  // gets a numeric suffix instead of overwriting (and losing) the first batch's manifest and backups.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let batchId = stamp;
  for (let n = 2; exists(path.join(journalDir(), batchId)); n++) batchId = `${stamp}-${String(n).padStart(2, '0')}`;
  const batchDir = path.join(journalDir(), batchId);
  const manifest = { id: batchId, at: new Date().toISOString(), kitVersion: catalog.version, lang, projectDir, dry, recipes: [], notes: choices.notes || '', discuss: choices.discuss || [] };
  const lines = [];
  for (const sel of choices.selected) {
    const recipe = catalog.recipes.find((r) => r.id === sel.id);
    if (!recipe) {
      lines.push(t('apply.unknown_recipe', { id: sel.id }) + (/^custom\./.test(sel.id) ? t('apply.unknown_custom_hint') : ''));
      continue;
    }
    const recommended = rec && rec.recommendations.find((r) => r.id === sel.id);
    const params = {};
    for (const p of recipe.params || []) params[p.name] = p.default;
    if (recommended) for (const p of recommended.params || []) params[p.name] = p.value;
    Object.assign(params, sel.params || {});
    const scope = scopeOf(sel, recipe);
    const allowed = Array.isArray(recipe.scope) ? recipe.scope : [recipe.scope || recipe.defaultScope || 'user'];
    if (!allowed.includes(scope)) lines.push(t('apply.scope_warn', { id: recipe.id, scope, allowed: allowed.join(', ') }));
    const ctx = buildContext({ scope, projectDir, params });
    // the entries of the recipes already handled in this batch count too: two recipes of one run can share a file
    const io = makeIo({ dry, force: !!flags.force, measure, batchDir, recipeId: recipe.id, t, lang, live: () => collectLive(listManifests(), { extra: { id: batchId, manifest } }) });
    const entries = [];
    for (const action of recipe.actions || []) {
      if (!actionApplies(action, measure)) {
        lines.push(t('apply.condition_skipped', { id: recipe.id, type: action.type }));
        continue;
      }
      const handler = handlers[action.type];
      if (!handler) {
        lines.push(t('apply.unsupported', { id: recipe.id, type: action.type }));
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
    for (const n of io.notes) lines.push(`  · ${recipe.id}: ${n}`);
    manifest.recipes.push({ id: recipe.id, scope, params, actions: entries, advice: !(recipe.actions && recipe.actions.length) });
  }
  if (!dry && manifest.recipes.length) {
    ensureDir(batchDir);
    writeJsonAtomic(path.join(batchDir, 'manifest.json'), manifest);
    // only recipes that changed something (or are advice) count as applied; the rest stay open for a re-apply
    writeJsonAtomic(path.join(stateDir(), 'last-apply.json'), { id: batchId, at: manifest.at, recipes: manifest.recipes.filter((r) => r.advice || r.actions.length).map((r) => r.id) });
  }
  const out = lines.join('\n');
  if (out) process.stdout.write(out + '\n');
  const n = manifest.recipes.filter((r) => r.actions.length).length;
  process.stdout.write((dry ? t('cli.apply_dry', { n: manifest.recipes.reduce((a, r) => a + r.actions.length, 0) }) : t('cli.apply_done', { n, file: path.join(batchDir, 'manifest.json') })) + '\n');
  if (flags.json) process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ------------------------------------------------------------- undo

/**
 * Undo of a file that another entry still in force uses as well (two recipes share one hook script). The file is never
 * deleted while somebody uses it: when the entry overwrote an earlier user's version, that version comes back from the
 * batch backup; otherwise the file stays and the entries left over take over the duty to delete it once nobody uses it.
 */
function releaseSharedFile(e, peers, curHash, io) {
  const known = [e.hash, ...peers.map((p) => p.entry.hash)];
  if (!known.includes(curHash) && !io.revertEdited) return `kept: ${e.file} modified since apply`;
  const passOn = () => {
    // the file was created by this entry (or by one it took over from): whoever is left deletes it at the end
    if (io.dry || !(e.existedBefore === false || e.inherit)) return;
    for (const p of peers) {
      p.entry.inherit = true;
      io.touch(p.box);
    }
  };
  if (e.shared) {
    passOn();
    return 'ok';
  }
  const me = io.live().find((p) => p.entry === e);
  const earlier = me ? peers.filter((p) => cmpSeq(p.seq, me.seq) < 0) : [];
  if (e.existedBefore && curHash === e.hash && earlier.length && io.applyDir) {
    const saved = path.join(io.applyDir, 'backups', e.file.replace(/[:\\/]/g, '_'));
    const before = exists(saved) ? fs.readFileSync(saved, 'utf8') : null;
    if (before !== null && earlier.some((p) => p.entry.hash === sha(before))) {
      io.describe(io.say(`${e.file}: back to the version of ${[...new Set(earlier.map((p) => p.recipe.id))].join(', ')}`, `${e.file}: возвращена версия рецепта ${[...new Set(earlier.map((p) => p.recipe.id))].join(', ')}`));
      if (!io.dry) {
        io.backup(e.file);
        fs.writeFileSync(e.file, before, 'utf8');
      }
      return 'ok';
    }
  }
  passOn();
  return `shared: ${e.file} still in use by ${[...new Set(peers.map((p) => p.recipe.id))].join(', ')}`;
}

function undoEntry(e, io) {
  switch (e.type) {
    case 'settings.hook': {
      const s = io.load(e.file);
      const list = s.hooks && s.hooks[e.event];
      if (e.shared) return 'ok'; // used another recipe's hook and installed nothing of its own
      if (!Array.isArray(list)) return 'hook list missing';
      let removed = 0;
      let sample = null; // the hook as it was, to put back what other batches still need
      const gone = new Set(); // matcher alternatives this undo took out
      let goneAll = false;
      const mine = e.adopted ? tokensOf(e.matcher) : null;
      for (const group of list) {
        const ids = (group.hooks || []).filter((h) => hookIdentity(h) === e.identity);
        if (!ids.length) continue;
        const gt = tokensOf(group.matcher);
        if ((group.matcher || null) === (e.matcher || null)) {
          sample ||= ids[0];
          group.hooks = group.hooks.filter((h) => hookIdentity(h) !== e.identity);
          removed += ids.length;
          if (gt) gt.forEach((x) => gone.add(x));
          else goneAll = true;
        } else if (mine && gt && ids.length === group.hooks.length && gt.some((x) => mine.includes(x))) {
          // this entry took over alternatives that an undone batch had installed (they sit in groups of their own)
          sample ||= ids[0];
          gt.filter((x) => mine.includes(x)).forEach((x) => gone.add(x));
          const rest = gt.filter((x) => !mine.includes(x));
          if (rest.length) group.matcher = rest.join('|');
          else {
            group.hooks = [];
            removed += ids.length;
          }
        }
        // else: the same command sits in another group for other matchers (installed by another recipe): leave that one
      }
      // Put back the coverage that other batches still in force asked for and that only the removed group provided; the
      // batch that needs it takes the alternatives over, so that undoing it later removes them again.
      if (sample && (gone.size || goneAll)) {
        const covered = new Set();
        let coveredAll = false;
        for (const g of list) {
          if (!(g.hooks || []).some((h) => hookIdentity(h) === e.identity)) continue;
          const gt = tokensOf(g.matcher);
          if (gt) gt.forEach((x) => covered.add(x));
          else coveredAll = true;
        }
        for (const p of io.peers(e)) {
          if (coveredAll) break;
          const want = tokensOf(needOf(p.entry));
          const restore = want ? want.filter((x) => (goneAll || gone.has(x)) && !covered.has(x)) : goneAll ? null : [];
          if (restore && !restore.length) continue;
          const group = { hooks: [{ ...sample }] };
          if (restore) group.matcher = restore.join('|');
          list.push(group);
          if (restore) restore.forEach((x) => covered.add(x));
          else coveredAll = true;
          if (!io.dry) {
            const order = want || [];
            const merged = [...new Set([...(tokensOf(p.entry.matcher) || []), ...(restore || [])])].sort((x, y) => (order.indexOf(x) + 1 || 1e9) - (order.indexOf(y) + 1 || 1e9));
            p.entry.matcher = restore ? merged.join('|') : null;
            p.entry.adopted = true;
            delete p.entry.shared;
            io.touch(p.box);
          }
        }
      }
      s.hooks[e.event] = list.filter((g) => g.hooks && g.hooks.length);
      if (!s.hooks[e.event].length) delete s.hooks[e.event];
      if (!Object.keys(s.hooks).length) delete s.hooks;
      io.describe(io.t('undo.plan.hook_remove', { file: e.file, event: e.event, command: e.identity.split('|')[1] }));
      if (!io.dry) io.save(e.file, s);
      return removed ? 'ok' : 'hook was already gone';
    }
    case 'settings.set': {
      const s = io.load(e.file);
      const cur = getPath(s, e.path);
      if (JSON.stringify(cur) !== JSON.stringify(e.value) && !io.revertEdited) return `kept: ${e.path} changed since apply`;
      if (e.hadPrevious) setPath(s, e.path, e.previous);
      else deletePath(s, e.path);
      io.describe(io.t('undo.plan.restore', { file: e.file, path: e.path }));
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'settings.append': {
      const s = io.load(e.file);
      const arr = getPath(s, e.path);
      if (!Array.isArray(arr)) return 'list missing';
      setPath(s, e.path, arr.filter((v) => !e.added.includes(v)));
      io.describe(io.t('undo.plan.remove_items', { file: e.file, n: e.added.length, path: e.path }));
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'file': {
      const peers = io.peers(e); // other batches / recipes still in force that use this file
      if (e.shared && !peers.length && !e.inherit) return 'ok'; // only used a file somebody else wrote; nothing of its own to remove
      if (!exists(e.file)) return 'file already removed';
      const cur = fs.readFileSync(e.file, 'utf8');
      if (peers.length) return releaseSharedFile(e, peers, sha(cur), io);
      if (sha(cur) !== e.hash && !io.revertEdited) return `kept: ${e.file} modified since apply`;
      io.describe(io.t('undo.plan.delete', { file: e.file }));
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
      const m = new RegExp(`(\\n?\\n?)${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}(\\n?)`).exec(text);
      if (!m) return 'block already gone';
      // like `file` and `settings.set`: leave alone what the user edited after apply (journals from before the hash was recorded skip this check)
      if (e.hash) {
        const raw = m[0].slice(m[1].length, m[0].length - m[2].length);
        // LF-normalised (an editor may have converted the line endings); the raw text covers journals written before the body was normalised
        const untouched = sha(raw.replace(/\r\n/g, '\n')) === e.hash || sha(raw) === e.hash;
        if (!untouched && !io.revertEdited) return `kept: ${e.file} block "${e.id}" modified since apply`;
      }
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + m[0].length);
      // Exact inverse of apply, with no blank-line clean-up elsewhere in the file:
      // an in-place update gets its previous text back between the same newlines; an append gives back the
      // whitespace that was trimmed from the end of the file (older journals without it assume one newline).
      const next = e.previousBlock ? before + m[1] + e.previousBlock + m[2] + after : before + (typeof e.tail === 'string' ? e.tail : before ? '\n' : '') + after;
      io.describe(io.t('undo.plan.remove_block', { file: e.file, id: e.id }));
      if (!io.dry) {
        io.backup(e.file);
        if (!e.existedBefore && !next.trim()) fs.unlinkSync(e.file); // the file was created by apply and nothing else is in it
        else fs.writeFileSync(e.file, next, 'utf8');
      }
      return 'ok';
    }
    case 'mcp.disable': {
      const cfg = io.load(e.file);
      cfg.mcpServers ||= {};
      let restored = 0;
      for (const r of e.removed) {
        let bucket = cfg.mcpServers;
        if (r.where === 'local' && r.projectKey) {
          cfg.projects ||= {};
          cfg.projects[r.projectKey] ||= {};
          bucket = cfg.projects[r.projectKey].mcpServers ||= {};
        }
        if (!bucket[r.name]) {
          bucket[r.name] = r.config;
          restored++;
        }
      }
      io.describe(io.t('undo.plan.restore_mcp', { file: e.file, names: e.removed.map((r) => r.name).join(', ') }));
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
        io.describe(io.t('undo.plan.restore_hook', { file: r.file, event: r.event, command: hookIdentity(r.hook).split('|')[1] }));
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
      io.describe(io.t('undo.plan.reenable_plugins', { file: e.file, names: e.changed.map((c) => c.plugin).join(', ') }));
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    default:
      return `unknown action type ${e.type}`;
  }
}

// undoEntry() reports in fixed English strings (they are compared, stored in the journal and asserted on); they are
// translated only when printed.
const RESULT_KEYS = [
  [/^hook list missing$/, 'hook_list_missing', []],
  [/^hook was already gone$/, 'hook_gone', []],
  [/^kept: (.+) block "(.*)" modified since apply$/, 'kept_block', ['file', 'id']],
  [/^kept: (.+) changed since apply$/, 'kept_changed', ['path']],
  [/^kept: (.+) modified since apply$/, 'kept_modified', ['file']],
  [/^list missing$/, 'list_missing', []],
  [/^file already removed$/, 'file_gone', []],
  [/^file missing$/, 'file_missing', []],
  [/^block already gone$/, 'block_gone', []],
  [/^servers already present$/, 'servers_present', []],
  [/^hooks already present$/, 'hooks_present', []],
  [/^unknown action type (.+)$/, 'unknown_type', ['type']],
  [/^error: ([\s\S]*)$/, 'error', ['detail']],
];

function localizeResult(result, t, lang = 'en') {
  for (const [re, key, names] of RESULT_KEYS) {
    const m = re.exec(result);
    if (m) return t(`undo.res.${key}`, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  const shared = /^shared: (.+) still in use by (.+)$/.exec(result);
  if (shared && lang === 'ru') return `${shared[1]} оставлен: им ещё пользуется ${shared[2]}`;
  return result;
}

export async function cmdUndo(args, { pickLang }) {
  const flags = args.flags;
  const dry = !!flags['dry-run'];
  const lang = pickLang(flags, null);
  const t = translator(lang);
  const manifests = listManifests().filter((m) => !m.manifest.undone && !m.manifest.dry);
  // entries reverted in this run, also in a dry run that writes nothing: they no longer count as users of a shared file / hook
  const done = new Set();
  // A batch in which every action was skipped (an apply that found everything already in place) recorded nothing to
  // revert. It must not shadow the batch that did the work, so "undo" and "undo --all" pass over it.
  const recorded = manifests.filter((m) => (m.manifest.recipes || []).some((r) => (r.actions || []).length || r.advice));
  let targets;
  if (flags.all) targets = recorded.slice().reverse();
  else if (args._[1]) targets = manifests.filter((m) => m.id === args._[1]);
  else targets = recorded.slice(-1);
  if (!targets.length) {
    process.stdout.write(t('cli.undo_nothing') + '\n');
    return { undone: 0 };
  }
  let total = 0;
  for (const m of targets) {
    // Every undo run keeps its own backups folder: a file the first (partial) run already saved must not stop a later
    // `--force` run from saving the state it is about to overwrite.
    const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
    let runId = runStamp;
    for (let n = 2; exists(path.join(m.dir, 'undo', runId)); n++) runId = `${runStamp}-${String(n).padStart(2, '0')}`;
    const io = makeIo({ dry, force: true, measure: null, batchDir: path.join(m.dir, 'undo', runId), recipeId: null, t, lang, applyDir: m.dir, live: () => collectLive(manifests, { done }) });
    // --force: also revert what the user edited after apply (the files as they are now are backed up first)
    io.revertEdited = !!flags.force;
    const results = [];
    const pending = []; // entries that were kept or failed: they stay in the journal and can be undone later
    for (const r of [...m.manifest.recipes].reverse()) {
      for (const e of [...(r.actions || [])].reverse()) {
        if (e.undone) continue; // reverted by an earlier, partial undo of this batch
        let result;
        try {
          result = undoEntry(e, io);
        } catch (err) {
          result = `error: ${err.message}`;
        }
        results.push({ recipe: r.id, type: e.type, result });
        if (/^(kept|error):/.test(result)) pending.push(e);
        else {
          done.add(e);
          if (!dry) e.undone = true;
        }
      }
    }
    // other batches whose entries took over a shared file or hook coverage from this one
    for (const box of io.touched) if (box !== m) writeJsonAtomic(path.join(box.dir, 'manifest.json'), box.manifest);
    for (const d of io.described) process.stdout.write(`  ${dry ? '→' : '✓'} ${d}\n`);
    for (const r of results.filter((x) => x.result !== 'ok')) process.stdout.write(`  · ${r.recipe} ${r.type}: ${localizeResult(r.result, t, lang)}\n`);
    const n = results.filter((x) => x.result === 'ok').length;
    total += n;
    if (!dry) {
      // Only a batch with nothing left over counts as undone. If something was kept (or failed) the batch stays
      // undoable for exactly those entries: `undo <id>` retries them, `undo <id> --force` reverts them anyway.
      if (pending.length) {
        m.manifest.partiallyUndone = true;
        m.manifest.partiallyUndoneAt = new Date().toISOString();
      } else {
        m.manifest.undone = true;
        m.manifest.undoneAt = new Date().toISOString();
        delete m.manifest.partiallyUndone;
        delete m.manifest.partiallyUndoneAt;
      }
      m.manifest.undoResults = results;
      writeJsonAtomic(path.join(m.dir, 'manifest.json'), m.manifest);
    }
    process.stdout.write(t(dry ? 'cli.undo_dry' : 'cli.undo_done', { n, id: m.id }) + '\n');
    if (pending.length && !dry) {
      process.stdout.write(t('cli.undo_partial', { n: pending.length, id: m.id, dir: path.join(m.dir, 'undo') }) + '\n');
      // apply only copies files that existed before it; a batch that created everything has no such folder
      const before = path.join(m.dir, 'backups');
      if (exists(before)) process.stdout.write(t('cli.undo_partial_before', { before }) + '\n');
    }
  }
  return { undone: total };
}

export const __test = { handlers, undoEntry, makeIo, collectLive, writeManaged, getPath, setPath, deletePath, hookIdentity, sha, TEMPLATES, os };
