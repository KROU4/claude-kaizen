// Kaizen hook: format-on-edit
// What it does: after Claude edits a file, formats that one file with the project's own tooling: prettier (only
//   when installed in a local node_modules, or when the project has a prettier config and npx exists), ruff format (no lint autofixes that could delete code) or
//   black for Python, gofmt, rustfmt. When a language-specific formatter is chosen, it also runs dotnet format (C#),
//   rubocop -a (Ruby), php-cs-fixer, swiftformat, ktlint -F (Kotlin), google-java-format -i, terraform fmt and
//   shfmt -w, each only if the tool is on PATH. Silent, never blocks; skips missing files, files over 2 MB and unknown types.
// Registered for: PostToolUse, matcher "Edit|Write|MultiEdit".
// Parameters (substituted by Kaizen at install time): formatter (auto|prettier|ruff|black|gofmt|rustfmt|dotnet format|
//   rubocop|php-cs-fixer|swiftformat|ktlint|google-java-format|terraform fmt|shfmt|none),
//   timeoutSec (overall limit per edit, default 20, capped at 25 s: the hook is registered with a 30 s timeout).
// Remove: delete the PostToolUse entry that runs this file from settings.json, or run `kaizen undo`.
// Self-test: node format-on-edit.mjs --selftest
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FORMATTER_RAW = '{{formatter}}';
const TIMEOUT_RAW = '{{timeoutSec}}';
const unset = (v) => typeof v !== 'string' || v.startsWith('{' + '{') || v.trim() === '';
const FORMATTER = unset(FORMATTER_RAW) ? 'auto' : FORMATTER_RAW.trim().toLowerCase();
const TIMEOUT_MS = Math.min(25, Math.max(1, Number(unset(TIMEOUT_RAW) ? 20 : TIMEOUT_RAW) || 20)) * 1000;
const PRETTIER_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'md', 'yaml', 'yml', 'html', 'vue', 'svelte']);
const PRETTIER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.toml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];

function ancestors(dir, stopAt) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (d === stopAt || path.dirname(d) === d) return out;
  }
}

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Formatters that need no project detection: run when chosen explicitly and the binary is on PATH.
const TOOLS = {
  'dotnet format': { bin: 'dotnet', exts: ['cs'], args: (f, stopAt) => dotnetStep(f, stopAt) },
  rubocop: { bin: 'rubocop', exts: ['rb', 'rake'], args: (f) => ['-a', f] },
  'php-cs-fixer': { bin: 'php-cs-fixer', exts: ['php'], args: (f) => ['fix', '--quiet', '--no-interaction', f] },
  swiftformat: { bin: 'swiftformat', exts: ['swift'], args: (f) => ['--quiet', f] },
  ktlint: { bin: 'ktlint', exts: ['kt', 'kts'], args: (f) => ['-F', f] },
  'google-java-format': { bin: 'google-java-format', exts: ['java'], args: (f) => ['-i', f] },
  'terraform fmt': { bin: 'terraform', exts: ['tf', 'tfvars'], args: (f) => ['fmt', f] },
  shfmt: { bin: 'shfmt', exts: ['sh', 'bash'], args: (f) => ['-w', f] },
};

// dotnet format works on a project or solution: the nearest .sln (else .csproj) above the file. It honours --include
// only as a path relative to that project directory, so the step runs there and the file is passed relative to it.
function dotnetStep(file, stopAt) {
  for (const d of ancestors(path.dirname(file), stopAt)) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { /* unreadable directory */ }
    const ws = names.find((n) => n.endsWith('.sln')) || names.find((n) => n.endsWith('.csproj'));
    if (ws) return { args: ['format', path.join(d, ws), '--include', path.relative(d, file)], cwd: d };
  }
  return null;
}

function prettierStep(file, which, stopAt) {
  const dirs = ancestors(path.dirname(file), stopAt);
  for (const d of dirs) {
    const pkg = path.join(d, 'node_modules', 'prettier');
    const shim = path.join(d, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
    if (!fs.existsSync(path.join(pkg, 'package.json')) && !fs.existsSync(shim)) continue;
    try {
      const bin = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).bin;
      const script = path.join(pkg, typeof bin === 'string' ? bin : bin.prettier);
      if (fs.existsSync(script)) return { bin: process.execPath, args: [script, '--write', file] };
    } catch { /* no usable package.json: fall back to the shim */ }
    if (fs.existsSync(shim)) return { bin: shim, args: ['--write', file] };
  }
  const npx = dirs.some((d) => PRETTIER_CONFIGS.some((c) => fs.existsSync(path.join(d, c)))) && which('npx');
  return npx ? { bin: npx, args: ['--no-install', 'prettier', '--write', file] } : null;
}

