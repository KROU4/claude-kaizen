// Apply engine: turns chosen recipes into settings/file changes with a journal
// that `undo` can replay backwards. Every write is idempotent and backed up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, ensureDir, exists, expandHome, globalConfigPath, kitRoot, managedSettingsFiles, projectConfigKey, readJsonSafe, settingsFiles, stateDir, toPosix, writeJsonAtomic } from './paths.mjs';
import { nodeCommand } from './platform.mjs';
import { actionApplies, addExtraRecipes, closeMatches, hookScriptKey, keyHookScripts, loadCatalog, projectKey, readExtraRecipes, recipeDigest, rememberedExtraFile, resolveExtraFile, resolvePath } from './recipes.mjs';
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

// projectKey and hookScriptKey (which recipes get project-specific hook script names) live in recipes.mjs, next to the
// recommendation summaries that show those names
export { hookScriptKey, projectKey };

export function fill(str, ctx) {
  if (typeof str !== 'string') return str;
  // the scripts of a project-specific recipe belong to that project (see perProjectScripts)
  str = keyHookScripts(str, ctx.hookKey);
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

/** A path as a map key / for comparing: resolved (slashes and `..` settled), and lower case where the file system ignores case (Windows). */
function pathKey(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** The same file, however it is spelled: `C:\p` and `c:/p` are one file on Windows. */
function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function cmpSeq(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when two journal entries are about the same thing: the same file, hook, setting, list or rules block. */
function sameTarget(a, b) {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'file':
      return samePath(a.file, b.file);
    case 'settings.hook':
      return a.event === b.event && a.identity === b.identity && samePath(a.file, b.file);
    case 'settings.set':
    case 'settings.append':
      return a.path === b.path && samePath(a.file, b.file);
    case 'claude-md.block':
      return a.id === b.id && samePath(a.file, b.file);
    default:
      return false;
  }
}

/**
 * What a handler returns when a batch in force already provides what this action wants (the claim mechanism): the claim is
 * a journal entry that writes nothing but says "I rely on this". Undoing the batch that provided it then hands the thing
 * over to the newest claimant instead of removing it. When this recipe itself is among the providers (the same recipe
 * applied again) the claim rides along with the recipe's other changes of the run (cmdApply adds it only if the run
 * changed something); when only other recipes provide it, the claim is the action's own journal entry.
 */
function shareOrSkip(io, claim, providers, skip, line) {
  if (providers.some((p) => p.recipe.id === io.recipeId)) return { ...skip, claim };
  io.describe(line);
  return claim;
}

/** A hook command with its whitespace collapsed (how settings.hook.remove compares commands). */
const normCommand = (c) => String(c).replace(/\s+/g, ' ').trim();

const recipeNames = (providers) => [...new Set(providers.map((p) => p.recipe.id))].join(', ');

// ------------------------------------------------------------- action handlers
// Each returns a journal entry (or null when nothing changed). `dry` = describe only: the settings and files a dry run
// would change are changed in memory (io.load / io.fileText) so that the next action and the next recipe of the run
// see them, exactly as the real run finds them on the disk.

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
        // undoing the other recipe leaves this coverage in place. Wired by the user: nothing to record. Wired by an earlier
        // batch of this same recipe: the claim rides along with the recipe's other changes of this run (cmdApply adds it
        // only when the run changed something, e.g. rewrote the script with new parameters), so that undoing the older
        // batch hands the hook over instead of leaving the newer batch without one.
        const wantT = tokensOf(a.matcher);
        const lenders = io
          .live()
          .filter((p) => p.entry.type === 'settings.hook' && !p.entry.shared && p.entry.event === a.event && p.entry.identity === id && samePath(p.entry.file, file) && p.recipe.id !== io.recipeId)
          .filter((p) => {
            const pt = tokensOf(p.entry.matcher);
            return !wantT || !pt || pt.some((x) => wantT.includes(x));
          });
        const own = io.live().some((p) => p.entry.type === 'settings.hook' && p.entry.event === a.event && p.entry.identity === id && samePath(p.entry.file, file) && p.recipe.id === io.recipeId);
        const claim = { type: 'settings.hook', file, event: a.event, matcher: null, wanted: a.matcher || null, identity: id, shared: true };
        if (own) return { skipped: true, reason: io.t('apply.skip.hook_present'), file, event: a.event, command: entry.command, claim };
        if (!lenders.length) return { skipped: true, reason: io.t('apply.skip.hook_present'), file, event: a.event, command: entry.command };
        io.describe(io.say(`hook for ${a.event} is already installed by ${[...new Set(lenders.map((p) => p.recipe.id))].join(', ')}; shared`, `хук ${a.event} уже установлен рецептом ${[...new Set(lenders.map((p) => p.recipe.id))].join(', ')}; используется совместно`));
        return claim;
      }
      matcher = missing.join('|');
    }
    const group = { hooks: [entry] };
    if (matcher) group.matcher = matcher;
    io.describe(io.t('apply.plan.hook_add', { file, event: a.event, matcher: matcher ? ` [${matcher}]` : '', command: entry.command }));
    list.push(group);
    // Upgrade from 0.1.4, which wired the shared script (format-on-edit.mjs) in the project: a live batch of this very recipe
    // still owns that unkeyed hook, and Claude Code runs two different commands twice. The old hook is taken out here, as a
    // settings.hook.remove entry of THIS batch: undoing this batch puts it back, and the old batch (which may hold other
    // recipes) does not have to be undone. Undoing the old batch finds the hook gone and drops that removal record.
    if (ctx.hookKey) {
      const legacyId = hookIdentity({ type: 'command', command: fill(a.command, { ...ctx, hookKey: null }) });
      const owners = io
        .live()
        .filter((p) => p.entry.type === 'settings.hook' && !p.entry.shared && p.entry.event === a.event && p.entry.identity === legacyId && samePath(p.entry.file, file) && p.recipe.id === io.recipeId);
      if (legacyId !== id && owners.length) {
        const gone = [];
        for (const g of list) {
          const keep = [];
          for (const h of g.hooks || []) {
            if (hookIdentity(h) === legacyId) gone.push({ file, event: a.event, matcher: g.matcher || null, hook: h });
            else keep.push(h);
          }
          g.hooks = keep;
        }
        if (gone.length) {
          settings.hooks[a.event] = list.filter((g) => g.hooks && g.hooks.length);
          const ids = [...new Set(owners.map((p) => p.box.id))];
          io.describe(io.say(`${file}: remove the ${a.event} hook of an earlier version (shared script)`, `${file}: убрать хук ${a.event} прежней версии (общий скрипт)`));
          // the old script is one file for every project (and for the user scope): hooks in other settings files may still run it
          const others = [...new Set(io.live().filter((p) => p.entry.type === 'settings.hook' && p.entry.identity === legacyId && !samePath(p.entry.file, file)).map((p) => p.box.id))].filter((id) => !ids.includes(id));
          const shared = others.length ? io.say(` and until the other projects that still run it (batch ${others.join(', ')}) are undone too`, ` и пока не откатят другие проекты, которые его ещё запускают (пакет ${others.join(', ')})`) : '';
          io.note(io.say(`the ${a.event} hook of an earlier version (shared script, batch ${ids.join(', ')}) was removed from ${file} so that it does not run twice next to the new project-specific one; undoing this batch puts it back. The old script file stays until batch ${ids.join(', ')} is undone${shared}`, `хук ${a.event} прежней версии (общий скрипт, пакет ${ids.join(', ')}) убран из ${file}, чтобы он не срабатывал дважды рядом с новым, своим для проекта; откат этого пакета вернёт его. Старый файл скрипта останется, пока не откатят пакет ${ids.join(', ')}${shared}`));
          io.also({ type: 'settings.hook.remove', removed: gone });
        }
      }
    }
    if (!io.dry) io.save(file, settings);
    // wanted: the whole matcher the recipe asked for (matcher is only what this batch added), so that undoing another
    // batch can put back the part of the coverage this recipe still depends on
    return { type: 'settings.hook', file, event: a.event, matcher, wanted: a.matcher || null, identity: id };
  },

  'settings.set'(a, ctx, io) {
    const file = ctx.settingsFile;
    const settings = io.load(file);
    const value = fillDeep(a.value, ctx);
    const prev = getPath(settings, a.path);
    if (JSON.stringify(prev) === JSON.stringify(value)) {
      const skip = { skipped: true, reason: io.t('apply.skip.already_set'), file, path: a.path };
      // set by a batch that is still in force: rely on it, so that undoing that batch leaves the value in place
      const providers = io.live().filter((p) => p.entry.type === 'settings.set' && p.entry.path === a.path && samePath(p.entry.file, file) && JSON.stringify(p.entry.value) === JSON.stringify(value));
      if (!providers.length) return skip;
      const claim = { type: 'settings.set', file, path: a.path, value, shared: true };
      return shareOrSkip(io, claim, providers, skip, io.say(`${a.path} in ${file} is already set by ${recipeNames(providers)}; shared`, `${a.path} в ${file} уже задан рецептом ${recipeNames(providers)}; используется совместно`));
    }
    io.describe(io.t(prev !== undefined ? 'apply.plan.set_was' : 'apply.plan.set', { file, path: a.path, value: JSON.stringify(value), prev: JSON.stringify(prev) }));
    setPath(settings, a.path, value);
    if (!io.dry) io.save(file, settings);
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
    // Values that are already in the list because a batch still in force added them: this batch relies on them, so that
    // undoing the other batch leaves them in place.
    const holders = (v) => io.live().filter((p) => p.entry.type === 'settings.append' && p.entry.path === a.path && samePath(p.entry.file, file) && ((p.entry.added || []).includes(v) || (p.entry.claimed || []).includes(v)));
    const claimed = [];
    const providers = [];
    for (const v of values) {
      if (!arr.includes(v)) continue;
      const hs = holders(v);
      if (!hs.length) continue;
      claimed.push(v);
      providers.push(...hs);
    }
    if (!added.length) {
      const skip = { skipped: true, reason: io.t('apply.skip.nothing_new'), file, path: a.path };
      if (!claimed.length) return skip;
      const claim = { type: 'settings.append', file, path: a.path, added: [], claimed };
      return shareOrSkip(io, claim, providers, skip, io.say(`${a.path} in ${file}: ${claimed.join(', ')} already added by ${recipeNames(providers)}; shared`, `${a.path} в ${file}: ${claimed.join(', ')} уже добавлено рецептом ${recipeNames(providers)}; используется совместно`));
    }
    io.describe(io.t('apply.plan.append', { file, path: a.path, items: added.join(', ') }));
    setPath(settings, a.path, arr.concat(added));
    if (!io.dry) io.save(file, settings);
    return { type: 'settings.append', file, path: a.path, added, ...(claimed.length ? { claimed } : {}) };
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
    const existing = io.fileText(target) ?? ''; // through io: a dry run sees what the recipes before it would have written
    const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
    let next;
    let had = false;
    if (re.test(existing)) {
      had = true;
      if (existing.match(re)[0].replace(/\r\n/g, '\n') === block) {
        const skip = { skipped: true, reason: io.t('apply.skip.block_unchanged'), file: target, id };
        // written by a batch that is still in force: rely on it, so that undoing that batch leaves the block in place
        const providers = io.live().filter((p) => p.entry.type === 'claude-md.block' && p.entry.id === id && samePath(p.entry.file, target));
        if (!providers.length) return skip;
        const claim = { type: 'claude-md.block', file: target, id, shared: true, existedBefore: true, previousBlock: null, tail: null, hash: sha(block) };
        return shareOrSkip(io, claim, providers, skip, io.say(`${target}: rules block "${id}" is already written by ${recipeNames(providers)}; shared`, `${target}: блок правил "${id}" уже записан рецептом ${recipeNames(providers)}; используется совместно`));
      }
      next = existing.replace(re, () => block); // function form: the text may contain $&, $', $` or $$
    } else {
      next = existing.replace(/\s*$/, '') + (existing.trim() ? '\n\n' : '') + block + '\n';
    }
    io.describe(io.t(had ? 'apply.plan.block_update' : 'apply.plan.block_add', { target, id, lines: body.split('\n').length }));
    io.writeFile(target, next);
    // tail: the whitespace an append trimmed from the end of the file, so that undo can give it back exactly
    // hash: of the block as written, so that undo can tell whether the user edited it since
    return { type: 'claude-md.block', file: target, id, existedBefore: existing.length > 0, previousBlock: had ? existing.match(re)[0] : null, tail: had ? null : existing.match(/\s*$/)[0], hash: sha(block) };
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
        delete cfg.mcpServers[name];
      } else if (local && local[name]) {
        removed.push({ name, config: local[name], where: 'local', projectKey: localKey });
        delete local[name];
      } else if (projectServers && projectServers[name]) {
        inProjectFile.push(name);
      } else notFound.push(name);
    }
    if (inProjectFile.length) io.note(io.t('apply.note.mcp_project_file', { file: projectFile, names: inProjectFile.join(', ') }));
    // Servers that are gone because a batch still in force removed them: this batch relies on that, so that undoing the
    // other batch does not bring them back.
    const claimed = [];
    const providers = [];
    for (const name of [...notFound]) {
      for (const p of io.live()) {
        if (p.entry.type !== 'mcp.disable' || !samePath(p.entry.file, file)) continue;
        const c = [...(p.entry.removed || []), ...(p.entry.claimed || [])].find((x) => x.name === name && (!x.where || x.projectKey === localKey));
        if (!c) continue;
        claimed.push({ name, ...(c.where ? { where: c.where, projectKey: c.projectKey } : {}) });
        providers.push(p);
        notFound.splice(notFound.indexOf(name), 1);
        break;
      }
    }
    if (!removed.length) {
      const why = [...notFound, ...inProjectFile.map((name) => io.t('apply.skip.in_project_mcp', { name }))];
      const skip = { skipped: true, reason: io.t('apply.skip.servers_not_found', { why: why.join(', ') }), file };
      if (!claimed.length) return skip;
      const claim = { type: 'mcp.disable', file, removed: [], claimed };
      return shareOrSkip(io, claim, providers, skip, io.say(`${file}: MCP servers ${claimed.map((c) => c.name).join(', ')} are already removed by ${recipeNames(providers)}; shared`, `${file}: MCP-серверы ${claimed.map((c) => c.name).join(', ')} уже убраны рецептом ${recipeNames(providers)}; используется совместно`));
    }
    if (notFound.length) io.note(io.t('apply.note.mcp_not_found', { names: notFound.join(', ') }));
    io.describe(io.t('apply.plan.mcp_remove', { file, names: removed.map((r) => (r.where === 'local' ? io.t('apply.plan.local_scope', { name: r.name }) : r.name)).join(', ') }));
    if (!io.dry) io.save(file, cfg);
    return { type: 'mcp.disable', file, removed, ...(claimed.length ? { claimed } : {}) };
  },

  'settings.hook.remove'(a, ctx, io) {
    const commands = listParam(a.commands, ctx, /\r?\n/);
    if (!commands.length) return { skipped: true, reason: io.t('apply.skip.no_hooks') };
    const norm = normCommand;
    const wanted = new Set(commands.map(norm));
    const removed = [];
    const scanned = settingsFiles(ctx.projectDir || null, configDir());
    for (const { file } of scanned) {
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
    // Hooks that are gone because a batch still in force removed them: this batch relies on that, so that undoing the other
    // batch does not put them back. Only the settings files this run looked at count (a removal made in another project's
    // file is not this run's business), and every such file is claimed, also when this run removed the hook elsewhere.
    const claimed = [];
    const providers = [];
    for (const want of wanted) {
      for (const p of io.live()) {
        if (p.entry.type !== 'settings.hook.remove') continue;
        for (const c of [...(p.entry.removed || []), ...(p.entry.claimed || [])]) {
          if (normCommand(c.hook ? c.hook.command : c.command) !== want || !scanned.some((s) => samePath(s.file, c.file))) continue;
          if (removed.some((r) => samePath(r.file, c.file) && r.event === c.event && norm(r.hook.command) === want)) continue;
          if (claimed.some((x) => samePath(x.file, c.file) && x.event === c.event && x.command === want)) continue;
          claimed.push({ file: c.file, event: c.event, command: want });
          providers.push(p);
        }
      }
    }
    if (!removed.length) {
      const skip = { skipped: true, reason: io.t('apply.skip.hooks_not_found') };
      if (!claimed.length) return skip;
      const claim = { type: 'settings.hook.remove', removed: [], claimed };
      return shareOrSkip(io, claim, providers, skip, io.say(`hooks ${claimed.map((c) => c.command).join(', ')} are already removed by ${recipeNames(providers)}; shared`, `хуки ${claimed.map((c) => c.command).join(', ')} уже убраны рецептом ${recipeNames(providers)}; используется совместно`));
    }
    return { type: 'settings.hook.remove', removed, ...(claimed.length ? { claimed } : {}) };
  },

  'plugins.disable'(a, ctx, io) {
    const plugins = listParam(a.plugins, ctx, /[,\n]/);
    if (!plugins.length) return { skipped: true, reason: io.t('apply.skip.no_plugins') };
    // Claude Code takes the effective value from the settings files in this order (the later one wins): user, project,
    // local, managed. A plugin is switched off only by writing `false` where the winning `true` is, or above it.
    const layers = [...settingsFiles(ctx.projectDir || null, configDir()), ...managedSettingsFiles().map((m) => ({ scope: 'managed', file: m.file, readOnly: true }))];
    const userLayer = layers[0];
    const localLayer = layers.find((l) => l.scope === 'local');
    const readMap = (layer) => {
      const s = layer.readOnly ? readJsonSafe(layer.file, null) : exists(layer.file) ? io.load(layer.file) : null;
      return s && s.enabledPlugins && typeof s.enabledPlugins === 'object' ? s.enabledPlugins : null;
    };
    const changed = [];
    const claimed = []; // already off because a batch in force switched it off
    const blocked = []; // on in the organisation's managed settings, which Kaizen never edits
    let offIn = null; // a file that already switches a plugin off (not one of ours)
    const files = new Map();
    for (const p of plugins) {
      let win = null;
      for (const layer of layers) {
        const map = readMap(layer);
        if (map && Object.prototype.hasOwnProperty.call(map, p)) win = { layer, value: map[p] };
      }
      // Rely on EVERY file that says `false` and was written by a batch in force (not only the winning layer's file), so
      // that undoing the older batch does not switch the plugin back on in a file the newer one still needs off. That holds
      // also when this batch switches the plugin off somewhere else itself (the user turned it on globally after the older
      // batch switched it off in the project): the older `false` is what keeps it off there.
      const held = layers.filter((layer) => {
        const map = readMap(layer);
        return map && map[p] === false && pluginHolders(io, { plugin: p, file: layer.file }).length;
      });
      const claimHeld = () => {
        for (const layer of held) claimed.push({ plugin: p, file: layer.file });
      };
      if (win && !win.value && win.layer.readOnly) {
        // off for everybody by the organisation's managed settings
        if (held.length) claimHeld();
        else offIn ||= win.layer.file;
        continue;
      }
      if (win && win.layer.readOnly) {
        blocked.push(p);
        continue;
      }
      // Switched off in EVERY file that enables it, not only where the winning `true` is: a plugin enabled in the user and in
      // the project settings would otherwise stay on in every other project, and so would one that is on in the user
      // settings while a higher layer already switches it off here (off in this project only). The project file belongs
      // to the repository and is shared, so a `true` there is switched off for this user in settings.local.json, which
      // comes later in the order and is not committed (unless that file already says `false`).
      claimHeld();
      const targets = new Set();
      for (const layer of layers) {
        const map = layer.readOnly ? null : readMap(layer);
        if (!map || map[p] !== true) continue;
        const target = layer.scope === 'project' ? localLayer : layer;
        const tmap = readMap(target);
        if (!(tmap && tmap[p] === false)) targets.add(target);
      }
      if (!targets.size) {
        if (win && !win.value) {
          if (!held.length) offIn ||= win.layer.file; // already off wherever it was on
          continue;
        }
        targets.add(userLayer); // not mentioned anywhere: the user settings
      }
      for (const target of targets) {
        const settings = io.load(target.file);
        settings.enabledPlugins ||= {};
        changed.push({ plugin: p, previous: settings.enabledPlugins[p] === undefined ? null : settings.enabledPlugins[p], file: target.file, ...(exists(target.file) ? {} : { created: true }) });
        settings.enabledPlugins[p] = false;
        files.set(target.file, settings);
      }
    }
    if (blocked.length) io.note(io.say(`not disabled (enabled by the managed settings of your organisation, which Kaizen never edits): ${blocked.join(', ')}`, `не выключено (включено управляемыми настройками вашей организации, которые Kaizen не правит): ${blocked.join(', ')}`));
    if (!changed.length) {
      const skip = { skipped: true, reason: blocked.length && !claimed.length ? io.say('none could be disabled', 'ни один не удалось выключить') : io.t('apply.skip.already_disabled'), file: claimed.length ? claimed[0].file : offIn || userLayer.file };
      if (!claimed.length) return skip;
      const claim = { type: 'plugins.disable', file: claimed[0].file, changed: [], claimed };
      const providers = claimed.flatMap((c) => pluginHolders(io, c));
      return shareOrSkip(io, claim, providers, skip, io.say(`plugins ${claimed.map((c) => c.plugin).join(', ')} are already disabled by ${recipeNames(providers)}; shared`, `плагины ${claimed.map((c) => c.plugin).join(', ')} уже выключены рецептом ${recipeNames(providers)}; используется совместно`));
    }
    for (const file of files.keys()) io.describe(io.t('apply.plan.plugins_disable', { file, names: changed.filter((c) => c.file === file).map((c) => c.plugin).join(', ') }));
    if (!io.dry) for (const [file, settings] of files) io.save(file, settings);
    // `file` of the entry is the first file; a change names its own file only when it differs (journals of 0.1.x have one file)
    const first = changed[0].file;
    for (const c of changed) if (c.file === first) delete c.file;
    return { type: 'plugins.disable', file: first, changed, ...(claimed.length ? { claimed } : {}) };
  },
};

