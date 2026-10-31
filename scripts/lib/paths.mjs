// Path resolution for Claude Code's local data and Kaizen's own state.
// Everything here is pure path arithmetic; nothing reads transcript content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function homeDir() {
  return os.homedir();
}

/** ~/.claude, or $CLAUDE_CONFIG_DIR when the user relocated it. */
export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
}

/** Where Kaizen keeps measurements, choices, backups and caches. */
export function stateDir() {
  return process.env.KAIZEN_STATE_DIR || path.join(configDir(), 'kaizen');
}

export function projectsDir(cfg = configDir()) {
  return path.join(cfg, 'projects');
}

export function usageDataDir(cfg = configDir()) {
  return path.join(cfg, 'usage-data');
}

/** Root of the kit checkout / plugin install (two levels above scripts/lib). */
export function kitRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2));
  return p;
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Claude Code stores each project's transcripts under projects/<cwd with every non-alphanumeric char replaced by '-'>. */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJsonSafe(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

/** Candidate settings files in precedence order (lowest to highest), with scope labels. */
export function settingsFiles(projectDir, cfg = configDir()) {
  const out = [{ scope: 'user', file: path.join(cfg, 'settings.json') }];
  if (projectDir) {
    out.push({ scope: 'project', file: path.join(projectDir, '.claude', 'settings.json') });
    out.push({ scope: 'local', file: path.join(projectDir, '.claude', 'settings.local.json') });
  }
  return out;
}