function pythonSteps(file, which, formatter, stopAt) {
  const pyproject = ancestors(path.dirname(file), stopAt).map((d) => path.join(d, 'pyproject.toml')).find((p) => fs.existsSync(p));
  let mentionsRuff = false;
  try { mentionsRuff = !!pyproject && /ruff/i.test(fs.readFileSync(pyproject, 'utf8')); } catch { /* unreadable */ }
  let ruff = formatter === 'black' ? null : which('ruff');
  let pre = [];
  if (!ruff && formatter !== 'black' && mentionsRuff) {
    ruff = which('python3') || which('python') || which('py');
    pre = ['-m', 'ruff'];
  }
  if (ruff) return [{ bin: ruff, args: [...pre, 'format', file] }];
  const black = formatter !== 'ruff' && which('black');
  return black ? [{ bin: black, args: ['-q', file] }] : [];
}

// Decide which commands to run for a file (pure apart from reading project files); [] means skip.
function plan(file, opts = {}) {
  const formatter = opts.formatter || FORMATTER;
  const which = opts.which || onPath;
  const ext = path.extname(file).slice(1).toLowerCase();
  const kind = PRETTIER_EXT.has(ext) ? 'prettier' : ext === 'py' || ext === 'pyi' ? 'python' : ext === 'go' ? 'go' : ext === 'rs' ? 'rust' : null;
  const tool = TOOLS[formatter];
  if (tool) {
    const bin = tool.exts.includes(ext) && which(tool.bin);
    const r = bin && tool.args(file, opts.stopAt);
    return r ? [Array.isArray(r) ? { bin, args: r } : { bin, ...r }] : [];
  }
  const wants = { prettier: 'prettier', ruff: 'python', black: 'python', gofmt: 'go', rustfmt: 'rust' }[formatter];
  if (!kind || formatter === 'none' || (formatter !== 'auto' && wants !== kind)) return [];
  if (kind === 'prettier') return [prettierStep(file, which, opts.stopAt)].filter(Boolean);
  if (kind === 'python') return pythonSteps(file, which, formatter, opts.stopAt);
  const bin = which(kind === 'go' ? 'gofmt' : 'rustfmt');
  return bin ? [{ bin, args: kind === 'go' ? ['-w', file] : ['--edition', '2021', file] }] : [];
}