/** The same MCP server in the same place (user scope, or the local scope of one project). */
function sameMcp(a, b) {
  return a.name === b.name && (a.where || null) === (b.where || null) && (a.projectKey || null) === (b.projectKey || null);
}

/** The other entries in force that removed an MCP server from ~/.claude.json, or rely on it being gone, oldest first. */
function mcpHolders(io, file, ref, except) {
  return io
    .live()
    .filter((p) => p.entry.type === 'mcp.disable' && p.entry !== except && samePath(p.entry.file, file) && [...(p.entry.removed || []), ...(p.entry.claimed || [])].some((c) => sameMcp(c, ref)))
    .sort((x, y) => cmpSeq(x.seq, y.seq));
}

/** The same hook removed from the same settings file (a removed item holds the hook, a claimed one only its command). */
function sameRemovedHook(a, b) {
  return samePath(a.file, b.file) && a.event === b.event && normCommand(a.hook ? a.hook.command : a.command) === normCommand(b.hook ? b.hook.command : b.command);
}

/**
 * The hook of a settings.hook entry that is being undone is already gone, because a batch in force took it out
 * (settings.hook.remove: the upgrade from 0.1.4 does that to the old shared-script hook). It must not come back when that
 * batch is undone later: its owner is undone now, and so is the script. Those removal records are dropped.
 */
