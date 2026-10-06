#!/usr/bin/env node
// One-time setup: checks prerequisites, writes .env (with a fresh API token),
// installs dependencies, migrates and seeds the database.
//
//   pnpm setup               PostgreSQL from DATABASE_URL (docker compose up -d postgres)
//   pnpm setup --embedded    embedded Postgres (PGlite) in .data/pglite, no Docker needed
//   pnpm setup --no-seed     skip creating the starter experiments
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const embedded = args.has('--embedded');

const step = (s) => console.log(`\n▸ ${s}`);
const fail = (s) => {
  console.error(`\n✗ ${s}`);
  process.exit(1);
};
const run = (cmd, cmdArgs, opts = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
};

step('Checking prerequisites');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) fail(`Node.js >= 22.12 required (found ${process.versions.node})`);
const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (pnpm.status !== 0) fail('pnpm not found — enable it with `corepack enable` (ships with Node.js)');
console.log(`  node ${process.versions.node}, pnpm ${pnpm.stdout.trim()}`);

step('Configuration (.env)');
const envPath = join(root, '.env');
if (!existsSync(envPath)) {
  copyFileSync(join(root, '.env.example'), envPath);
  let env = readFileSync(envPath, 'utf8');
  env = env.replace(/^API_TOKEN=.*$/m, `API_TOKEN=${randomBytes(24).toString('base64url')}`);
  if (embedded) env = env.replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=pglite://.data/pglite');
  writeFileSync(envPath, env, { mode: 0o600 });
  console.log(`  created .env with a random API_TOKEN${embedded ? ' and the embedded database' : ''}`);
} else {
  console.log('  .env exists — left unchanged');
}
process.loadEnvFile(envPath);
const dbUrl = process.env.DATABASE_URL ?? '';

step('Installing dependencies');
run('pnpm', ['install']);

if (dbUrl.startsWith('postgres')) {
  step('Checking PostgreSQL');
  const { hostname, port } = new URL(dbUrl);
  const reachable = await new Promise((res) => {
    const s = new Socket();
    s.setTimeout(3000);
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('timeout', () => (s.destroy(), res(false)));
    s.once('error', () => res(false));
    s.connect(Number(port || 5432), hostname);
  });
  if (!reachable) {
    fail(`PostgreSQL is not reachable at ${hostname}:${port || 5432}.
  Start it with:   docker compose up -d postgres
  or use the embedded database instead:   pnpm setup --embedded   (or set DATABASE_URL=pglite://.data/pglite in .env)`);
  }
  console.log(`  reachable at ${hostname}:${port || 5432}`);
}

step('Migrating the database');
run('pnpm', ['--silent', 'aoc', 'migrate']);

if (!args.has('--no-seed')) {
  step('Seeding starter experiments, ideas and research sources');
  run('pnpm', ['--silent', 'aoc', 'seed']);
}

console.log(`
✓ Setup complete. PAPER mode — no real money, no real orders.

  Start everything:      pnpm ${dbUrl.startsWith('pglite') ? 'dev:embedded' : 'dev'}
  Dashboard:             http://localhost:3000
  API + docs:            http://127.0.0.1:4000/docs
  Health check:          pnpm aoc doctor
  Tests:                 pnpm test
`);
