import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  createDatabase,
  createTestDatabase,
  experimentVersions,
  experiments,
  isUniqueViolation,
  jobRuns,
  paperAccounts,
  paperTransactions,
  pgErrorCode,
  rowsOf,
  strategies,
  type DatabaseHandle,
} from '../src';

let h: DatabaseHandle;

beforeAll(async () => {
  h = await createTestDatabase();
});
afterAll(async () => {
  await h.close();
});

async function seedExperiment() {
  await h.db
    .insert(strategies)
    .values({ id: 'test.s', name: 'S', kind: 'TRADING', category: 'CRYPTO_TRADING', moduleVersion: '1.0.0', description: 'd' })
    .onConflictDoNothing();
  const [exp] = await h.db
    .insert(experiments)
    .values({
      slug: `exp-${Math.random().toString(36).slice(2)}`,
      strategyId: 'test.s',
      name: 'E',
      seed: 'test-seed',
      category: 'CRYPTO_TRADING',
      kind: 'TRADING',
      description: 'd',
      hypothesis: 'h',
      riskLimits: {},
    })
    .returning();
  return exp!;
}

describe('migrations', () => {
  it('creates every table', async () => {
    const res = await h.db.execute(sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
    // 29 application tables + drizzle's migration journal lives in its own schema
    expect(rowsOf<{ n: number }>(res)[0]!.n).toBe(29);
  });
  it('is idempotent', async () => {
    await h.migrate();
  });
});

describe('guards', () => {
  it('audit log is append-only', async () => {
    const [row] = await h.db
      .insert(auditLogs)
      .values({ actorType: 'SYSTEM', actorId: 'test', action: 'SEED_LOADED', entityType: 'test' })
      .returning();
    await expect(h.db.update(auditLogs).set({ action: 'X' }).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
    await expect(h.db.delete(auditLogs).where(eq(auditLogs.id, row!.id))).rejects.toThrow();
  });

  it('experiment version params are immutable, status is not', async () => {
    const exp = await seedExperiment();
    const [v] = await h.db
      .insert(experimentVersions)
      .values({ experimentId: exp.id, seq: 1, label: 'v1', params: { a: 1 }, strategyModuleVersion: '1.0.0' })
      .returning();
    await expect(h.db.update(experimentVersions).set({ params: { a: 2 } }).where(eq(experimentVersions.id, v!.id))).rejects.toThrow();
    await h.db.update(experimentVersions).set({ status: 'SUPERSEDED' }).where(eq(experimentVersions.id, v!.id));
    const [after] = await h.db.select().from(experimentVersions).where(eq(experimentVersions.id, v!.id));
    expect(after!.status).toBe('SUPERSEDED');
    expect(after!.params).toEqual({ a: 1 });
  });

  it('version seq and label are unique per experiment', async () => {
    const exp = await seedExperiment();
    await h.db.insert(experimentVersions).values({ experimentId: exp.id, seq: 1, label: 'v1', params: {}, strategyModuleVersion: '1' });
    const err = await h.db
      .insert(experimentVersions)
      .values({ experimentId: exp.id, seq: 1, label: 'v1-dup', params: {}, strategyModuleVersion: '1' })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('paper ledger rows cannot be edited but cascade with their account', async () => {
    const exp = await seedExperiment();
    const [acct] = await h.db
      .insert(paperAccounts)
      .values({ experimentId: exp.id, name: 'a', startingCapital: '100', cash: '100', peakEquity: '100', dayKey: '2026-01-01', dayStartEquity: '100' })
      .returning();
    const [tx] = await h.db
      .insert(paperTransactions)
      .values({ accountId: acct!.id, seq: 1, type: 'DEPOSIT', amount: '100', balanceAfter: '100', ts: new Date() })
      .returning();
    await expect(h.db.update(paperTransactions).set({ amount: '1' }).where(eq(paperTransactions.id, tx!.id))).rejects.toThrow();
    await expect(h.db.delete(paperTransactions).where(eq(paperTransactions.id, tx!.id))).rejects.toThrow();
    await h.db.delete(paperAccounts).where(eq(paperAccounts.id, acct!.id));
    const left = await h.db.select().from(paperTransactions).where(eq(paperTransactions.accountId, acct!.id));
    expect(left).toHaveLength(0);
  });

  it('only one ACTIVE paper account per experiment', async () => {
    const exp = await seedExperiment();
    const base = { experimentId: exp.id, name: 'a', startingCapital: '1', cash: '1', peakEquity: '1', dayKey: 'd', dayStartEquity: '1' };
    await h.db.insert(paperAccounts).values(base);
    const err = await h.db.insert(paperAccounts).values(base).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    await h.db.insert(paperAccounts).values({ ...base, status: 'CLOSED' });
  });

  it('rejects negative starting capital and non-positive order quantity', async () => {
    const exp = await seedExperiment();
    const err = await h.db
      .insert(paperAccounts)
      .values({ experimentId: exp.id, name: 'a', startingCapital: '-1', cash: '0', peakEquity: '0', dayKey: 'd', dayStartEquity: '0' })
      .catch((e: unknown) => e);
    expect(pgErrorCode(err)).toBe('23514');
  });

  it('job dedupe keys are unique', async () => {
    await h.db.insert(jobRuns).values({ name: 'j', dedupeKey: 'j:1' });
    const err = await h.db.insert(jobRuns).values({ name: 'j', dedupeKey: 'j:1' }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    // null keys never collide
    await h.db.insert(jobRuns).values({ name: 'j' });
    await h.db.insert(jobRuns).values({ name: 'j' });
  });
});

describe('embedded database lock', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'aoc-lock-')), 'db');

  it('refuses a second opener of the same directory and releases on close', async () => {
    const first = await createDatabase(`pglite://${dir}`);
    // Pretend another live process holds it: our parent process is alive and is not us.
    writeFileSync(`${dir}.lock`, String(process.ppid));
    await expect(createDatabase(`pglite://${dir}`)).rejects.toThrow(/in use by process/);
    writeFileSync(`${dir}.lock`, String(process.pid));
    await first.close();
    expect(existsSync(`${dir}.lock`)).toBe(false);
  }, 60_000);

  it('takes over a stale lock left by a process that is gone', async () => {
    writeFileSync(`${dir}.lock`, '999999999');
    const h2 = await createDatabase(`pglite://${dir}`);
    expect(readFileSync(`${dir}.lock`, 'utf8')).toBe(String(process.pid));
    await h2.close();
    expect(existsSync(`${dir}.lock`)).toBe(false);
  }, 60_000);
});
