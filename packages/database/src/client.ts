import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
/** A transaction handle has the same query surface as the database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

export interface DatabaseHandle {
  db: Database;
  kind: 'postgres' | 'pglite';
  url: string;
  migrate(): Promise<void>;
  ping(): Promise<number>;
  close(): Promise<void>;
}

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'migrations');
}

export interface CreateDatabaseOptions {
  /** Called for errors on idle pooled connections (they must not crash the process). */
  onPoolError?: (err: Error) => void;
  maxConnections?: number;
}

/**
 * Open a database from a URL:
 *   postgres://user:pass@host:5432/db   → node-postgres pool
 *   pglite://relative/or/absolute/dir   → embedded Postgres (WASM), persisted
 *   memory://                           → embedded Postgres, in memory (tests)
 *
 * PGlite is single-connection: only one process may open a given directory.
 * In embedded mode the worker therefore runs inside the API process.
 */
export async function createDatabase(url: string, opts: CreateDatabaseOptions = {}): Promise<DatabaseHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pool = new pg.Pool({
      connectionString: url,
      max: opts.maxConnections ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      if (opts.onPoolError) opts.onPoolError(err);
      else process.stderr.write(`[database] idle client error: ${err.message}\n`);
    });
    const db = drizzlePg({ client: pool, schema }) as unknown as Database;
    return {
      db,
      kind: 'postgres',
      url,
      migrate: () => migrateWithLock(url),
      ping: () => ping(db),
      close: () => pool.end(),
    };
  }
  if (url.startsWith('pglite://') || url.startsWith('memory://')) {
    let client: PGlite;
    if (url.startsWith('memory://')) {
      client = new PGlite();
    } else {
      const dir = resolve(url.slice('pglite://'.length) || '.data/pglite');
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    await client.waitReady;
    const pdb = drizzlePglite({ client, schema });
    const db = pdb as unknown as Database;
    return {
      db,
      kind: 'pglite',
      url,
      migrate: () => migratePglite(pdb, { migrationsFolder: migrationsDir() }),
      ping: () => ping(db),
      close: () => client.close(),
    };
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(':')[0]}`);
}

/** Arbitrary constant key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 72_625_241;

/**
 * Run migrations on a dedicated connection holding a session advisory lock,
 * so an API and a worker starting at the same time cannot migrate twice.
 */
async function migrateWithLock(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migratePg(drizzlePg({ client, schema }), { migrationsFolder: migrationsDir() });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function ping(db: Database): Promise<number> {
  const started = performance.now();
  await db.execute(sql`select 1`);
  return Math.round(performance.now() - started);
}

/**
 * A fresh, fully migrated database for one test file. With TEST_DATABASE_URL
 * set (postgres://…) every call creates its own throwaway database on that
 * server and drops it on close; otherwise it is an in-memory PGlite.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin || !/^postgres(ql)?:\/\//.test(admin)) {
    const handle = await createDatabase('memory://');
    await handle.migrate();
    return handle;
  }
  const name = `aoc_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE ${name}`);
  } finally {
    await adminClient.end();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const handle = await createDatabase(url.toString(), { maxConnections: 5 });
  await handle.migrate();
  return {
    ...handle,
    close: async () => {
      await handle.close();
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
