#!/usr/bin/env node
// Development runner: API, worker and dashboard with prefixed output.
//
//   pnpm dev             API + worker + web against DATABASE_URL (PostgreSQL)
//   pnpm dev:embedded    API (with the worker inside) + web on embedded Postgres in .data/pglite
//   --no-web             skip the dashboard
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const embedded = args.has('--embedded');

const envPath = join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
else console.warn('No .env found — run `pnpm run setup` first (continuing with defaults).');

const env = { ...process.env, FORCE_COLOR: '1' };
if (embedded) {
  const url = env.DATABASE_URL?.startsWith('pglite://') ? env.DATABASE_URL : 'pglite://.data/pglite';
  const path = url.slice('pglite://'.length);
  env.DATABASE_URL = `pglite://${resolve(root, path)}`;
  env.EMBEDDED_WORKER = 'true';
} else if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run `pnpm run setup` (PostgreSQL) or `pnpm dev:embedded` (no Docker).');
  process.exit(1);
} else if (env.DATABASE_URL.startsWith('pglite://')) {
  console.log('DATABASE_URL points at the embedded database: switching to embedded mode (worker inside the API).');
  env.EMBEDDED_WORKER = 'true';
}

const procs = [{ name: 'api', color: 36, args: ['--filter', '@aoc/api', 'dev'] }];
if (env.EMBEDDED_WORKER !== 'true') procs.push({ name: 'worker', color: 35, args: ['--filter', '@aoc/worker', 'dev'] });
if (!args.has('--no-web')) procs.push({ name: 'web', color: 33, args: ['--filter', '@aoc/web', 'dev'] });

const children = [];
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const p of procs) {
  const child = spawn('pnpm', ['--silent', ...p.args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = `\x1b[${p.color}m${p.name.padEnd(6)}\x1b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    if (!exiting) shutdown(code ?? 1);
  });
  children.push(child);
}

console.log(`Automated Opportunity Center — ${embedded || env.EMBEDDED_WORKER === 'true' ? 'embedded' : 'PostgreSQL'} mode, PAPER only. Ctrl+C stops everything.`);
console.log(`  Dashboard  http://localhost:3000\n  API docs   http://${env.API_HOST ?? '127.0.0.1'}:${env.API_PORT ?? 4000}/docs\n`);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
