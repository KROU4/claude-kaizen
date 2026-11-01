#!/usr/bin/env node
// Kaizen CLI — the deterministic half of the kit. Skills and agents call these
// subcommands; humans can too.
//
//   kaizen measure   [--days N|--all] [--project DIR] [--lang en|ru] [--no-cache] [--quiet]
//   kaizen recommend [--lang en|ru] [--top N] [--json] [--all]
//   kaizen console   [--mode local|render] [--port N] [--no-open] [--out FILE] [--lang]
//   kaizen choices   --import FILE|-
//   kaizen paths     (JSON: the state dir and the files in it; skills and agents read it instead of a fixed ~/.claude/kaizen)
//   kaizen apply     [FILE|--recipe id,id|--from-batch ID [--recipe id,id]] [--dry-run] [--scope user|project] [--project DIR] [--param r.p=v] [--param-file r.p=PATH] [--add FILE]
//   kaizen undo      [ID|--last|--all] [--dry-run] [--force]
//   kaizen status | doctor | selfcheck | docs | nudge | help | --version
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir, ensureDir, exists, expandHome, kitRoot, projectsDir, readJsonSafe, settingsFiles, stateDir, usageDataDir, writeJsonAtomic } from './lib/paths.mjs';
import { scanTranscripts } from './lib/transcripts.mjs';
import { inventory } from './lib/inventory.mjs';
import { readInsights } from './lib/insights.mjs';
import { buildMeasure, METRIC_DOCS } from './lib/metrics.mjs';
import { renderDigest } from './lib/digest.mjs';
import { translator, SUPPORTED, UserError } from './lib/i18n.mjs';
import { claudeVersion, platformSummary } from './lib/platform.mjs';
import { addExtraRecipes, loadCatalog, readExtraRecipes, recipeDigest, recommend, rememberedExtraFile, resolveExtraFile, validateCatalog } from './lib/recipes.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(kitRoot(), 'package.json'), 'utf8')).version;

/**
 * Flags that take a value. Only these consume the next argument; every other flag (--dry-run, --force, --json, --all,
 * --last ...) is a boolean and never swallows the positional argument that follows it.
 */
export const VALUE_FLAGS = new Set(['days', 'project', 'lang', 'scope', 'param', 'param-file', 'recipe', 'top', 'add', 'mode', 'port', 'out', 'timeout', 'transport', 'import', 'from-batch']);

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let value;
      if (eq > 0) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      // a repeated flag (e.g. several --param) accumulates into an array
      if (key in args.flags) args.flags[key] = [].concat(args.flags[key], value);
      else args.flags[key] = value;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function out(line = '') {
  process.stdout.write(line + '\n');
}

function err(line) {
  process.stderr.write(line + '\n');
}

function readConfig() {
  return readJsonSafe(path.join(stateDir(), 'config.json'), {}) || {};
}

function validLang(l) {
  return typeof l === 'string' && SUPPORTED.includes(l) ? l : null;
}

/**
 * The language the user last asked for with --lang. `measure` and `recommend` record it (uiLang) in measure.json and
 * recommendations.json; when both carry one, the file written last wins. Null when --lang was never given.
 */
function storedUiLang(measure) {
  const m = measure || readJsonSafe(path.join(stateDir(), 'measure.json'));
  const rec = readJsonSafe(path.join(stateDir(), 'recommendations.json'));
  const found = [m, rec]
    .filter((x) => x && validLang(x.uiLang))
    .map((x) => ({ at: Date.parse(x.generatedAt) || 0, lang: x.uiLang }))
    .sort((a, b) => b.at - a.at);
  return found.length ? found[0].lang : null;
}

/** --lang, then config.json, then the language chosen earlier with --lang (measure/recommend), then the detected one. */
function pickLang(flags, measure) {
  const fromFlag = validLang(flags && flags.lang);
  if (fromFlag) return fromFlag;
  const fromConfig = validLang(readConfig().lang);
  if (fromConfig) return fromConfig;
  const stored = storedUiLang(measure);
  if (stored) return stored;
  const m = measure || readJsonSafe(path.join(stateDir(), 'measure.json'));
  return (m && m.locale && validLang(m.locale.lang)) || 'en';
}

// the flags of the running command, so that errors raised deep inside (no measurement yet ...) honour --lang
let cliFlags = {};

function loadMeasure() {
  const file = path.join(stateDir(), 'measure.json');
  const m = readJsonSafe(file);
  if (!m) throw new UserError(translator(pickLang(cliFlags, null))('err.no_measure', { file }));
  return m;
}

/**
 * Ids of the recipes the journal holds as applied. `extraFile` is the extra-recipes file in use: kaizen-analyst rewrites
 * it on every run and keeps the `custom.*` ids stable, so a custom recipe whose batch is older than the last write of
 * that file was applied with the previous draft and is offered again (re-applying replaces its block or skill).
 */