function forgetRemovals(io, e) {
  const ref = { file: e.file, event: e.event, command: String(e.identity).slice(String(e.identity).indexOf('|') + 1) };
  for (const p of io.live()) {
    if (p.entry.type !== 'settings.hook.remove') continue;
    const before = (p.entry.removed || []).length + (p.entry.claimed || []).length;
    p.entry.removed = (p.entry.removed || []).filter((c) => !sameRemovedHook(c, ref));
    if (p.entry.claimed) p.entry.claimed = p.entry.claimed.filter((c) => !sameRemovedHook(c, ref));
    if (p.entry.removed.length + (p.entry.claimed || []).length !== before) io.touch(p.box);
  }
}

/** The other entries in force that removed a hook, or rely on it being gone, oldest first. */
function hookRemoveHolders(io, ref, except) {
  return io
    .live()
    .filter((p) => p.entry.type === 'settings.hook.remove' && p.entry !== except && [...(p.entry.removed || []), ...(p.entry.claimed || [])].some((c) => sameRemovedHook(c, ref)))
    .sort((x, y) => cmpSeq(x.seq, y.seq));
}

/** A path as a hook command spells it: forward slashes, and lower case where the file system ignores case (Windows). */
function foldPath(p) {
  const s = String(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** True when a hook command names this very file (not a longer file name that merely starts with its path). */
function commandRunsFile(command, file) {
  const hay = foldPath(command);
  const needle = foldPath(path.resolve(file));
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!/[\w.-]/.test(hay[i + needle.length] || ' ')) return true;
  }
  return false;
}

