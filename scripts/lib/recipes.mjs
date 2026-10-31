// Recipe engine: loads recipes/catalog.json, evaluates each recipe's `when`
// conditions against a measurement, renders evidence text and ranks results.
//
// Conditions are plain JSON (no eval):
//   {"metric": "friction.timeouts", "gte": 5}
//   {"all": [c1, c2]}  {"any": [c1, c2]}  {"not": c}
// Operators: gte gt lte lt eq neq in includes truthy falsy exists
// Metric paths are dotted paths into the measure object; a trailing `.length`
// works on arrays, strings and plain objects (key count).
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from './paths.mjs';
import { interpolate, pick } from './i18n.mjs';

export const IMPACT_WEIGHT = { high: 3, medium: 2, low: 1 };
export const RISK_PENALTY = { low: 0, medium: 0.5, high: 1 };

export function loadCatalog(file = path.join(kitRoot(), 'recipes', 'catalog.json')) {
  const cat = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cat.recipes)) throw new Error('catalog.json: recipes[] missing');
  return cat;
}

export function resolvePath(obj, dotted) {
  if (!dotted) return undefined;
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (cur === undefined || cur === null) return undefined;
    if (p === 'length' && i === parts.length - 1) {
      if (Array.isArray(cur) || typeof cur === 'string') return cur.length;
      if (typeof cur === 'object') return Object.keys(cur).length;
      return undefined;
    }
    cur = cur[p];
  }
  return cur;
}

export function evaluate(cond, measure) {
  if (cond === undefined || cond === null || cond === true) return true;
  if (cond === false) return false;
  if (Array.isArray(cond)) return cond.every((c) => evaluate(c, measure));
  if (typeof cond !== 'object') throw new Error(`bad condition: ${JSON.stringify(cond)}`);
  if ('all' in cond) return cond.all.every((c) => evaluate(c, measure));
  if ('any' in cond) return cond.any.some((c) => evaluate(c, measure));
  if ('not' in cond) return !evaluate(cond.not, measure);
  const v = resolvePath(measure, cond.metric);
  const num = typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : NaN;
  if ('exists' in cond) return cond.exists ? v !== undefined && v !== null : v === undefined || v === null;
  if ('truthy' in cond) return cond.truthy ? !!v : !v;
  if ('falsy' in cond) return cond.falsy ? !v : !!v;
  if ('gte' in cond) return !Number.isNaN(num) && num >= cond.gte;
  if ('gt' in cond) return !Number.isNaN(num) && num > cond.gt;
  if ('lte' in cond) return !Number.isNaN(num) && num <= cond.lte;
  if ('lt' in cond) return !Number.isNaN(num) && num < cond.lt;
  if ('eq' in cond) return v === cond.eq || (!Number.isNaN(num) && num === cond.eq);
  if ('neq' in cond) return !(v === cond.neq || (!Number.isNaN(num) && num === cond.neq));
  if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(v);
  if ('includes' in cond) {
    if (Array.isArray(v)) return v.includes(cond.includes);
    if (typeof v === 'string') return v.includes(cond.includes);
    if (v && typeof v === 'object') return cond.includes in v;
    return false;
  }
  throw new Error(`condition has no operator: ${JSON.stringify(cond)}`);
}

/** Flatten the measure for templating: {a:{b:1}} -> {"a.b": 1} plus original nesting. */
function templateVars(measure) {
  return measure;
}

function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => (typeof x === 'object' ? x.name || x.server || x.command || JSON.stringify(x) : String(x))).join(', ');
  if (v && typeof v === 'object') return Object.keys(v).slice(0, 5).join(', ');
  return v === undefined || v === null ? '?' : String(v);
}

export function renderText(template, measure, params = {}) {
  if (!template) return '';
  return String(template).replace(/\{([a-zA-Z0-9_.]+)(?:\|([a-z]+))?\}/g, (m, key, filter) => {
    let v = key.startsWith('params.') ? resolvePath(params, key.slice(7)) : resolvePath(measure, key);
    if (v === undefined || v === null) {
      // a missing key inside a counts map means zero; anything else is unknown
      const parent = resolvePath(key.startsWith('params.') ? params : measure, key.split('.').slice(0, -1).join('.'));
      const isCounts = parent && typeof parent === 'object' && !Array.isArray(parent) && Object.values(parent).every((x) => typeof x === 'number');
      if (filter === 'pct') return isCounts ? '0%' : 'n/a';
      return isCounts ? '0' : 'n/a';
    }
    if (filter === 'pct') return `${Math.round(Number(v) * 100)}%`;
    if (filter === 'int') return String(Math.round(Number(v)));
    if (filter === 'k') return `${(Number(v) / 1000).toFixed(1)}k`;
    if (filter === 'len') return String(Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : String(v).length);
    return fmt(v);
  });
}