function appliedIds(extraFile = null) {
  const journalDir = path.join(stateDir(), 'applied');
  const ids = new Set();
  if (!exists(journalDir)) return ids;
  let redrafted = null;
  if (extraFile) {
    try {
      const extra = readExtraRecipes(extraFile);
      // only custom.* drafts can be redrafted; a built-in id wins a lookup, so its entry in the file changes nothing
      if (extra && Array.isArray(extra.recipes)) redrafted = { digests: new Map(extra.recipes.filter((r) => r && typeof r.id === 'string' && r.id.startsWith('custom.')).map((r) => [r.id, recipeDigest(r)])), at: fs.statSync(extraFile).mtimeMs };
    } catch {
      /* an unreadable file means no custom recipes to compare */
    }
  }
  // A batch still covers a redrafted custom recipe when it applied the same content (journals before 0.1.4 have no digest:
  // there the batch must be newer than the file).
  const outdated = (man, r) => {
    if (!redrafted || !redrafted.digests.has(r.id)) return false;
    return r.digest ? r.digest !== redrafted.digests.get(r.id) : Date.parse(man.at) < redrafted.at;
  };
  for (const d of fs.readdirSync(journalDir)) {
    const man = readJsonSafe(path.join(journalDir, d, 'manifest.json'));
    // A recipe whose every action was skipped (text parameter left empty, settings file unreadable, servers not found)
    // wrote nothing, so it must stay open for a re-apply. Advice recipes have no actions by design and count as handled.
    if (man && !man.undone) for (const r of man.recipes || []) if (!outdated(man, r) && (r.advice || (Array.isArray(r.actions) && r.actions.length))) ids.add(r.id);
  }
  return ids;
}

// ---------------------------------------------------------------- measure
async function cmdMeasure(flags) {
  const quiet = !!flags.quiet;
  const t = translator(pickLang(flags, null));
  const windowDays = flags.all ? 3650 : flags.days === undefined ? 30 : Number(flags.days);
  // checked before the (slow) scan: a typo like --days abc must not run it and then crash on an invalid date
  if (!Number.isFinite(windowDays) || windowDays <= 0) throw new UserError(t('err.bad_days', { value: Array.isArray(flags.days) ? flags.days.join(',') : String(flags.days) }));
  const since = new Date(Date.now() - windowDays * 86400000);
  const cfg = configDir();
  const state = ensureDir(stateDir());
  const projectDir = flags.project ? path.resolve(expandHome(String(flags.project))) : process.env.CLAUDE_PROJECT_DIR || null;
  if (!quiet) err(t('cli.measuring', { days: windowDays, dir: cfg }));
  const t0 = Date.now();
  const scan = await scanTranscripts({
    projectsDir: projectsDir(cfg),
    sinceMs: since.getTime(),
    cacheDir: path.join(state, 'cache', 'sessions'),
    useCache: !flags['no-cache'],
    onProgress: quiet ? null : (i, total) => (i % 25 === 0 || i === total ? err(`  ${i}/${total}`) : null),
  });
  if (!scan.scanned) {
    err(t('cli.no_data', { dir: projectsDir(cfg) }));
  }
  const inv = inventory({ projectDir });
  const ins = readInsights(usageDataDir(cfg), { sinceMs: since.getTime() });
  const measure = buildMeasure({
    sessions: scan.sessions,
    inventory: inv,
    insights: ins,
    env: {
      windowDays,
      since: since.toISOString(),
      configDir: cfg,
      projectDir,
      platform: platformSummary(),
      claudeVersion: claudeVersion(),
      kitVersion: VERSION,
    },
    scan,
  });
  // models by message share for the digest
  const models = {};
  let total = 0;
  for (const s of scan.sessions) for (const [m, u] of Object.entries(s.models || {})) {
    models[m] = (models[m] || { messages: 0 });
    models[m].messages += u.messages;
    total += u.messages;
  }
  for (const m of Object.values(models)) m.share = total ? m.messages / total : 0;
  measure.models = Object.fromEntries(Object.entries(models).sort((a, b) => b[1].messages - a[1].messages));

  // Remember an explicit --lang (or the one chosen earlier) so that console, apply, undo, verify and status speak it too
  const uiLang = validLang(flags.lang) || storedUiLang(null);
  if (uiLang) measure.uiLang = uiLang;
  const lang = pickLang(flags, measure);
  // keep the previous measurement so this digest can show what moved
  const prevJson = path.join(state, 'measure.json');
  const previous = readJsonSafe(prevJson);
  if (previous && previous.generatedAt !== measure.generatedAt) {
    fs.copyFileSync(prevJson, path.join(state, 'measure.previous.json'));
    const prevMd = path.join(state, 'measure.md');
    if (exists(prevMd)) fs.copyFileSync(prevMd, path.join(state, 'measure.previous.md'));
  }
  const digest = renderDigest(measure, lang, previous && previous.version === measure.version ? previous : null);
  writeJsonAtomic(path.join(state, 'measure.json'), measure);
  fs.writeFileSync(path.join(state, 'measure.md'), digest, 'utf8');
  writeJsonAtomic(path.join(state, 'last-measure.json'), { at: measure.generatedAt, windowDays, sessions: measure.totals.sessions, kitVersion: VERSION });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!quiet) {
    err(t('cli.scanned', { files: scan.scanned, mb: Math.round(scan.bytes / 1e6), cached: scan.cached, secs }));
    err(t('cli.written', { file: path.join(state, 'measure.json') }));
    err(t('cli.written', { file: path.join(state, 'measure.md') }));
  }
  if (flags.json) out(JSON.stringify(measure, null, 2));
  else if (!flags.quiet) out(digest);
  return measure;
}

