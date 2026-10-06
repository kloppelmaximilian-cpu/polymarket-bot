import { describe, expect, it } from 'vitest';
import {
  LIVE_CONFIRMATION_PHRASE,
  Rng,
  assertLiveAllowed,
  d,
  dsum,
  evaluateLiveGate,
  loadConfig,
  mean,
  normCdf,
  normInv,
  quantile,
  redactConfig,
  roundToTick,
  stableHash,
  stdev,
  toDb,
  normalizeTitle,
  LiveTradingDisabledError,
  ValidationError,
} from '../src';

const baseEnv = { DATABASE_URL: 'memory://' };

describe('decimal', () => {
  it('adds money without float error', () => {
    expect(d('0.1').plus('0.2').toString()).toBe('0.3');
    expect(dsum(Array.from({ length: 1000 }, () => '0.01')).toString()).toBe('10');
  });
  it('serialises to the persisted scale', () => {
    expect(toDb('1.23456789012345')).toBe('1.2345678901');
    expect(toDb(5)).toBe('5.0000000000');
  });
  it('rejects non-finite numbers', () => {
    expect(() => d(Number.NaN)).toThrow(RangeError);
    expect(() => d(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
  it('rounds to ticks', () => {
    expect(roundToTick('0.5349', '0.01', 'down').toString()).toBe('0.53');
    expect(roundToTick('0.5301', '0.01', 'up').toString()).toBe('0.54');
    expect(roundToTick('0.535', '0.01').toString()).toBe('0.54'); // half-even: 53.5 -> 54
  });
});

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-1');
    const c = new Rng('seed-2');
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
  });
  it('produces uniform values in [0,1)', () => {
    const r = new Rng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('has correct moments for normal, triangular, beta and binomial', () => {
    const r = new Rng('moments');
    const n = 40_000;
    const normals = Array.from({ length: n }, () => r.normal(2, 3));
    expect(mean(normals)).toBeCloseTo(2, 1);
    expect(stdev(normals)).toBeCloseTo(3, 1);
    const tri = Array.from({ length: n }, () => r.triangular(0, 1, 5));
    expect(mean(tri)).toBeCloseTo(2, 1);
    const betas = Array.from({ length: n }, () => r.beta(2, 8));
    expect(mean(betas)).toBeCloseTo(0.2, 2);
    const small = Array.from({ length: n }, () => r.binomial(20, 0.1));
    expect(mean(small)).toBeCloseTo(2, 1);
    const big = Array.from({ length: 5000 }, () => r.binomial(10_000, 0.3));
    expect(mean(big)).toBeGreaterThan(2980);
    expect(mean(big)).toBeLessThan(3020);
    for (const k of big) {
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(10_000);
    }
    const high = Array.from({ length: n }, () => r.binomial(10, 0.95));
    expect(mean(high)).toBeCloseTo(9.5, 1);
    const pois = Array.from({ length: n }, () => r.poisson(4));
    expect(mean(pois)).toBeCloseTo(4, 1);
  });
  it('rejects invalid triangular parameters', () => {
    expect(() => new Rng(1).triangular(5, 1, 0)).toThrow(RangeError);
  });
  it('forks independent streams deterministically', () => {
    const a = new Rng('x').fork('child');
    const b = new Rng('x').fork('child');
    expect(a.next()).toBe(b.next());
  });
});

describe('stats', () => {
  it('normCdf and normInv are inverse', () => {
    for (const p of [0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
    }
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
  });
  it('returns NaN, not 0, for empty input', () => {
    expect(mean([])).toBeNaN();
    expect(stdev([1])).toBeNaN();
    expect(quantile([], 0.5)).toBeNaN();
  });
  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
  });
});

describe('config', () => {
  it('defaults to paper mode with live disabled', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.TRADING_MODE).toBe('paper');
    expect(cfg.LIVE_TRADING_ENABLED).toBe(false);
    expect(cfg.LIVE_CAPITAL_CAP_USD).toBe(0);
    expect(cfg.PAPER_TOTAL_CAPITAL_USD).toBe(10_000);
  });
  it('requires a database url', () => {
    expect(() => loadConfig({})).toThrow(ValidationError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(ValidationError);
  });
  it('rejects malformed booleans and numbers instead of guessing', () => {
    expect(() => loadConfig({ ...baseEnv, LIVE_TRADING_ENABLED: 'maybe' })).toThrow(ValidationError);
    expect(() => loadConfig({ ...baseEnv, API_PORT: 'abc' })).toThrow(ValidationError);
    expect(() => loadConfig({ ...baseEnv, API_PORT: '70000' })).toThrow(ValidationError);
  });
  it('requires a strong API token in production', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production' })).toThrow(/API_TOKEN/);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'production', API_TOKEN: 'x'.repeat(32) }).API_TOKEN).toHaveLength(32);
  });
  it('redacts secrets and database passwords', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://aoc:hunter2@db:5432/aoc', API_TOKEN: 'abcdefghijklmnopqrstuvwxyz', GITHUB_TOKEN: 'ghp_x' });
    const red = redactConfig(cfg);
    expect(JSON.stringify(red)).not.toContain('hunter2');
    expect(JSON.stringify(red)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(red)).not.toContain('ghp_x');
    expect(red.DATABASE_URL).toBe('postgres://aoc:***@db:5432/aoc');
  });
});

