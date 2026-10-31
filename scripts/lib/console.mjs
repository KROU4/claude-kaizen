// The Kaizen console: renders console/index.html with the recommendations and
// either serves it locally (writing choices.json on submit) or writes the HTML
// for publishing as a claude.ai artifact / static page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureDir, kitRoot, readJsonSafe, stateDir, writeJsonAtomic } from './paths.mjs';
import { loadLocale, translator } from './i18n.mjs';
import { openInBrowser } from './platform.mjs';

const PLACEHOLDER = '/*__KAIZEN_DATA__*/null/*__END__*/';

function flattenConsoleStrings(lang) {
  const c = loadLocale(lang).console || {};
  const en = loadLocale('en').console || {};
  const out = {};
  const src = { ...en, ...c };
  for (const [k, v] of Object.entries(src)) {
    if (k === 'impact' || k === 'risk') for (const [kk, vv] of Object.entries({ ...(en[k] || {}), ...(v || {}) })) out[`${k}_${kk}`] = vv;
    else if (k === 'categories') for (const [kk, vv] of Object.entries({ ...(en.categories || {}), ...(v || {}) })) out[`cat_${kk}`] = vv;
    else out[k] = v;
  }
  return out;
}

/** Build the data object injected into the page. */
export function buildConsoleData({ recommendations, lang, mode, submitUrl, measure }) {
  return {
    lang,
    mode,
    submitUrl,
    generatedAt: new Date().toISOString(),
    stats: {
      sessions: measure ? measure.totals.sessions : recommendations.sessions || 0,
      days: measure ? measure.windowDays : recommendations.windowDays || 0,
      prompts: measure ? measure.totals.userMessages : 0,
      recommendations: recommendations.recommendations.length,
    },
    i18n: flattenConsoleStrings(lang),
    recommendations: recommendations.recommendations,
  };
}

export function renderConsole(data) {
  const template = fs.readFileSync(path.join(kitRoot(), 'console', 'index.html'), 'utf8');
  if (!template.includes(PLACEHOLDER)) throw new Error('console/index.html: data placeholder missing');
  // </script> inside JSON strings would end the script block early
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  return template.replace(PLACEHOLDER, json);
}

export function validateChoices(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('choices must be an object');
  if (!Array.isArray(obj.selected)) throw new Error('choices.selected must be an array');
  for (const s of obj.selected) {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9.-]+$/.test(s.id)) throw new Error(`bad recipe id in choices: ${JSON.stringify(s && s.id)}`);
    if (s.scope && !['user', 'project', 'local'].includes(s.scope)) throw new Error(`bad scope for ${s.id}`);
    if (s.params && typeof s.params !== 'object') throw new Error(`params for ${s.id} must be an object`);
  }
  if (obj.notes && typeof obj.notes !== 'string') throw new Error('notes must be a string');
  if (obj.notes && obj.notes.length > 20000) obj.notes = obj.notes.slice(0, 20000);
  return { version: 1, submittedAt: obj.submittedAt || new Date().toISOString(), lang: obj.lang || 'en', selected: obj.selected, discuss: Array.isArray(obj.discuss) ? obj.discuss.filter((x) => typeof x === 'string') : [], notes: obj.notes || '' };
}

export async function cmdConsole(flags, { loadMeasure, pickLang }) {
  const state = ensureDir(stateDir());
  const rec = readJsonSafe(path.join(state, 'recommendations.json'));
  if (!rec) throw new Error(`No recommendations at ${path.join(state, 'recommendations.json')}. Run \`kaizen recommend\` first.`);
  let measure = null;
  try {
    measure = loadMeasure();
  } catch {
    /* optional */
  }
  const lang = pickLang(flags, measure);
  const t = translator(lang);
  const mode = flags.mode || 'local';
  const transport = flags.transport || (mode === 'render' ? 'artifact' : 'local');

  if (mode === 'render') {
    const data = buildConsoleData({ recommendations: rec, lang, mode: transport, submitUrl: null, measure });
    const html = renderConsole(data);
    const out = flags.out ? path.resolve(String(flags.out)) : path.join(state, 'console.html');
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, html, 'utf8');
    process.stdout.write(out + '\n');
    return { file: out };
  }

  // ---- local server mode
  const token = crypto.randomBytes(8).toString('hex');
  const submitPath = `/submit/${token}`;
  const data = buildConsoleData({ recommendations: rec, lang, mode: 'local', submitUrl: submitPath, measure });
  const html = renderConsole(data);
  const choicesFile = path.join(state, 'choices.json');
  const timeoutMin = Number(flags.timeout || 30);

  return new Promise((resolve) => {
    let done = false;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'POST' && req.url === submitPath) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', () => {
          try {
            const choices = validateChoices(JSON.parse(body));
            writeJsonAtomic(choicesFile, choices);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, file: choicesFile }));
            process.stderr.write(t('cli.console_done', { file: choicesFile }) + '\n');
            process.stdout.write(JSON.stringify({ ok: true, file: choicesFile, selected: choices.selected.length, discuss: choices.discuss.length, notes: choices.notes.length > 0 }) + '\n');
            done = true;
            setTimeout(() => {
              server.close();
              resolve({ file: choicesFile, choices });
            }, 400);
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = Number(flags.port || 0);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      process.stderr.write(t('cli.console_url', { url }) + '\n');
      process.stderr.write(t('cli.console_waiting') + '\n');
      if (!flags['no-open'] && !openInBrowser(url)) process.stderr.write(t('cli.console_no_browser') + '\n');
      // print the URL on stdout too so an agent can relay it to the user
      process.stdout.write(JSON.stringify({ url, choicesFile, waiting: true }) + '\n');
    });
    const timer = setTimeout(() => {
      if (done) return;
      process.stderr.write('kaizen console: timed out waiting for choices\n');
      process.exitCode = 3;
      server.close();
      resolve({ file: null, timedOut: true });
    }, timeoutMin * 60000);
    server.on('close', () => clearTimeout(timer));
  });
}