// ---------------------------------------------------------------- recommend
function cmdRecommend(flags) {
  const measure = loadMeasure();
  const lang = pickLang(flags, measure);
  const catalog = loadCatalog();
  const extraFile = flags.add && flags.add !== true ? resolveExtraFile(flags.add) : null;
  const extra = extraFile ? readExtraRecipes(extraFile) : null;
  if (flags.add && !extra) throw new UserError(translator(lang)('err.add_unreadable', { file: flags.add }));
  addExtraRecipes(catalog, extra);
  const res = recommend(catalog, measure, { lang, applied: appliedIds(extraFile), includeAll: !!flags.all });
  // what is written (and shown) below is the --top slice, so the paramDefaults check must look at that slice, not the full list
  const top = flags.top ? Number(flags.top) : 0;
  const list = top ? res.recommended.slice(0, top) : res.recommended;
  if (extra && extra.paramDefaults && typeof extra.paramDefaults === 'object') {
    for (const r of res.recommended) {
      const defaults = extra.paramDefaults[r.id];
      if (!defaults) continue;
      for (const p of r.params) if (defaults[p.name] !== undefined) p.value = defaults[p.name];
    }
    const shown = new Set(list.map((r) => r.id));
    const dropped = Object.keys(extra.paramDefaults).filter((id) => !shown.has(id));
    if (dropped.length) err(translator(lang)('cli.param_defaults_dropped', { ids: dropped.join(', ') }));
  }
  if (extra && typeof extra.profile === 'string') writeJsonAtomic(path.join(stateDir(), 'profile.json'), { generatedAt: new Date().toISOString(), profile: extra.profile });
  const payload = {
    generatedAt: new Date().toISOString(),
    lang,
    // the language the user explicitly asked for (here or earlier); console, apply, undo, verify and status follow it
    ...(validLang(flags.lang) || storedUiLang(measure) ? { uiLang: validLang(flags.lang) || storedUiLang(measure) } : {}),
    measureGeneratedAt: measure.generatedAt,
    windowDays: measure.windowDays,
    sessions: measure.totals.sessions,
    recommendations: list,
    alreadyApplied: res.alreadyApplied,
    notApplicable: res.notApplicable.length,
  };
  // where the custom recipes came from, so `apply` can find them again when it is not given --add
  if (extraFile) payload.extraFile = extraFile;
  // `--all` lists every recipe in the catalog (browsing, id mapping). It must not replace the real recommendations that
  // status, the SessionStart nudge, the console and `apply --recipe` read.
  writeJsonAtomic(path.join(stateDir(), flags.all ? 'recommendations.all.json' : 'recommendations.json'), payload);
  const t = translator(lang);
  if (flags.json) {
    out(JSON.stringify(payload, null, 2));
    return payload;
  }
  if (!list.length) {
    out(t('cli.recommend_none'));
    return payload;
  }
  out(t('cli.recommend_header', { n: list.length, high: list.filter((r) => r.impact === 'high').length }));
  out('');
  for (const r of list) {
    out(`[${r.impact[0].toUpperCase()}] ${r.id} — ${r.title}${r.kind === 'advice' ? ` (${t('cli.advice_tag')})` : ''}`);
    out(`    ${r.evidence}`);
    if (r.actionsSummary.length) out(`    → ${r.actionsSummary.join('; ')}`);
  }
  if (res.alreadyApplied.length) {
    out('');
    out(t('cli.already_applied', { ids: res.alreadyApplied.map((a) => a.id).join(', ') }));
  }
  return payload;
}

// ---------------------------------------------------------------- choices
/**
 * `kaizen choices --import FILE|-` : take a choices document (what the console would have submitted) from a file or
 * stdin, validate it and store it as <state>/choices.json, the file `apply` reads by default.
 */
async function cmdChoices(args) {
  const src = args.flags.import;
  const t = translator(pickLang(args.flags, null));
  if (!src || src === true) {
    err(t('cli.choices_usage'));
    process.exitCode = 2;
    return null;
  }
  try {
    const { validateChoices } = await import('./lib/console.mjs');
    const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(expandHome(String(src))), 'utf8');
    let doc;
    try {
      doc = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(t('cli.choices_bad_json', { detail: e.message }));
    }
    const choices = validateChoices(doc);
    // ids that no recipe in the catalog (or in the --add / remembered extra-recipes file) answers to: `apply` would skip them
    const catalog = loadCatalog();
    const addFile = args.flags.add && args.flags.add !== true ? resolveExtraFile(args.flags.add) : rememberedExtraFile(stateDir());
    addExtraRecipes(catalog, addFile ? readExtraRecipes(addFile) : null);
    const known = new Set(catalog.recipes.map((r) => r.id));
    const unknown = [...new Set(choices.selected.map((s) => s.id).filter((id) => !known.has(id)))];
    const file = path.join(ensureDir(stateDir()), 'choices.json');
    writeJsonAtomic(file, choices);
    if (unknown.length) err(t('cli.choices_unknown', { ids: unknown.join(', ') }));
    const summary = { ok: true, file, selected: choices.selected.length, discuss: choices.discuss.length, notes: choices.notes.length > 0, ...(unknown.length ? { unknown } : {}) };
    out(JSON.stringify(summary));
    return summary;
  } catch (e) {
    err(t('cli.choices_failed', { detail: e.message }));
    process.exitCode = 1;
    return null;
  }
}

