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
      migrate: () => migratePg(drizzlePg({ client: pool, schema }), { migrationsFolder: migrationsDir() }),
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

async function ping(db: Database): Promise<number> {
  const started = performance.now();
  await db.execute(sql`select 1`);
  return Math.round(performance.now() - started);
}

/** Convenience for tests: an in-memory, fully migrated database. */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = await createDatabase('memory://');
  await handle.migrate();
  return handle;
}