/**
 * The hooks in force (outside the batch `exceptBox`) whose command runs a script, oldest first. Batches of 0.1.4 and
 * earlier record no claim on a script they share, so the hook itself is the only trace that it is still needed.
 */
function hookUsersOfFile(io, file, exceptBox) {
  return io
    .live()
    .filter((p) => p.entry.type === 'settings.hook' && p.box !== exceptBox && typeof p.entry.identity === 'string' && commandRunsFile(p.entry.identity, file))
    .sort((x, y) => cmpSeq(x.seq, y.seq));
}

/** The entries in force that switched a plugin off in a file, or rely on it (journals of 0.1.x name the file once per entry). */
function pluginHolders(io, ref, except = null) {
  return io
    .live()
    .filter((p) => p.entry.type === 'plugins.disable' && p.entry !== except && [...(p.entry.changed || []), ...(p.entry.claimed || [])].some((c) => c.plugin === ref.plugin && samePath(c.file || p.entry.file, ref.file)))
    .sort((x, y) => cmpSeq(x.seq, y.seq));
}

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
  const current = io.fileText(target); // through io: a dry run sees the files the recipes before it would have written
  const existed = current !== null;
  // The file is also written by another recipe that is still applied (two recipes can share one hook script). A recipe
  // that wants the very same content, or whose template leaves placeholders unfilled because the parameters belong to
  // the other recipe, keeps the file as it is and records that it uses it: undoing the other recipe then leaves the file.
  const owners = existed ? io.live().filter((p) => p.entry.type === 'file' && samePath(p.entry.file, target)) : [];
  const foreign = owners.filter((p) => p.recipe.id !== io.recipeId);
  if (existed && (current === content || (foreign.length && extra.template && UNFILLED.test(content)))) {
    const skip = { skipped: true, reason: current === content ? io.t('apply.skip.identical_file') : io.say('kept as it is: its parameters belong to another recipe', 'оставлен как есть: его параметры заданы другим рецептом'), file: target };
    if (!owners.length) return skip; // not written by Kaizen (or by a batch since undone): nothing to rely on
    // hash: what Kaizen itself last wrote to the file (the newest writer in force), never the hash of what is on the disk
    // now: that could be a user's edit, which undo would then take for Kaizen's own content and delete without a word
    const byAge = [...owners].sort((x, y) => cmpSeq(x.seq, y.seq));
    const last = byAge.filter((p) => !p.entry.shared).pop() || byAge[byAge.length - 1];
    const claim = { type: 'file', file: target, existedBefore: true, hash: current === content ? sha(content) : last.entry.hash || sha(current), createdDir: null, shared: true };
    return shareOrSkip(io, claim, owners, skip, io.say(`${target}: shared with ${recipeNames(foreign)}, kept as it is`, `${target}: общий файл рецепта ${recipeNames(foreign)}, оставлен как есть`));
  }
  const ours = [...io.ownedFiles].some((f) => samePath(f, target)) || owners.length > 0;
  if (existed && !ours && !io.force && !target.replace(/\\/g, '/').includes(toPosix(stateDir()))) {
    return { skipped: true, reason: io.t('apply.skip.not_ours'), file: target };
  }
  io.describe(io.t(existed ? 'apply.plan.file_overwrite' : 'apply.plan.file_create', { target, chars: content.length }));
  if (io.dry) io.writeFile(target, content);
  else {
    if (existed) io.backup(target);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content, 'utf8');
    if (extra.executable && process.platform !== 'win32') fs.chmodSync(target, 0o755);
    io.keepContent(content);
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