// ---------------------------------------------------------------- paths
/**
 * `kaizen paths`: where Kaizen keeps its files for this run (KAIZEN_STATE_DIR / CLAUDE_CONFIG_DIR respected), as one
 * JSON object. Skills and agents take every file location from here instead of assuming ~/.claude/kaizen.
 */
function cmdPaths() {
  const state = path.resolve(stateDir()); // KAIZEN_STATE_DIR / CLAUDE_CONFIG_DIR may be relative: callers run from other folders
  const at = (...p) => path.join(state, ...p);
  const report = {
    stateDir: state,
    configDir: path.resolve(configDir()),
    measureMd: at('measure.md'),
    measureJson: at('measure.json'),
    measurePreviousMd: at('measure.previous.md'),
    recommendations: at('recommendations.json'),
    choices: at('choices.json'),
    choicesImport: at('choices.import.json'),
    extraRecipes: at('extra-recipes.json'),
    drafts: at('drafts'),
    hooks: at('hooks'),
    applied: at('applied'),
    consoleHtml: at('console.html'),
    config: at('config.json'),
  };
  out(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------- apply --from-batch
/**
 * `apply --from-batch ID [--recipe a,b]`: re-apply recipes of a journaled batch with the scope and parameters that batch
 * used (drafted rules, skill bodies, chosen modes), e.g. after undoing the batch to drop one recipe. The manifest of the
 * batch is turned into a choices document; `apply` then runs on it like on any choices file, so the dry run, the journal
 * and `undo` behave as usual. The project directory is the one the batch was applied in (unless --project is given),
 * so project-scope settings go back to the same project wherever the command is run from. The choices document lives in
 * a temp folder outside the state dir (nothing is written to the state on a dry run); the caller removes that folder with
 * `dropFromBatchChoices`. Returns the args `apply` should run with.
 */
function applyArgsFromBatch(args) {
  const t = translator(pickLang(args.flags, null));
  const id = args.flags['from-batch'];
  if (!id || id === true) throw new UserError(t('err.from_batch_no_id'));
  if (args._[1]) throw new UserError(t('err.from_batch_with_file'));
  const manifestFile = path.join(stateDir(), 'applied', String(id), 'manifest.json');
  const manifest = readJsonSafe(manifestFile);
  if (!manifest || !Array.isArray(manifest.recipes)) throw new UserError(t('err.from_batch_no_manifest', { file: manifestFile }));
  const want = args.flags.recipe && args.flags.recipe !== true ? String(args.flags.recipe).split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (want) {
    const missing = want.filter((r) => !manifest.recipes.some((x) => x.id === r));
    if (missing.length) throw new UserError(t('err.from_batch_no_recipe', { id, missing: missing.join(', '), have: manifest.recipes.map((x) => x.id).join(', ') }));
  }
  const picked = manifest.recipes.filter((r) => (want ? want.includes(r.id) : r.advice || (Array.isArray(r.actions) && r.actions.length)));
  const choices = {
    version: 1,
    source: 'cli',
    submittedAt: new Date().toISOString(),
    lang: manifest.lang || 'en',
    selected: picked.map((r) => ({ id: r.id, scope: r.scope || 'user', params: r.params && typeof r.params === 'object' ? r.params : {} })),
    discuss: [],
    notes: '',
  };
  // The batch's project folder is reused as is; a folder that is gone is an error, not something to recreate (the writer would mkdir it).
  // Only a batch with project-scope recipes needs that folder.
  const needsProject = choices.selected.some((s) => s.scope === 'project');
  if (needsProject && !args.flags.project && typeof manifest.projectDir === 'string' && manifest.projectDir && !fs.existsSync(manifest.projectDir)) {
    throw new UserError(t('err.from_batch_project_gone', { id, dir: manifest.projectDir }));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-from-batch-'));
  const file = path.join(dir, 'choices.json');
  const flags = { ...args.flags };
  const extraFile = customRecipesFromBatch(picked, args.flags, id, dir, t);
  if (extraFile) flags.add = extraFile;
  writeJsonAtomic(file, choices);
  delete flags['from-batch'];
  delete flags.recipe;
  if (!flags.project && typeof manifest.projectDir === 'string' && manifest.projectDir) flags.project = manifest.projectDir;
  return { _: [args._[0], file], flags };
}

/**
 * The custom.* recipes a re-applied batch carries (their text sits in the recipe's actions, not in its parameters). A batch
 * of this version saved each recipe it applied (`recipe` in the manifest): those are written to an extra-recipes file in the
 * temp folder and win over any draft, so the batch's own text comes back. A batch of an older version saved only a digest:
 * the current draft (--add FILE, or the file recommend --add remembered) is the only source then. A recipe it no longer
 * has stops the run before anything is written; one whose digest differs (or that has none) is applied with a warning on
 * stderr. Returns the temp extra-recipes file to pass as --add, or null when nothing needs one.
 */
function customRecipesFromBatch(picked, flags, id, dir, t) {
  const custom = picked.filter((r) => /^custom\./.test(r.id));
  if (!custom.length || flags.add === true) return null; // a bare --add is reported by apply itself
  const stored = custom.filter((r) => r.recipe && typeof r.recipe === 'object' && r.recipe.id === r.id);
  const legacy = custom.filter((r) => !stored.includes(r));
  let current = null;
  if (flags.add && flags.add !== true) {
    current = readExtraRecipes(resolveExtraFile(flags.add));
    if (!current) throw new UserError(t('err.add_unreadable', { file: flags.add }));
  } else {
    const remembered = rememberedExtraFile(stateDir());
    current = remembered ? readExtraRecipes(remembered) : null;
  }
  const draft = current && Array.isArray(current.recipes) ? current.recipes : [];
  const gone = legacy.filter((r) => !draft.some((x) => x && x.id === r.id));
  if (gone.length) throw new UserError(t('err.from_batch_custom_gone', { id, ids: gone.map((r) => r.id).join(', ') }));
  const differs = legacy.filter((r) => !r.digest || recipeDigest(draft.find((x) => x && x.id === r.id)) !== r.digest);
  if (differs.length) process.stderr.write(t('cli.from_batch_custom_draft', { id, ids: differs.map((r) => r.id).join(', ') }) + '\n');
  if (!stored.length) return null; // only drafts: cmdApply loads them the way it always does
  const recipes = [...stored.map((r) => r.recipe), ...draft.filter((x) => x && !stored.some((r) => r.id === x.id))];
  const file = path.join(dir, 'extra-recipes.json');
  writeJsonAtomic(file, { recipes });
  return file;
}

/** Removes the temp folder `applyArgsFromBatch` made for the choices document. */
function dropFromBatchChoices(applyArgs) {
  try {
    fs.rmSync(path.dirname(applyArgs._[1]), { recursive: true, force: true });
  } catch {
    /* a temp folder left behind is harmless */
  }
}

// ---------------------------------------------------------------- status / doctor
function cmdStatus() {
  const state = stateDir();
  const last = readJsonSafe(path.join(state, 'last-measure.json'));
  const rec = readJsonSafe(path.join(state, 'recommendations.json'));
  const journalDir = path.join(state, 'applied');
  const applied = exists(journalDir) ? fs.readdirSync(journalDir).map((d) => ({ id: d, ...(readJsonSafe(path.join(journalDir, d, 'manifest.json')) || {}) })) : [];
  const status = {
    kitVersion: VERSION,
    stateDir: state,
    lang: pickLang({}, null),
    lastMeasure: last,
    recommendations: rec ? { generatedAt: rec.generatedAt, count: rec.recommendations.length, high: rec.recommendations.filter((r) => r.impact === 'high').length } : null,
    applied: applied.map((a) => ({ id: a.id, at: a.at, recipes: (a.recipes || []).map((r) => r.id), undone: !!a.undone, ...(a.partiallyUndone && !a.undone ? { partiallyUndone: true } : {}) })),
    config: readConfig(),
  };
  out(JSON.stringify(status, null, 2));
  return status;
}

function cmdDoctor() {
  const cfg = configDir();
  const pd = projectsDir(cfg);
  let projects = 0;
  let files = 0;
  let bytes = 0;
  if (exists(pd)) {
    for (const p of fs.readdirSync(pd, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      projects++;
      for (const f of fs.readdirSync(path.join(pd, p.name))) {
        if (f.endsWith('.jsonl')) {
          files++;
          try {
            bytes += fs.statSync(path.join(pd, p.name, f)).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  const report = {
    kitVersion: VERSION,
    kitRoot: kitRoot(),
    platform: platformSummary(),
    claudeVersion: claudeVersion(),
    configDir: cfg,
    configDirExists: exists(cfg),
    stateDir: stateDir(),
    transcripts: { projects, files, mb: Math.round(bytes / 1e6) },
    insightsData: exists(usageDataDir(cfg)),
    settingsJson: exists(path.join(cfg, 'settings.json')),
    catalogProblems: validateCatalog(loadCatalog()),
  };
  out(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------- selfcheck / docs
function cmdSelfcheck() {
  const problems = validateCatalog(loadCatalog());
  // locale parity
  const en = JSON.parse(fs.readFileSync(path.join(kitRoot(), 'locales', 'en.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const enKeys = new Set(flat(en));
  for (const l of SUPPORTED) {
    if (l === 'en') continue;
    const other = JSON.parse(fs.readFileSync(path.join(kitRoot(), 'locales', `${l}.json`), 'utf8'));
    const keys = new Set(flat(other));
    for (const k of enKeys) if (!keys.has(k)) problems.push(`locale ${l}: missing key ${k}`);
    for (const k of keys) if (!enKeys.has(k)) problems.push(`locale ${l}: extra key ${k}`);
  }
  // plugin manifest sanity
  const manifest = readJsonSafe(path.join(kitRoot(), '.claude-plugin', 'plugin.json'));
  if (!manifest) problems.push('.claude-plugin/plugin.json missing or invalid');
  else if (manifest.version !== VERSION) problems.push(`plugin.json version ${manifest.version} != package.json ${VERSION}`);
  const market = readJsonSafe(path.join(kitRoot(), '.claude-plugin', 'marketplace.json'));
  if (!market) problems.push('.claude-plugin/marketplace.json missing or invalid');
  // skills have frontmatter
  const skillsDir = path.join(kitRoot(), 'skills');
  if (exists(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir)) {
      const f = path.join(skillsDir, d, 'SKILL.md');
      if (!exists(f)) {
        problems.push(`skills/${d}: SKILL.md missing`);
        continue;
      }
      const text = fs.readFileSync(f, 'utf8');
      if (!/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\r?\n---/.test(text)) problems.push(`skills/${d}: frontmatter needs name and description`);
    }
  }
  // hook templates parse
  const tdir = path.join(kitRoot(), 'recipes', 'templates', 'hooks');
  if (exists(tdir)) {
    for (const f of fs.readdirSync(tdir)) {
      if (!f.endsWith('.mjs')) continue;
      try {
        new Function(fs.readFileSync(path.join(tdir, f), 'utf8').replace(/^#!.*\n/, '').replace(/\bimport\s[^;]+;/g, '').replace(/\bexport\s+/g, ''));
      } catch (e) {
        problems.push(`template hooks/${f}: ${e.message}`);
      }
    }
  }
  if (problems.length) {
    for (const p of problems) err(`✗ ${p}`);
    process.exitCode = 1;
  } else {
    out('selfcheck: ok');
  }
  return problems;
}

function cmdDocs() {
  const catalog = loadCatalog();
  const lines = ['# Recipe catalog', '', `Generated from \`recipes/catalog.json\` (${catalog.recipes.length} recipes). Do not edit by hand; run \`node scripts/kaizen.mjs docs\`.`, ''];
  const byCat = {};
  for (const r of catalog.recipes) (byCat[r.category] ||= []).push(r);
  for (const [cat, list] of Object.entries(byCat)) {
    lines.push(`## ${cat}`, '');
    for (const r of list) {
      lines.push(`### \`${r.id}\` — ${r.title.en}`, '');
      lines.push(`*${r.title.ru}*`, '');
      lines.push(`- Impact: **${r.impact}**, risk: ${r.risk || 'low'}, scope: ${(Array.isArray(r.scope) ? r.scope : [r.scope || 'user']).join(' / ')}`);
      lines.push(`- Why: ${r.why.en}`);
      lines.push(`- Trigger: \`${JSON.stringify(r.when)}\``);
      if (r.actions && r.actions.length) lines.push(`- Actions: ${r.actions.map((a) => a.type + (a.event ? ` ${a.event}` : '') + (a.target ? ` → ${a.target}` : '') + (a.path ? ` ${a.path}` : '')).join('; ')}`);
      else lines.push('- Actions: advice only (Claude discusses it with you)');
      if (r.source) lines.push(`- Inspired by: ${r.source}`);
      lines.push('');
    }
  }
  lines.push('## Metrics recipes can test', '');
  lines.push('| Metric | Meaning |', '|---|---|');
  for (const [k, v] of Object.entries(METRIC_DOCS)) lines.push(`| \`${k}\` | ${v} |`);
  lines.push('');
  const file = path.join(kitRoot(), 'docs', 'recipes.md');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  out(`wrote ${file}`);
}

// ---------------------------------------------------------------- verify
/** The `.mjs` script paths a hook / status line command runs (quoted or bare). */
function commandScripts(command) {
  const found = new Set();
  for (const m of String(command).matchAll(/"([^"]+\.mjs)"|'([^']+\.mjs)'|(\S+\.mjs)/g)) found.add(m[1] || m[2] || m[3]);
  return [...found];
}

/**
 * A predicate that tells whether a script path belongs to Kaizen, wherever the state directory is (KAIZEN_STATE_DIR can
 * point anywhere): anything inside the current state dir, a file the journal recorded (hook scripts, status line), or the
 * default `.../kaizen/hooks|statusline` layout.
 */
function kaizenScriptMatcher(state) {
  const norm = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const root = `${norm(path.resolve(state)).replace(/\/+$/, '')}/`;
  const journaled = new Set();
  const dir = path.join(state, 'applied');
  if (exists(dir)) {
    for (const d of fs.readdirSync(dir)) {
      const man = readJsonSafe(path.join(dir, d, 'manifest.json'));
      for (const r of (man && man.recipes) || []) {
        for (const a of r.actions || []) {
          if (a.type === 'file' && typeof a.file === 'string') journaled.add(norm(a.file));
          if (a.type === 'settings.hook' && typeof a.identity === 'string') for (const s of commandScripts(a.identity.split('|').slice(1).join('|'))) journaled.add(norm(s));
        }
      }
    }
  }
  return (script) => {
    const n = norm(script);
    return n.startsWith(root) || journaled.has(n) || /kaizen\/(hooks|statusline)/.test(n);
  };
}

function cmdVerify(flags) {
  const state = stateDir();
  let measure = null;
  try {
    measure = loadMeasure();
  } catch {
    /* optional */
  }
  const t = translator(pickLang(flags, measure));
  const checks = [];
  const add = (ok, text, extra = {}) => checks.push({ ok, text, ...extra });
  const run = (file, args, input) => spawnSync(process.execPath, [file, ...args], { input, encoding: 'utf8', timeout: 20000 });

  // 1. hook scripts installed by Kaizen
  const hooksDir = path.join(state, 'hooks');
  const hookFiles = exists(hooksDir) ? fs.readdirSync(hooksDir).filter((f) => f.endsWith('.mjs')) : [];
  for (const f of hookFiles) {
    const r = run(path.join(hooksDir, f), ['--selftest']);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const failLine = out.split(/\r?\n/).find((l) => /^FAIL/.test(l));
    if (r.status === 0 && !failLine) add(true, t('verify.hook_ok', { name: f }));
    else add(false, t('verify.hook_fail', { name: f, detail: failLine || (r.error ? r.error.message : `exit ${r.status}`) }));
  }
  // 2. status line script
  const statusline = path.join(state, 'statusline.mjs');
  if (exists(statusline)) {
    const r = run(statusline, [], JSON.stringify({ model: { display_name: 'Kaizen check' }, context_window: { used_percentage: 42 } }));
    const line = (r.stdout || '').trim().split(/\r?\n/)[0] || '';
    if (r.status === 0 && line.includes('Kaizen check')) add(true, t('verify.statusline_ok', { line: line.replace(/\x1b\[[0-9;]*m/g, '') }));
    else add(false, t('verify.statusline_fail', { detail: (r.stderr || `exit ${r.status}`).trim().slice(0, 160) }));
  }
  // 3. settings files parse and reference existing hook files
  const projectDir = flags.project ? path.resolve(expandHome(String(flags.project))) : process.env.CLAUDE_PROJECT_DIR || null;
  const isKaizenScript = kaizenScriptMatcher(state);
  for (const { file } of settingsFiles(projectDir)) {
    if (!exists(file)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cmds = [];
      for (const groups of Object.values(s.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) if (typeof h.command === 'string') cmds.push(h.command);
      if (s.statusLine && typeof s.statusLine.command === 'string') cmds.push(s.statusLine.command);
      const ours = cmds.map((c) => ({ c, scripts: commandScripts(c).filter(isKaizenScript) })).filter((x) => x.scripts.length);
      add(true, t('verify.settings_ok', { file, hooks: ours.length }));
      for (const { c, scripts } of ours) {
        for (const script of scripts) if (!exists(script)) add(false, t('verify.hook_missing', { file, path: script }));
        // the interpreter is pinned by absolute path too; a node that moved (version manager, upgrade) breaks every hook
        const exe = c.match(/^\s*"([^"]+)"/) || c.match(/^\s*(\S+)/);
        if (exe && path.isAbsolute(exe[1]) && !exists(exe[1])) add(false, t('verify.hook_missing', { file, path: exe[1] }));
      }
    } catch (err) {
      add(false, t('verify.settings_fail', { file, detail: err.message.slice(0, 120) }));
    }
  }
  // 4. CLAUDE.md markers balanced
  const mdFiles = [path.join(configDir(), 'CLAUDE.md'), projectDir ? path.join(projectDir, 'CLAUDE.md') : null].filter((f) => f && exists(f));
  for (const file of mdFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const start = (text.match(/<!-- kaizen:start /g) || []).length;
    const end = (text.match(/<!-- kaizen:end /g) || []).length;
    if (!start && !end) continue;
    if (start === end) add(true, t('verify.claude_md_ok', { file, n: start }));
    else add(false, t('verify.claude_md_fail', { file, start, end }));
  }
  // 5. journal
  const last = readJsonSafe(path.join(state, 'last-apply.json'));
  if (last) {
    const man = readJsonSafe(path.join(state, 'applied', last.id, 'manifest.json'));
    add(true, t('verify.journal', { id: last.id, recipes: (last.recipes || []).join(', '), undone: man && man.undone ? ' — undone' : '' }), { info: true });
  }
  const real = checks.filter((c) => !c.info);
  const failed = real.filter((c) => !c.ok).length;
  if (flags.json) {
    out(JSON.stringify({ ok: failed === 0, checks }, null, 2));
  } else {
    out(t('verify.header'));
    if (!checks.length) out(`  ${t('verify.nothing')}`);
    for (const c of checks) out(`  ${c.info ? '·' : c.ok ? '✓' : '✗'} ${c.text}`);
    out(failed ? t('verify.summary_fail', { failed, n: real.length }) : t('verify.summary_ok', { n: real.length }));
  }
  if (failed) process.exitCode = 1;
  return { ok: failed === 0, checks };
}

// ---------------------------------------------------------------- nudge (SessionStart hook)
function cmdNudge() {
  // Must be fast and silent unless there is something to say. Never throws.
  try {
    const state = stateDir();
    const cfg = readConfig();
    if (cfg.nudge === false) return;
    const last = readJsonSafe(path.join(state, 'last-measure.json'));
    const seen = readJsonSafe(path.join(state, 'nudge-seen.json')) || {};
    const rec = readJsonSafe(path.join(state, 'recommendations.json'));
    const weekMs = 7 * 86400000;
    const stale = !last || Date.now() - Date.parse(last.at) > (cfg.remeasureDays || 7) * 86400000;
    if (stale && !seen.staleShownAt || (stale && Date.now() - Date.parse(seen.staleShownAt || 0) > weekMs)) {
      writeJsonAtomic(path.join(state, 'nudge-seen.json'), { ...seen, staleShownAt: new Date().toISOString() });
      const lang = cfg.lang || (rec && rec.lang) || 'en';
      const msg = lang === 'ru' ? 'Kaizen: измерение устарело (старше недели). Запустите /kaizen:start, чтобы обновить рекомендации.' : 'Kaizen: the last measurement is over a week old. Run /kaizen:start to refresh recommendations.';
      out(JSON.stringify({ systemMessage: msg }));
      return;
    }
    if (rec && rec.generatedAt !== seen.recommendationsAt) {
      // recipes the user already applied are not "new", even though recommendations.json is only rewritten by `recommend`
      const applied = appliedIds(rememberedExtraFile(state));
      const high = rec.recommendations.filter((r) => r.impact === 'high' && !applied.has(r.id)).length;
      writeJsonAtomic(path.join(state, 'nudge-seen.json'), { ...seen, recommendationsAt: rec.generatedAt });
      if (high > 0) {
        const t = translator(rec.lang || 'en');
        out(JSON.stringify({ systemMessage: t('cli.nudge', { n: high }) }));
      }
    }
  } catch {
    /* silent by design */
  }
}

function help(flags = {}) {
  const t = translator(pickLang(flags, null));
  out(`claude-kaizen ${VERSION}

Usage: node scripts/kaizen.mjs <command> [options]

  measure    Scan local Claude Code data and write measure.json + measure.md
             --days N (default 30) | --all   --project DIR   --lang en|ru   --no-cache   --json   --quiet
  recommend  Evaluate the recipe catalog against the measurement
             --lang en|ru   --top N   --json   --add FILE (extra recipes; remembered for apply)
             --all lists every recipe and writes recommendations.all.json, leaving recommendations.json alone
  console    Interactive selection UI
             --mode local|render   --port N   --no-open   --out FILE   --lang en|ru
  choices    Store a choices document as choices.json (what the console submits)
             --import FILE|-   (JSON from a file or stdin; prints {ok,file,selected,discuss,notes})
  apply      Apply chosen recipes (choices.json by default)
             [FILE | --recipe id,id | --from-batch ID [--recipe id,id]]   --dry-run   --force   --scope user|project   --project DIR
             --param recipe.name=value   --param-file recipe.name=PATH (file content, multi-line, becomes the value)
             --add FILE (extra recipes, e.g. custom.*; defaults to the file recorded by recommend --add)
             --from-batch ID re-applies a journaled batch with the scope and parameters it was applied with
               (after "undo ID", to keep some of its recipes: --from-batch ID --recipe a,b)
               custom.* recipes come back with the text the batch applied (a batch of an older version did not save it:
               the current --add draft is used, with a warning, and a recipe it no longer has stops the run)
               it reuses the batch's project folder (--project DIR overrides it; an existing folder is required otherwise)
  undo       Revert an applied batch   [ID | --last | --all]   --dry-run
             --force also reverts what you edited after apply (kept entries otherwise stay undoable)
  paths      Print the state directory and the files in it as JSON (KAIZEN_STATE_DIR respected)
  status     Show state: last measurement, recommendations, applied batches
  verify     Self-test installed hooks and status line, parse touched settings, check CLAUDE.md markers
             --project DIR   --json
  doctor     Environment diagnostics (no transcript content)
  selfcheck  Validate catalog, locales, templates, manifests (CI)
  docs       Regenerate docs/recipes.md from the catalog
  nudge      SessionStart hook: one-line reminder when a re-measure is due

${t('cli.help_note')}

State lives in ${stateDir()} (override with KAIZEN_STATE_DIR).`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  cliFlags = args.flags;
  const cmd = args._[0];
  if (args.flags.version || cmd === 'version') {
    out(VERSION);
    return;
  }
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return help(args.flags);
    case 'measure':
      return cmdMeasure(args.flags);
    case 'recommend':
      return cmdRecommend(args.flags);
    case 'console': {
      const { cmdConsole } = await import('./lib/console.mjs');
      return cmdConsole(args.flags, { loadMeasure, pickLang, stateDir, readJsonSafe });
    }
    case 'choices':
      return cmdChoices(args);
    case 'apply': {
      const { cmdApply } = await import('./lib/apply.mjs');
      if (args.flags['from-batch'] === undefined) return cmdApply(args, { loadMeasure, pickLang });
      const fromBatch = applyArgsFromBatch(args);
      try {
        return await cmdApply(fromBatch, { loadMeasure, pickLang });
      } finally {
        dropFromBatchChoices(fromBatch);
      }
    }
    case 'undo': {
      const { cmdUndo } = await import('./lib/apply.mjs');
      let measure = null;
      try {
        measure = loadMeasure();
      } catch {
        /* language falls back to config / en */
      }
      return cmdUndo(args, { pickLang: (flags) => pickLang(flags, measure) });
    }
    case 'paths':
      return cmdPaths();
    case 'status':
      return cmdStatus();
    case 'verify':
      return cmdVerify(args.flags);
    case 'doctor':
      return cmdDoctor();
    case 'selfcheck':
      return cmdSelfcheck();
    case 'docs':
      return cmdDocs();
    case 'nudge':
      return cmdNudge();
    default:
      err(translator('en')('cli.unknown_command', { cmd }));
      process.exitCode = 2;
  }
}

/**
 * True when this file is the process entry point. The module URL is compared as a file path (not as the percent-encoded
 * `pathname` of the URL, which breaks for spaces and non-ASCII characters) and both sides are resolved through the
 * file system, so an npm bin symlink matches too.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e) => {
    // A mistake of the user (unknown id, bad flag, a step run out of order) is one clean line; the stack is for KAIZEN_DEBUG=1
    if (process.env.KAIZEN_DEBUG === '1') err(`kaizen: ${e && e.stack ? e.stack : e}`);
    else {
      err(`kaizen: ${e && e.message ? e.message : e}`);
      if (!(e && e.expected)) {
        try {
          err(translator(pickLang({}, null))('err.debug_hint'));
        } catch {
          /* the hint is a courtesy */
        }
      }
    }
    process.exitCode = 1;
  });
}
