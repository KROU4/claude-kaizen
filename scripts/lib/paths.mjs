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

/**
 * Claude Code's global config file (account, user-scope MCP servers, per-project state).
 * Without CLAUDE_CONFIG_DIR it is ~/.claude.json; with it, $CLAUDE_CONFIG_DIR/.claude.json (not the default profile's file).
 * An old <config dir>/.config.json wins only as in Claude Code itself: a regular file that is non-empty, or writable
 * while .claude.json does not exist. A leftover empty file (or a directory) of that name is ignored.
 */
export function globalConfigPath() {
  const legacy = path.join(configDir(), '.config.json');
  const current = path.join(process.env.CLAUDE_CONFIG_DIR || homeDir(), '.claude.json');
  try {
    const st = fs.statSync(legacy);
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) !== 0 && !exists(current)))) return legacy;
  } catch {
    // no legacy file
  }
  return current;
}

/**
 * The key of the global config's `projects` map that stands for a directory. Claude Code keys projects with forward
 * slashes on Windows, so the native path (backslashes, trailing slash, other drive-letter case) is compared normalised;
 * an exact key always wins. `accept` narrows the candidates (for example to entries that hold MCP servers).
 */
export function projectConfigKey(projects, projectDir, accept = () => true) {
  if (!projects || typeof projects !== 'object' || !projectDir) return null;
  const keys = Object.keys(projects).filter((k) => accept(projects[k], k));
  const norm = (p) => {
    const s = toPosix(p).replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const want = norm(projectDir);
  return keys.find((k) => k === projectDir) || keys.find((k) => k === toPosix(projectDir)) || keys.find((k) => norm(k) === want) || null;
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

/** System directory with the organisation's managed settings (KAIZEN_MANAGED_SETTINGS_DIR overrides it, for tests). */
export function managedSettingsDir() {
  if (process.env.KAIZEN_MANAGED_SETTINGS_DIR) return process.env.KAIZEN_MANAGED_SETTINGS_DIR;
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  return '/etc/claude-code';
}

/**
 * Managed settings files that exist, in merge order (later wins): managed-settings.json, then managed-settings.d/*.json
 * alphabetically. READ-ONLY: these are never write targets, so they are kept out of settingsFiles().
 */
export function managedSettingsFiles() {
  const dir = managedSettingsDir();
  const out = [];
  const main = path.join(dir, 'managed-settings.json');
  if (exists(main)) out.push({ scope: 'managed', file: main, readOnly: true });
  try {
    const dropIns = fs
      .readdirSync(path.join(dir, 'managed-settings.d'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
    for (const f of dropIns) out.push({ scope: 'managed', file: path.join(dir, 'managed-settings.d', f), readOnly: true });
  } catch {
    // no drop-in directory
  }
  return out;
}