/** Score = impact weight + boosts - risk penalty; used only for ordering. */
export function score(recipe, measure) {
  let s = IMPACT_WEIGHT[recipe.impact] || 1;
  for (const b of recipe.boost || []) if (evaluate(b.when, measure)) s += b.weight || 1;
  s -= RISK_PENALTY[recipe.risk] || 0;
  return Number(s.toFixed(2));
}

/** Default parameter values, optionally seeded from the measure (`defaultFrom`). */
export function defaultParams(recipe, measure) {
  const out = {};
  for (const p of recipe.params || []) {
    let v = p.default;
    if (p.defaultFrom) {
      const m = resolvePath(measure, p.defaultFrom);
      if (m !== undefined && m !== null && !(Array.isArray(m) && m.length === 0)) v = m;
    }
    out[p.name] = v;
  }
  return out;
}

/**
 * Evaluate the catalog against a measure.
 * Returns {recommended: [...], alreadyApplied: [...], notApplicable: [...]}.
 * `applied` is a Set of recipe ids already applied (from the Kaizen journal).
 */
export function recommend(catalog, measure, { lang = 'en', applied = new Set(), includeAll = false } = {}) {
  const recommended = [];
  const notApplicable = [];
  const alreadyApplied = [];
  for (const r of catalog.recipes) {
    if (r.disabled) continue;
    let matched = false;
    try {
      matched = evaluate(r.when, measure);
    } catch (err) {
      notApplicable.push({ id: r.id, reason: `bad condition: ${err.message}` });
      continue;
    }
    if (applied.has(r.id)) {
      alreadyApplied.push({ id: r.id, matched });
      if (!includeAll) continue;
    }
    if (!matched && !includeAll) {
      notApplicable.push({ id: r.id, reason: 'conditions not met' });
      continue;
    }
    const params = defaultParams(r, measure);
    recommended.push({
      id: r.id,
      category: r.category,
      impact: r.impact,
      effort: r.effort || 'low',
      risk: r.risk || 'low',
      scope: r.defaultScope || (Array.isArray(r.scope) ? r.scope[0] : r.scope) || 'user',
      scopes: Array.isArray(r.scope) ? r.scope : [r.scope || 'user'],
      title: renderText(pick(r.title, lang), templateVars(measure), params),
      why: renderText(pick(r.why, lang), templateVars(measure), params),
      evidence: renderText(pick(r.evidence, lang), templateVars(measure), params),
      matched,
      score: score(r, measure),
      params: (r.params || []).map((p) => {
        let options = p.options || null;
        if (p.optionsFrom) {
          const dyn = resolvePath(measure, p.optionsFrom);
          if (Array.isArray(dyn)) options = dyn.map((x) => (typeof x === 'object' ? x.name || x.id || JSON.stringify(x) : String(x)));
        }
        return { name: p.name, type: p.type || 'text', label: pick(p.label, lang), options, value: params[p.name] };
      }),
      actionsSummary: (r.actions || []).filter((a) => actionApplies(a, measure)).map((a) => summarizeAction(a, lang)),
      kind: r.actions && r.actions.length ? 'recipe' : 'advice',
      source: r.source || null,
      conflicts: r.conflicts || [],
    });
  }
  recommended.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { recommended, alreadyApplied, notApplicable };
}

/** Actions may carry their own `when`; an action whose condition fails is skipped by apply and hidden from summaries. */
export function actionApplies(action, measure) {
  if (!action || action.when === undefined) return true;
  try {
    return evaluate(action.when, measure);
  } catch {
    return true;
  }
}

function humanPath(s) {
  return String(s || '')
    .replace('{kaizenHome}', '~/.claude/kaizen')
    .replace('{configDir}', '~/.claude')
    .replace('{skillsDir}', '<skills dir>')
    .replace('{agentsDir}', '<agents dir>')
    .replace('{claudeMd}', 'CLAUDE.md')
    .replace(/\{params\.([a-zA-Z0-9_]+)\}/g, '<$1>');
}

