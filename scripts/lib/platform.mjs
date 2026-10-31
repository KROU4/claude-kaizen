// Cross-platform helpers: open a browser, find executables, detect WSL.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Fire-and-forget open of a URL in the default browser. Returns false when no opener exists. */
export function openInBrowser(url) {
  try {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '""', url.replace(/&/g, '^&')];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (isWSL()) {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '""', url.replace(/&/g, '^&')];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).find(Boolean) || null;
}

export function claudeVersion() {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 10000 });
    if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0];
  } catch {
    /* not installed or not on PATH */
  }
  return null;
}

/** Shell-quoted path to the running Node binary, for hook commands that must survive PATH differences. */
export function nodeCommand() {
  const exe = process.execPath;
  return /\s/.test(exe) ? `"${exe}"` : exe;
}

export function platformSummary() {
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    wsl: isWSL(),
    shell: process.env.SHELL || process.env.ComSpec || null,
  };
}