function makeIo({ dry, force, measure, batchDir, recipeId, t = translator('en'), lang = 'en', live = null, applyDir = null, cache = new Map(), sim = new Map() }) {
  const described = [];
  const notes = [];
  const alsoEntries = [];
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
    /** The other entries in force that touch the same file / hook / setting / list / rules block as this journal entry, oldest first. */
    peers(e) {
      return liveEntries()
        .filter((p) => p.entry !== e && sameTarget(p.entry, e))
        .sort((x, y) => cmpSeq(x.seq, y.seq));
    },
    /**
     * The text of a file as it is (null: there is none). A dry run writes nothing, so the files it `would` have changed are
     * kept in `sim`, shared by every batch of one undo run: a later entry must see the file as the real run leaves it.
     */
    fileText(file) {
      const key = pathKey(file);
      if (sim.has(key)) return sim.get(key);
      return exists(file) ? fs.readFileSync(file, 'utf8') : null;
    },
    writeFile(file, text) {
      if (dry) sim.set(pathKey(file), text);
      else {
        this.backup(file);
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, text, 'utf8');
      }
    },
    removeFile(file) {
      if (dry) sim.set(pathKey(file), null);
      else {
        this.backup(file);
        fs.unlinkSync(file);
      }
    },
    /** Keep the text a file action wrote next to the journal: undo puts it back when a later writer of the file is undone. */
    keepContent(text) {
      if (dry) return;
      const dest = path.join(batchDir, 'contents', sha(text));
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, text, 'utf8');
    },
    /** A journal entry of another batch was changed: its manifest has to be written back. */
    touch(box) {
      if (!dry) touched.add(box);
    },
    describe(line) {
      described.push(line);
    },
    /** A journal entry the handler wants recorded after its own (a change made on the side, e.g. an old hook taken out). */
    also(entry) {
      alsoEntries.push(entry);
    },
    /** The side entries recorded since the last call (cmdApply puts them right behind the entry of the action). */
    takeAlso() {
      return alsoEntries.splice(0);
    },
    /** A message for the user that is not a change (something left alone, something not found). */
    note(line) {
      notes.push(line);
    },
    // keyed like `sim`: the same file spelled C:p and c:/p is one settings object
    load(file) {
      const key = pathKey(file);
      if (!cache.has(key)) cache.set(key, readJsonOrEmpty(file));
      return cache.get(key);
    },
    save(file, data) {
      this.backup(file);
      writeJsonPretty(file, data);
      cache.set(pathKey(file), data);
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
      // no scope when neither --scope nor a recommendation names one: cmdApply then takes the recipe's own defaultScope
      const scope = args.flags.scope || (r && r.scope);
      return { id, ...(scope ? { scope } : {}), params: Object.fromEntries((r ? r.params : []).map((p) => [p.name, p.value])) };
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
  const settingsCache = new Map();
  const fileSim = new Map();
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
    ctx.hookKey = hookScriptKey(recipe, scope, ctx.projectDir);
    // the entries of the recipes already handled in this batch count too: two recipes of one run can share a file.
    // A dry run writes nothing, so what it would have changed is carried from one recipe to the next (the settings files,
    // CLAUDE.md and the scripts as they would be), and the plan it prints is the one the real run carries out.
    const io = makeIo({ dry, force: !!flags.force, measure, batchDir, recipeId: recipe.id, t, lang, live: () => collectLive(listManifests(), { extra: { id: batchId, manifest } }), ...(dry ? { cache: settingsCache, sim: fileSim } : {}) });
    const entries = [];
    const claims = []; // hooks an earlier batch of this recipe wired: this batch relies on them if it changes anything
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
        const side = io.takeAlso();
        if (entry && !entry.skipped) entries.push(entry, ...side);
        else if (entry && entry.skipped) {
          lines.push(`  · ${recipe.id}: ${entry.reason}${entry.file ? ` (${entry.file})` : ''}`);
          if (entry.claim) claims.push(entry.claim);
        }
      } catch (err) {
        io.takeAlso();
        lines.push(`! ${recipe.id}: ${err.message}`);
      }
    }
    if (entries.length) entries.push(...claims);
    for (const d of io.described) lines.push(`  ${dry ? '→' : '✓'} ${d}`);
    for (const n of io.notes) lines.push(`  · ${recipe.id}: ${n}`);
    manifest.recipes.push({ id: recipe.id, scope, params, actions: entries, advice: !(recipe.actions && recipe.actions.length), ...(recipe.id.startsWith('custom.') ? { digest: recipeDigest(recipe), recipe: JSON.parse(JSON.stringify(recipe)) } : {}) });
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
 * The text a file entry wrote, kept in the contents/ folder of its batch and checked against the hash the entry recorded.
 * Null when there is none (journals from before the folder existed).
 */