function summarizeAction(a, lang) {
  const ru = lang === 'ru';
  switch (a.type) {
    case 'settings.hook':
      return ru ? `хук ${a.event}${a.matcher ? ` (${a.matcher})` : ''} в settings.json` : `${a.event} hook${a.matcher ? ` (${a.matcher})` : ''} in settings.json`;
    case 'settings.set':
      return `settings.json: ${a.path} = ${humanPath(JSON.stringify(a.value))}`;
    case 'settings.append':
      return ru ? `settings.json: дополнить ${a.path}` : `settings.json: extend ${a.path}`;
    case 'file':
      return ru ? `файл ${humanPath(a.target)}` : `file ${humanPath(a.target)}`;
    case 'skill':
      return ru ? `скилл /${humanPath(a.name)}` : `skill /${humanPath(a.name)}`;
    case 'agent':
      return ru ? `субагент ${a.name}` : `subagent ${a.name}`;
    case 'claude-md.block':
      return ru ? `блок правил в ${humanPath(a.target || '{claudeMd}')}` : `rules block in ${humanPath(a.target || '{claudeMd}')}`;
    case 'mcp.disable':
      return ru ? 'убрать выбранные MCP-серверы из ~/.claude.json (с резервной копией)' : 'remove the selected MCP servers from ~/.claude.json (backed up)';
    case 'plugins.disable':
      return ru ? 'выключить выбранные плагины в settings.json' : 'disable the selected plugins in settings.json';
    default:
      return a.type;
  }
}

/** Validate catalog structure; returns a list of problems (empty when fine). */
export function validateCatalog(catalog, { templatesDir = path.join(kitRoot(), 'recipes', 'templates') } = {}) {
  const problems = [];
  const ids = new Set();
  for (const r of catalog.recipes || []) {
    const where = `recipe ${r.id || '(no id)'}`;
    if (!r.id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(r.id)) problems.push(`${where}: invalid id`);
    if (ids.has(r.id)) problems.push(`${where}: duplicate id`);
    ids.add(r.id);
    for (const f of ['title', 'why', 'evidence']) {
      if (!r[f] || typeof r[f] !== 'object') problems.push(`${where}: ${f} must be {en, ru}`);
      else for (const l of ['en', 'ru']) if (!r[f][l]) problems.push(`${where}: ${f}.${l} missing`);
    }
    if (!['high', 'medium', 'low'].includes(r.impact)) problems.push(`${where}: impact must be high|medium|low`);
    if (r.risk && !['high', 'medium', 'low'].includes(r.risk)) problems.push(`${where}: risk must be high|medium|low`);
    if (!r.category) problems.push(`${where}: category missing`);
    try {
      evaluate(r.when, {});
    } catch (err) {
      problems.push(`${where}: when: ${err.message}`);
    }
    for (const a of r.actions || []) {
      if (!a.type) problems.push(`${where}: action without type`);
      if (a.template) {
        const p = path.join(templatesDir, a.template);
        if (!fs.existsSync(p)) problems.push(`${where}: template missing: ${a.template}`);
      }
      if (a.type === 'settings.hook' && (!a.event || !a.command)) problems.push(`${where}: settings.hook needs event and command`);
      if (a.type === 'settings.set' && (!a.path || a.value === undefined)) problems.push(`${where}: settings.set needs path and value`);
      if (a.type === 'settings.append' && (!a.path || (!a.values && !a.valuesFrom))) problems.push(`${where}: settings.append needs path and values|valuesFrom`);
      if ((a.type === 'file' || a.type === 'skill' || a.type === 'agent') && !a.template && !a.content) problems.push(`${where}: ${a.type} needs template or content`);
      if (a.type === 'claude-md.block' && !a.template && !a.content) problems.push(`${where}: claude-md.block needs template or content`);
    }
    for (const p of r.params || []) {
      if (!p.name) problems.push(`${where}: param without name`);
      if ((p.type === 'select' || p.type === 'multiselect') && !Array.isArray(p.options) && !p.optionsFrom) problems.push(`${where}: ${p.type} param ${p.name} needs options or optionsFrom`);
      if (!p.label || !p.label.en || !p.label.ru) problems.push(`${where}: param ${p.name} needs label {en, ru}`);
    }
  }
  return problems;
}
