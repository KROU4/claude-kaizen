#!/usr/bin/env node
// Kaizen CLI — the deterministic half of the kit. Skills and agents call these
// subcommands; humans can too.
//
//   kaizen measure   [--days N|--all] [--project DIR] [--lang en|ru] [--no-cache] [--quiet]
//   kaizen recommend [--lang en|ru] [--top N] [--json] [--all]
//   kaizen console   [--mode local|render] [--port N] [--no-open] [--out FILE] [--lang]
//   kaizen apply     [FILE|--recipe id,id] [--dry-run] [--scope user|project] [--project DIR]
//   kaizen undo      [ID|--last|--all] [--dry-run]
//   kaizen status | doctor | selfcheck | docs | nudge | help | --version
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDir, ensureDir, exists, kitRoot, projectsDir, readJsonSafe, settingsFiles, stateDir, usageDataDir, writeJsonAtomic } from './lib/paths.mjs';
import { scanTranscripts } from './lib/transcripts.mjs';
import { inventory } from './lib/inventory.mjs';
import { readInsights } from './lib/insights.mjs';
import { buildMeasure, METRIC_DOCS } from './lib/metrics.mjs';
import { renderDigest } from './lib/digest.mjs';
import { translator, SUPPORTED } from './lib/i18n.mjs';
import { claudeVersion, platformSummary } from './lib/platform.mjs';
import { loadCatalog, recommend, validateCatalog } from './lib/recipes.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(kitRoot(), 'package.json'), 'utf8')).version;

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args.flags[key] = next;
          i++;
        } else {
          args.flags[key] = true;
        }
      }
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

function pickLang(flags, measure) {
  if (flags.lang && SUPPORTED.includes(flags.lang)) return flags.lang;
  const cfg = readConfig();
  if (cfg.lang && SUPPORTED.includes(cfg.lang)) return cfg.lang;
  if (measure && measure.locale && measure.locale.lang) return measure.locale.lang;
  return 'en';
}

function loadMeasure() {
  const file = path.join(stateDir(), 'measure.json');
  const m = readJsonSafe(file);
  if (!m) throw new Error(`No measurement found at ${file}. Run \`kaizen measure\` first.`);
  return m;
}

function appliedIds() {
  const journalDir = path.join(stateDir(), 'applied');
  const ids = new Set();
  if (!exists(journalDir)) return ids;
  for (const d of fs.readdirSync(journalDir)) {
    const man = readJsonSafe(path.join(journalDir, d, 'manifest.json'));
    if (man && !man.undone) for (const r of man.recipes || []) ids.add(r.id);
  }
  return ids;
}

