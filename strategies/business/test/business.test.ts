import { Rng, mean } from '@aoc/core';
import { PaperAccount, verifyLedger, type TransactionState } from '@aoc/paper-engine';
import { assumption, modeValues, sampleAssumption, validateAssumptions } from '@aoc/strategies';
import { aiLeadGenModule, AiLeadGenModel } from '@aoc/strategies-lead-generation';
import { aiSaasModule, AiSaasModel } from '@aoc/strategies-saas';
import { describe, expect, it } from 'vitest';
import { DigitalProductsModel, businessModules, digitalProductsModule, salesAgentModule, supportAgentModule } from '../src';

const all = [aiSaasModule, aiLeadGenModule, ...businessModules];

describe('assumptions', () => {
  it('samples within range and respects fixed values', () => {
    const r = new Rng('a');
    const a = assumption('x', 'X', 'u', 1, 2, 5);
    for (let i = 0; i < 2000; i++) {
      const v = sampleAssumption(a, r);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
    expect(sampleAssumption(assumption('f', 'F', 'u', 3, 3, 3), r)).toBe(3);
  });
  it('rejects inconsistent ranges and duplicates', () => {
    expect(() => validateAssumptions([{ ...assumption('x', 'X', 'u', 1, 2, 3), mode: 5 }])).toThrow();
    expect(() => validateAssumptions([assumption('x', 'X', 'u', 1, 2, 3), assumption('x', 'X', 'u', 1, 2, 3)])).toThrow(/duplicate/);
  });
  it('marks every default assumption as unverified (no invented sources)', () => {
    for (const m of all) for (const a of m.defaultAssumptions!()) expect(a.source, `${m.meta.id}.${a.key}`).toBeNull();
  });
});

describe('funnel arithmetic', () => {
  it('expected new customers match demand × stage rates', () => {
    const model = new AiSaasModel();
    const v = modeValues(model.defaultAssumptions());
    const rng = new Rng('funnel');
    const draws: number[] = [];
    for (let i = 0; i < 4000; i++) draws.push(model.acquireCustomer(1500, model.calculateConversion(v), rng));
    expect(mean(draws)).toBeCloseTo(1500 * 0.04 * 0.15, 0); // 9 per month
  });

  it('caps customers at the addressable market', () => {
    const model = new AiLeadGenModel();
    const v = { ...modeValues(model.defaultAssumptions()), addressable: 3, leads: 50_000, replyRate: 0.5 };
    const run = model.simulateRun(v, 12, new Rng('cap'), 1000);
    for (const m of run.monthly) expect(m.customers).toBeLessThanOrEqual(3);
  });

  it('one-off products start every month from zero buyers', () => {
    const model = new DigitalProductsModel();
    const run = model.simulateRun(modeValues(model.defaultAssumptions()), 6, new Rng('d'), 500);
    for (const m of run.monthly) expect(m.customers).toBe(m.newCustomers);
    for (const m of run.monthly) expect(m.recurringRevenue).toBe(0);
  });

  it('profit = revenue − costs in every period', () => {
    const model = new AiSaasModel();
    const run = model.simulateRun(modeValues(model.defaultAssumptions()), 12, new Rng('p'), 1000);
    for (const m of run.monthly) expect(m.profit).toBeCloseTo(m.revenue - m.costs.total, 9);
    expect(run.monthly[11]!.cash).toBeCloseTo(1000 + run.monthly.reduce((a, m) => a + m.profit, 0), 6);
  });
});

describe('Monte Carlo evaluation', () => {
  const input = (seed: string) => ({ params: {}, assumptions: [], runs: 300, horizonMonths: 24, seed, startingCapital: 1000 });

  it('is reproducible and labelled ESTIMATED', () => {
    const a = aiSaasModule.simulate!(input('s1'));
    const b = aiSaasModule.simulate!(input('s1'));
    expect(a.summary).toEqual(b.summary);
    expect(a.provenance).toBe('ESTIMATED');
    expect(a.notes.join(' ')).toMatch(/not observations/);
    expect(aiSaasModule.simulate!(input('s2')).summary).not.toEqual(a.summary);
  });

  it('produces consistent percentiles, sorted sensitivity and a harsher stress case', () => {
    for (const m of all) {
      const r = m.simulate!(input('x'));
      const s = r.summary;
      expect(s.cumulativeProfit.p10, m.meta.id).toBeLessThanOrEqual(s.cumulativeProfit.p50);
      expect(s.cumulativeProfit.p50).toBeLessThanOrEqual(s.cumulativeProfit.p90);
      expect(s.probProfitableAtHorizon).toBeGreaterThanOrEqual(0);
      expect(s.probProfitableAtHorizon).toBeLessThanOrEqual(1);
      expect(r.months).toHaveLength(24);
      for (let i = 1; i < r.sensitivity.length; i++) expect(r.sensitivity[i]!.swing).toBeLessThanOrEqual(r.sensitivity[i - 1]!.swing);
      expect(r.stressedProfitP50, m.meta.id).toBeLessThanOrEqual(s.cumulativeProfit.p50 + 1e-6);
    }
  });
});

describe('paper operation', () => {
  it('advances simulated days into the paper ledger, consistently and reproducibly', () => {
    for (const m of [supportAgentModule, salesAgentModule, digitalProductsModule, aiSaasModule, aiLeadGenModule]) {
      const run = () => {
        const { account, changes } = PaperAccount.open({ startingCapital: 1000, ts: new Date('2026-01-01T00:00:00Z') });
        const ledger: TransactionState[] = [...changes.transactions];
        let state: Record<string, unknown> = {};
        for (let day = 0; day < 6; day++) {
          const out = m.paperStep!({ params: m.meta.defaultParams, account, now: new Date(Date.UTC(2026, 0, 1 + day * 5)), live: { provenance: 'PAPER', label: 'sim' }, state, seed: 'paper', assumptions: [], daysToSimulate: 5 });
          for (const c of out.changes) ledger.push(...c.transactions);
          state = out.state;
          expect(out.simulatedDays).toBe(5);
        }
        expect(verifyLedger(ledger, account.snapshot().cash).ok).toBe(true);
        return { equity: account.snapshot().equity.toString(), day: state.day };
      };
      const a = run();
      expect(a).toEqual(run());
      expect(a.day).toBe(30);
    }
  });
});
