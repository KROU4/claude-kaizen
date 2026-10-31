#!/usr/bin/env node
// Runs every tests/*.test.mjs with the built-in node:test runner.
// Explicit file paths work the same on Node 18 (no glob support) and Node 21+
// (where a bare directory argument is no longer accepted).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f)) : [];
if (!files.length) {
  console.error('no test files found in tests/');
  process.exit(1);
}
const extra = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit', cwd: root });
process.exit(r.status === null ? 1 : r.status);