describe('live gate', () => {
  const ctx = { experimentStatus: 'PAPER' as const, humanApprovalId: null, emergencyStopEngaged: false, requestedCapitalUsd: 100 };

  it('is closed by default and reports every failing condition', () => {
    const res = evaluateLiveGate(loadConfig(baseEnv), ctx);
    expect(res.allowed).toBe(false);
    expect(res.reasons.length).toBeGreaterThanOrEqual(6);
    expect(res.reasons.join(' ')).toMatch(/TRADING_MODE/);
    expect(res.reasons.join(' ')).toMatch(/LIVE_TRADING_ENABLED/);
    expect(res.reasons.join(' ')).toMatch(/LIVE_CONFIRMATION/);
  });

  it('stays closed even when every configurable condition is satisfied (no live executor)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      TRADING_MODE: 'live',
      LIVE_TRADING_ENABLED: 'true',
      LIVE_CONFIRMATION: LIVE_CONFIRMATION_PHRASE,
      LIVE_CAPITAL_CAP_USD: '500',
    });
    const res = evaluateLiveGate(cfg, { ...ctx, experimentStatus: 'READY_FOR_LIVE_REVIEW', humanApprovalId: 'audit-1' });
    expect(res.allowed).toBe(false);
    expect(res.reasons).toEqual(['no live executor is implemented in this version of the platform']);
    expect(() => assertLiveAllowed(cfg, { ...ctx, experimentStatus: 'READY_FOR_LIVE_REVIEW', humanApprovalId: 'a' })).toThrow(
      LiveTradingDisabledError,
    );
  });

  it('enforces the capital cap and the emergency stop', () => {
    const cfg = loadConfig({ ...baseEnv, LIVE_CAPITAL_CAP_USD: '50' });
    const res = evaluateLiveGate(cfg, { ...ctx, requestedCapitalUsd: 100, emergencyStopEngaged: true });
    expect(res.reasons.join(' ')).toMatch(/exceeds LIVE_CAPITAL_CAP_USD/);
    expect(res.reasons.join(' ')).toMatch(/emergency stop/);
  });

  it('accepts only the exact confirmation phrase', () => {
    const cfg = loadConfig({ ...baseEnv, LIVE_CONFIRMATION: 'yes' });
    expect(evaluateLiveGate(cfg, ctx).reasons.join(' ')).toMatch(/LIVE_CONFIRMATION/);
  });
});

describe('ids', () => {
  it('hashes structurally equal values identically', () => {
    expect(stableHash({ a: 1, b: [1, 2] })).toBe(stableHash({ b: [1, 2], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
  it('normalises titles for dedupe', () => {
    expect(normalizeTitle('AI  Lead-Gen!')).toBe('ai lead gen');
  });
});