function run(step, cwd, deadline) {
  const opts = { cwd: step.cwd || cwd, timeout: Math.max(500, deadline - Date.now()), stdio: 'ignore', windowsHide: true };
  const all = [step.bin, ...step.args];
  if (!/\.(?:cmd|bat)$/i.test(step.bin)) spawnSync(step.bin, step.args, opts);
  else if (!all.some((a) => /["%^&|<>!]/.test(a))) spawnSync(all.map((a) => `"${a}"`).join(' '), { ...opts, shell: true }); // .cmd shims need cmd.exe
}

function format(payload, opts = {}) {
  const raw = payload.tool_input && payload.tool_input.file_path;
  if (typeof raw !== 'string' || !raw) return;
  const file = path.resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), raw);
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
  const deadline = Date.now() + TIMEOUT_MS;
  for (const step of plan(file, opts)) run(step, path.dirname(file), deadline);
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-fmt-'));
  let failed = 0;
  const check = (name, ok, why) => { console.log(ok ? `ok ${name}` : `FAIL ${name} ${why}`); if (!ok) failed++; };
  const mk = (rel, text = '') => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  try {
    mk('proj/node_modules/prettier/package.json', '{"bin":"bin/prettier.cjs"}');
    mk('proj/node_modules/prettier/bin/prettier.cjs', "require('node:fs').writeFileSync(process.argv[3], 'formatted');");
    const js = mk('proj/src/my file.js', 'x');
    const bare = mk('bare/b.js', 'x');
    mk('cfg/.prettierrc', '{}');
    const ts = mk('cfg/c.ts', 'x');
    const py = mk('py/p.py', 'x');
    mk('py2/pyproject.toml', '[tool.ruff]\n');
    const py2 = mk('py2/q.py', 'x');
    const opts = (...names) => ({ stopAt: tmp, formatter: 'auto', which: (n) => (names.includes(n) ? `/bin/${n}` : null) });
    const first = (steps) => JSON.stringify(steps[0] || null);
    const p1 = plan(js, opts());
    check('prettier: local install', p1.length === 1 && p1[0].bin === process.execPath && p1[0].args.includes('--write'), first(p1));
    check('prettier: nothing installed -> skip', plan(bare, opts()).length === 0, 'expected no steps');
    check('prettier: config + npx', plan(ts, opts('npx'))[0]?.args[0] === '--no-install', 'expected npx step');
    check('prettier: config without npx -> skip', plan(ts, opts()).length === 0, 'expected no steps');
    const p5 = plan(py, opts('ruff'));
    check('python: ruff format only, no lint autofix', p5.length === 1 && p5[0].args[0] === 'format' && !JSON.stringify(p5).includes('check'), first(p5));
    check('python: black fallback', plan(py, opts('black'))[0]?.args[0] === '-q', 'expected black');
    check('python: pyproject mentions ruff', plan(py2, opts('python'))[0]?.args.slice(0, 2).join(' ') === '-m ruff', 'expected python -m ruff');
    check('go: gofmt -w', plan(mk('m.go'), opts('gofmt'))[0]?.args[0] === '-w', 'expected gofmt');
    check('rust: rustfmt edition 2021', plan(mk('m.rs'), opts('rustfmt'))[0]?.args.join(' ').startsWith('--edition 2021'), 'expected rustfmt');
    check('unknown extension -> skip', plan(mk('notes.txt'), opts('ruff', 'gofmt', 'npx')).length === 0, 'expected no steps');
    check('formatter=none -> skip', plan(js, { ...opts(), formatter: 'none' }).length === 0, 'expected no steps');
    for (const [name, bin, ext, head] of [['rubocop', 'rubocop', 'rb', '-a'], ['php-cs-fixer', 'php-cs-fixer', 'php', 'fix'], ['swiftformat', 'swiftformat', 'swift', '--quiet'], ['ktlint', 'ktlint', 'kt', '-F'], ['google-java-format', 'google-java-format', 'java', '-i'], ['terraform fmt', 'terraform', 'tf', 'fmt'], ['shfmt', 'shfmt', 'sh', '-w']]) {
      const f = mk(`tools/x.${ext}`);
      const steps = plan(f, { ...opts(bin), formatter: name });
      check(`${name}: runs ${bin} on .${ext}`, steps.length === 1 && steps[0].args[0] === head && steps[0].args.at(-1) === f, first(steps));
      check(`${name}: tool missing -> skip`, plan(f, { ...opts(), formatter: name }).length === 0, 'expected no steps');
      check(`${name}: ignores other extensions`, plan(js, { ...opts(bin), formatter: name }).length === 0, 'expected no steps');
      check(`auto does not run ${name}`, plan(f, opts(bin)).length === 0, 'expected no steps');
    }
    const cs = mk('net/src/A.cs');
    check('dotnet format: no project -> skip', plan(cs, { ...opts('dotnet'), formatter: 'dotnet format' }).length === 0, 'expected no steps');
    mk('net/App.csproj', '<Project/>');
    const dn = plan(cs, { ...opts('dotnet'), formatter: 'dotnet format' });
    check('dotnet format: project found above the file', dn.length === 1 && dn[0].args[0] === 'format' && dn[0].args[1].endsWith('App.csproj') && dn[0].args.at(-1) === path.join('src', 'A.cs') && dn[0].cwd === path.join(tmp, 'net'), first(dn));
    check('timeout is capped below the hook timeout', TIMEOUT_MS <= 25000, String(TIMEOUT_MS));
    check('forced black ignores .js', plan(js, { ...opts('black'), formatter: 'black' }).length === 0, 'expected no steps');
    format({ tool_input: { file_path: path.join(tmp, 'missing.js') } }, { formatter: 'auto' });
    format({ tool_input: { file_path: js }, cwd: tmp }, { formatter: 'auto' });
    check('end-to-end run through a fake local prettier', fs.readFileSync(js, 'utf8') === 'formatted', 'file was not rewritten');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) { try { process.exitCode = selftest(); } catch (e) { console.log('FAIL selftest crashed: ' + e.message); process.exitCode = 1; } return; }
  const chunks = [];
  if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c);
  let payload = {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
    if (v && typeof v === 'object') payload = v;
  } catch { /* empty or invalid input: treat as {} */ }
  format(payload);
}

process.on('uncaughtException', () => process.exit(0));
main().catch(() => {});
