// Cross-platform helpers: open a browser, find executables, detect WSL.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** Absolute path of an executable found on PATH (honours PATHEXT on Windows), or null. Pure Node, no `which` binary needed. */
export function findOnPath(bin) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Fire-and-forget open of a URL in the default browser. Returns false when no opener exists: spawn() reports a missing
 * executable asynchronously, after the call has returned, so the opener is looked up on PATH first.
 */
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
    if (process.platform !== 'win32' && !findOnPath(cmd)) return false;
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
    // Windows needs a shell to find claude.cmd. Node 24 prints DEP0190 on stderr when args are passed together with
    // `shell: true`, so there the whole command line goes in as one fixed string instead.
    const r =
      process.platform === 'win32'
        ? spawnSync('claude --version', { encoding: 'utf8', shell: true, timeout: 10000 })
        : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0];
  } catch {
    /* not installed or not on PATH */
  }
  return null;
}

/** Shell-quoted path to the running Node binary, for hook commands that must survive PATH differences. */
export function nodeCommand() {
  let exe = process.execPath;
  // fnm on Windows starts node through a per-shell junction (...\fnm_multishells\<pid>_<time>\node.exe) that is deleted
  // once that shell is gone; a hook pinned to it would fail with ENOENT from then on. Pin the real installation instead.
  // Other launchers (nvm-windows, Homebrew, volta shims) use stable link locations and are kept as they are.
  if (/fnm_multishells/i.test(exe)) {
    try {
      exe = fs.realpathSync.native(exe);
    } catch {
      /* keep the path as it is */
    }
  }
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