function recordedContent(p) {
  if (!p.box.dir || !p.entry.hash) return null;
  const file = path.join(p.box.dir, 'contents', p.entry.hash);
  if (!exists(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return sha(text) === p.entry.hash ? text : null;
}

/**
 * Undo of a `file` entry. Two recipes can share one hook script, and the same recipe can be applied again with other
 * parameters; the rules are:
 *  - the file is deleted only when no other entry in force refers to it;
 *  - while the file is in use, its content is the one the newest writer in force wrote (`hash`; an entry that merely
 *    relies on the file, `shared`, wrote nothing). Undoing the newest writer puts the content of the next newest writer
 *    back, from the text that writer recorded; undoing an older writer changes nothing on the disk;
 *  - what the user edited is detected against the hash Kaizen itself wrote, never against the file as it is on the disk.
 */
function undoFile(e, io) {
  const text = io.fileText(e.file);
  if (text === null) return 'file already removed';
  const cur = sha(text);
  const peers = io.peers(e); // other entries in force that use this file, oldest first
  if (!peers.length) {
    // A Kaizen script that a hook of another batch in force still runs stays, whatever that batch's journal says (batches
    // of 0.1.4 and earlier have no claim entry for a script they share); that batch takes the file over, so that its own
    // undo removes it.
    const me = io.live().find((p) => p.entry === e);
    const inState = foldPath(path.resolve(e.file)).startsWith(foldPath(path.resolve(stateDir())) + '/');
    const users = inState ? hookUsersOfFile(io, e.file, me && me.box) : [];
    if (users.length) {
      const heir = users[users.length - 1];
      heir.recipe.actions.push({ type: 'file', file: e.file, existedBefore: e.existedBefore, hash: e.hash, createdDir: null });
      io.touch(heir.box);
      return `shared: ${e.file} still in use by ${recipeNames(users)}`;
    }
    if (cur !== e.hash && !io.revertEdited) return `kept: ${e.file} modified since apply`;
    io.describe(io.t('undo.plan.delete', { file: e.file }));
    io.removeFile(e.file);
    if (!io.dry && e.createdDir && exists(e.createdDir) && !fs.readdirSync(e.createdDir).length) fs.rmdirSync(e.createdDir);
    return 'ok';
  }
  const stillUsedBy = () => `shared: ${e.file} still in use by ${[...new Set(peers.map((p) => p.recipe.id))].join(', ')}`;
  if (e.shared) return 'ok'; // wrote nothing, so there is nothing to revert, whatever happened to the file since
  const me = io.live().find((p) => p.entry === e);
  const writers = peers.filter((p) => !p.entry.shared);
  if (me && writers.some((p) => cmpSeq(p.seq, me.seq) > 0)) return stillUsedBy(); // a newer writer owns the content
  if (cur !== e.hash && !io.revertEdited) return `kept: ${e.file} modified since apply`;
  const prev = me ? writers.filter((p) => cmpSeq(p.seq, me.seq) < 0).pop() : null;
  if (prev) {
    let before = recordedContent(prev);
    if (before === null && e.existedBefore && io.applyDir) {
      // journals from before the contents/ folder: the batch backup holds the version this entry overwrote
      const saved = path.join(io.applyDir, 'backups', e.file.replace(/[:\\/]/g, '_'));
      const old = exists(saved) ? fs.readFileSync(saved, 'utf8') : null;
      if (old !== null && sha(old) === prev.entry.hash) before = old;
    }
    if (before !== null) {
      if (sha(before) !== cur) {
        const names = [...new Set(writers.filter((p) => cmpSeq(p.seq, me.seq) < 0).map((p) => p.recipe.id))].join(', ');
        io.describe(io.say(`${e.file}: back to the version of ${names}`, `${e.file}: возвращена версия рецепта ${names}`));
        io.writeFile(e.file, before);
      }
      return 'ok';
    }
  }
  // The file stays as it is for the entries left over: they now expect the content that remains.
  for (const p of peers) {
    p.entry.hash = e.hash;
    if (e.createdDir && !p.entry.createdDir) p.entry.createdDir = e.createdDir; // the one left over cleans up the skill folder
    io.touch(p.box);
  }
  return stillUsedBy();
}

function undoEntry(e, io) {
  switch (e.type) {
    case 'settings.hook': {
      const s = io.load(e.file);
      const list = s.hooks && s.hooks[e.event];
      if (e.shared) return 'ok'; // used another recipe's hook and installed nothing of its own
      if (!Array.isArray(list)) {
        forgetRemovals(io, e);
        return 'hook list missing';
      }
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
        } else if (mine && gt && gt.some((x) => mine.includes(x))) {
          // this entry took over alternatives that an undone batch had installed (they sit in groups of their own)
          const rest = gt.filter((x) => !mine.includes(x));
          // a group that serves other alternatives too, and holds more than our hook, belongs to somebody else: leave it
          if (rest.length && ids.length !== group.hooks.length) continue;
          sample ||= ids[0];
          gt.filter((x) => mine.includes(x)).forEach((x) => gone.add(x));
          if (rest.length) group.matcher = rest.join('|');
          else {
            // take only our hook out: the user may have added hooks of their own to this group
            group.hooks = group.hooks.filter((h) => hookIdentity(h) !== e.identity);
            removed += ids.length;
          }
        }
        // else: the same command sits in another group for other matchers (installed by another recipe): leave that one
      }
      const adopters = []; // the batches that took the hook over, because they still need it
      let kept = false; // ... and between them they cover everything this undo took out: the hook stays
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
          // changed in memory in a dry run too (the journal is only written back when it is not one): the entries of the
          // next batch of the same run have to see what the real run would have left
          const order = want || [];
          const merged = [...new Set([...(tokensOf(p.entry.matcher) || []), ...(restore || [])])].sort((x, y) => (order.indexOf(x) + 1 || 1e9) - (order.indexOf(y) + 1 || 1e9));
          p.entry.matcher = restore ? merged.join('|') : null;
          p.entry.adopted = true;
          delete p.entry.shared;
          io.touch(p.box);
          adopters.push(p);
        }
        kept = adopters.length > 0 && (coveredAll || (!goneAll && [...gone].every((x) => covered.has(x))));
      }
      s.hooks[e.event] = list.filter((g) => g.hooks && g.hooks.length);
      if (!s.hooks[e.event].length) delete s.hooks[e.event];
      if (!Object.keys(s.hooks).length) delete s.hooks;
      if (!io.dry) io.save(e.file, s);
      // the hook is still in the file when another batch adopted it: say that, not that it was removed
      if (kept) return `shared: ${e.file} [${e.event}] still in use by ${recipeNames(adopters)}`;
      if (removed) io.describe(io.t('undo.plan.hook_remove', { file: e.file, event: e.event, command: e.identity.split('|')[1] }));
      else forgetRemovals(io, e);
      return removed ? 'ok' : 'hook was already gone';
    }
    case 'settings.set': {
      if (e.shared) return 'ok'; // relied on a value another batch set and set nothing itself
      const s = io.load(e.file);
      // A batch set later than this one (or relying on its value) is in force: the value is theirs now. The oldest of them
      // takes over what this entry would have put back, so that undoing it later restores the original.
      const me = io.live().find((p) => p.entry === e);
      const newer = me ? io.peers(e).filter((p) => cmpSeq(p.seq, me.seq) > 0) : [];
      if (newer.length) {
        const heir = newer[0];
        heir.entry.previous = e.previous;
        heir.entry.hadPrevious = e.hadPrevious;
        delete heir.entry.shared;
        io.touch(heir.box);
        return `shared: ${e.file} [${e.path}] still in use by ${recipeNames(newer)}`;
      }
      const cur = getPath(s, e.path);
      if (JSON.stringify(cur) !== JSON.stringify(e.value) && !io.revertEdited) return `kept: ${e.path} changed since apply`;
      if (e.hadPrevious) setPath(s, e.path, e.previous);
      else deletePath(s, e.path);
      io.describe(io.t('undo.plan.restore', { file: e.file, path: e.path }));
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'settings.append': {
      if (!(e.added || []).length) return 'ok'; // relied on values another batch added
      const s = io.load(e.file);
      const arr = getPath(s, e.path);
      if (!Array.isArray(arr)) return 'list missing';
      // A value another batch in force added or relies on stays; the newest of them owns it from now on.
      const peers = io.peers(e);
      const kept = new Set();
      for (const v of e.added) {
        const holders = peers.filter((p) => (p.entry.added || []).includes(v) || (p.entry.claimed || []).includes(v));
        if (!holders.length) continue;
        kept.add(v);
        const heir = holders[holders.length - 1];
        if (!(heir.entry.added || []).includes(v)) {
          heir.entry.added = [...(heir.entry.added || []), v];
          heir.entry.claimed = (heir.entry.claimed || []).filter((x) => x !== v);
          io.touch(heir.box);
        }
      }
      const gone = e.added.filter((v) => !kept.has(v));
      setPath(s, e.path, arr.filter((v) => !gone.includes(v)));
      if (!gone.length) return `shared: ${e.file} [${e.path}] still in use by ${recipeNames(peers)}`;
      io.describe(io.t('undo.plan.remove_items', { file: e.file, n: gone.length, path: e.path }));
      if (!io.dry) io.save(e.file, s);
      return 'ok';
    }
    case 'file':
      return undoFile(e, io);
    case 'claude-md.block': {
      if (e.shared) return 'ok'; // relied on a block another batch wrote and wrote nothing itself
      const text = io.fileText(e.file); // through io: a dry run sees the file as the batches undone before this one leave it
      if (text === null) return 'file missing';
      const start = `<!-- kaizen:start ${e.id} -->`;
      const end = `<!-- kaizen:end ${e.id} -->`;
      const m = new RegExp(`(\\n?\\n?)${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}(\\n?)`).exec(text);
      if (!m) return 'block already gone';
      // A batch written later than this one (or relying on its block) is in force: the block is theirs now, and the oldest
      // of them takes over what this entry would have put back, so that undoing it later restores the original file.
      const me = io.live().find((p) => p.entry === e);
      const newer = me ? io.peers(e).filter((p) => cmpSeq(p.seq, me.seq) > 0) : [];
      if (newer.length) {
        const heir = newer[0];
        heir.entry.previousBlock = e.previousBlock ?? null;
        heir.entry.tail = e.tail ?? null;
        heir.entry.existedBefore = e.existedBefore;
        delete heir.entry.shared;
        io.touch(heir.box);
        return `shared: ${e.file} [${e.id}] still in use by ${recipeNames(newer)}`;
      }
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
      if (!e.existedBefore && !next.trim()) io.removeFile(e.file); // the file was created by apply and nothing else is in it
      else io.writeFile(e.file, next);
      return 'ok';
    }
    case 'mcp.disable': {
      if (!(e.removed || []).length) return 'ok'; // relied on servers another batch removed
      const cfg = io.load(e.file);
      cfg.mcpServers ||= {};
      let restored = 0;
      const back = []; // the servers nobody else needs gone: they return
      const kept = [];
      for (const r of e.removed) {
        const holders = mcpHolders(io, e.file, r, e);
        if (holders.length) {
          // another batch in force removed the server too or relies on that: it stays out, the newest of them owns it now
          const heir = holders[holders.length - 1];
          if (!(heir.entry.removed || []).some((x) => sameMcp(x, r))) {
            heir.entry.removed = [...(heir.entry.removed || []), r];
            heir.entry.claimed = (heir.entry.claimed || []).filter((x) => !sameMcp(x, r));
            io.touch(heir.box);
          }
          kept.push(...holders);
          continue;
        }
        back.push(r);
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
      if (!back.length) return `shared: ${e.file} [${e.removed.map((r) => r.name).join(', ')}] still in use by ${recipeNames(kept)}`;
      io.describe(io.t('undo.plan.restore_mcp', { file: e.file, names: back.map((r) => r.name).join(', ') }));
      if (!io.dry) io.save(e.file, cfg);
      return restored ? 'ok' : 'servers already present';
    }
    case 'settings.hook.remove': {
      if (!(e.removed || []).length) return 'ok'; // relied on hooks another batch removed
      let restored = 0;
      const kept = [];
      for (const r of e.removed) {
        const holders = hookRemoveHolders(io, r, e);
        if (holders.length) {
          // another batch in force removed the hook too or relies on that: it stays out, the newest of them owns it now
          const heir = holders[holders.length - 1];
          if (!(heir.entry.removed || []).some((x) => sameRemovedHook(x, r))) {
            heir.entry.removed = [...(heir.entry.removed || []), r];
            heir.entry.claimed = (heir.entry.claimed || []).filter((x) => !sameRemovedHook(x, r));
            io.touch(heir.box);
          }
          kept.push(...holders);
          continue;
        }
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
      if (!restored && kept.length) return `shared: ${e.removed[0].file} [${e.removed.map((r) => r.event).join(', ')}] still in use by ${recipeNames(kept)}`;
      return restored ? 'ok' : 'hooks already present';
    }
    case 'plugins.disable': {
      // journals of 0.1.x name one file for the whole entry; a change of a newer journal may name its own
      const restore = new Map(); // file -> the changes to put back there
      const kept = [];
      for (const c of e.changed || []) {
        const file = c.file || e.file;
        const holders = pluginHolders(io, { plugin: c.plugin, file }, e);
        if (holders.length) {
          // another batch in force switched the plugin off too or relies on it: it stays off, the newest of them owns it
          const heir = holders[holders.length - 1];
          if (!(heir.entry.changed || []).some((x) => x.plugin === c.plugin && samePath(x.file || heir.entry.file, file))) {
            heir.entry.changed = [...(heir.entry.changed || []), { plugin: c.plugin, previous: c.previous, file, ...(c.created ? { created: true } : {}) }];
            heir.entry.claimed = (heir.entry.claimed || []).filter((x) => !(x.plugin === c.plugin && samePath(x.file, file)));
            io.touch(heir.box);
          }
          kept.push({ plugin: c.plugin, holders });
        } else restore.set(file, [...(restore.get(file) || []), c]);
      }
      for (const [file, changes] of restore) {
        const s = io.load(file);
        s.enabledPlugins ||= {};
        for (const c of changes) {
          if (c.previous === null || c.previous === undefined) delete s.enabledPlugins[c.plugin];
          else s.enabledPlugins[c.plugin] = c.previous;
        }
        const created = changes.some((c) => c.created); // the file did not exist before apply
        if (created && !Object.keys(s.enabledPlugins).length) delete s.enabledPlugins;
        io.describe(io.t('undo.plan.reenable_plugins', { file, names: changes.map((c) => c.plugin).join(', ') }));
        if (created && !Object.keys(s).length && io.fileText(file) !== null) io.removeFile(file);
        else if (!io.dry) io.save(file, s);
      }
      if (!restore.size && kept.length) return `shared: ${e.file} [${[...new Set(kept.map((k) => k.plugin))].join(', ')}] still in use by ${recipeNames(kept.flatMap((k) => k.holders))}`;
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
  // A dry run writes nothing, so what it would have changed is carried from one batch of the run to the next: the
  // settings files as they would be, the files as they would be. The real run finds that on the disk.
  const settingsCache = new Map();
  const fileSim = new Map();
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
    const io = makeIo({ dry, force: true, measure: null, batchDir: path.join(m.dir, 'undo', runId), recipeId: null, t, lang, applyDir: m.dir, live: () => collectLive(manifests, { done }), ...(dry ? { cache: settingsCache, sim: fileSim } : {}) });
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