// ---------------------------------------------------------------- measure
async function cmdMeasure(flags) {
  const quiet = !!flags.quiet;
  const windowDays = flags.all ? 3650 : Number(flags.days || 30);
  const since = new Date(Date.now() - windowDays * 86400000);
  const cfg = configDir();
  const state = ensureDir(stateDir());
  const projectDir = flags.project ? path.resolve(String(flags.project)) : process.env.CLAUDE_PROJECT_DIR || null;
  const t = translator(pickLang(flags, null));
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
  const extra = flags.add ? readJsonSafe(path.resolve(String(flags.add))) : null;
  if (flags.add && !extra) throw new Error(`--add: cannot read ${flags.add}`);
  if (extra && Array.isArray(extra.recipes)) catalog.recipes.push(...extra.recipes);
  const res = recommend(catalog, measure, { lang, applied: appliedIds(), includeAll: !!flags.all });
  if (extra && extra.paramDefaults && typeof extra.paramDefaults === 'object') {
    for (const r of res.recommended) {
      const defaults = extra.paramDefaults[r.id];
      if (!defaults) continue;
      for (const p of r.params) if (defaults[p.name] !== undefined) p.value = defaults[p.name];
    }
  }
  if (extra && typeof extra.profile === 'string') writeJsonAtomic(path.join(stateDir(), 'profile.json'), { generatedAt: new Date().toISOString(), profile: extra.profile });
  const top = flags.top ? Number(flags.top) : 0;
  const list = top ? res.recommended.slice(0, top) : res.recommended;
  const payload = {
    generatedAt: new Date().toISOString(),
    lang,
    measureGeneratedAt: measure.generatedAt,
    windowDays: measure.windowDays,
    sessions: measure.totals.sessions,
    recommendations: list,
    alreadyApplied: res.alreadyApplied,
    notApplicable: res.notApplicable.length,
  };
  writeJsonAtomic(path.join(stateDir(), 'recommendations.json'), payload);
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
    out(`[${r.impact[0].toUpperCase()}] ${r.id} — ${r.title}${r.kind === 'advice' ? ' (advice)' : ''}`);
    out(`    ${r.evidence}`);
    if (r.actionsSummary.length) out(`    → ${r.actionsSummary.join('; ')}`);
  }
  if (res.alreadyApplied.length) {
    out('');
    out(`Already applied: ${res.alreadyApplied.map((a) => a.id).join(', ')}`);
  }
  return payload;
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
    lastMeasure: last,
    recommendations: rec ? { generatedAt: rec.generatedAt, count: rec.recommendations.length, high: rec.recommendations.filter((r) => r.impact === 'high').length } : null,
    applied: applied.map((a) => ({ id: a.id, at: a.at, recipes: (a.recipes || []).map((r) => r.id), undone: !!a.undone })),
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
  const projectDir = flags.project ? path.resolve(String(flags.project)) : process.env.CLAUDE_PROJECT_DIR || null;
  for (const { file } of settingsFiles(projectDir)) {
    if (!exists(file)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cmds = [];
      for (const groups of Object.values(s.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) if (typeof h.command === 'string') cmds.push(h.command);
      const ours = cmds.filter((c) => /kaizen[\\/](hooks|statusline)/i.test(c));
      add(true, t('verify.settings_ok', { file, hooks: ours.length }));
      for (const c of ours) {
        const m = c.match(/"([^"]*kaizen[\\/][^"]*\.mjs)"/i) || c.match(/(\S*kaizen[\\/]\S*\.mjs)/i);
        if (m && !exists(m[1])) add(false, t('verify.hook_missing', { file, path: m[1] }));
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
      const msg = lang === 'ru' ? 'Kaizen: измерение устарело (старше недели). Запустите /kaizen, чтобы обновить рекомендации.' : 'Kaizen: the last measurement is over a week old. Run /kaizen to refresh recommendations.';
      out(JSON.stringify({ systemMessage: msg }));
      return;
    }
    if (rec && rec.generatedAt !== seen.recommendationsAt) {
      const high = rec.recommendations.filter((r) => r.impact === 'high').length;
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

function help() {
  out(`claude-kaizen ${VERSION}

Usage: node scripts/kaizen.mjs <command> [options]

  measure    Scan local Claude Code data and write measure.json + measure.md
             --days N (default 30) | --all   --project DIR   --lang en|ru   --no-cache   --json   --quiet
  recommend  Evaluate the recipe catalog against the measurement
             --lang en|ru   --top N   --json   --all   --add FILE (extra recipes)
  console    Interactive selection UI
             --mode local|render   --port N   --no-open   --out FILE   --lang en|ru
  apply      Apply chosen recipes (choices.json by default)
             [FILE | --recipe id,id]   --dry-run   --scope user|project   --project DIR   --param recipe.name=value
  undo       Revert an applied batch   [ID | --last | --all]   --dry-run
  status     Show state: last measurement, recommendations, applied batches
  verify     Self-test installed hooks and status line, parse touched settings, check CLAUDE.md markers
             --project DIR   --json
  doctor     Environment diagnostics (no transcript content)
  selfcheck  Validate catalog, locales, templates, manifests (CI)
  docs       Regenerate docs/recipes.md from the catalog
  nudge      SessionStart hook: one-line reminder when a re-measure is due

State lives in ${stateDir()} (override with KAIZEN_STATE_DIR).`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.flags.version || cmd === 'version') {
    out(VERSION);
    return;
  }
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return help();
    case 'measure':
      return cmdMeasure(args.flags);
    case 'recommend':
      return cmdRecommend(args.flags);
    case 'console': {
      const { cmdConsole } = await import('./lib/console.mjs');
      return cmdConsole(args.flags, { loadMeasure, pickLang, stateDir, readJsonSafe });
    }
    case 'apply': {
      const { cmdApply } = await import('./lib/apply.mjs');
      return cmdApply(args, { loadMeasure, pickLang });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  main().catch((e) => {
    err(`kaizen: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}
