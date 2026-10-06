import { Rng, type OrderBook, type OutcomeBook } from '@aoc/core';
import type { DataBundle, PredictionMarketSnapshot } from '@aoc/strategies';

export interface SyntheticPMOptions {
  seed: string;
  markets: number;
  snapshots: number;
  intervalMs: number;
  startTs: number;
  /** Std-dev of the market's pricing error around the true probability. */
  marketNoise: number;
  /** Std-dev of the external fair-value estimate's error (value trading DEMO). */
  oracleNoise: number;
  /** Quoted spread in probability points. */
  spread: number;
  /** Share of markets with more than two outcomes (neg-risk events). */
  multiOutcomeShare: number;
  feeRate: number;
}

export const DEFAULT_PM_SYNTHETIC: Omit<SyntheticPMOptions, 'seed'> = {
  markets: 12,
  snapshots: 864, // 3 days of 5-minute snapshots
  intervalMs: 5 * 60_000,
  startTs: Date.UTC(2025, 5, 1),
  marketNoise: 0.012,
  oracleNoise: 0.012,
  spread: 0.02,
  multiOutcomeShare: 0.35,
  feeRate: 0.0,
};

const clampP = (p: number) => Math.min(0.99, Math.max(0.01, p));
const tick = (p: number) => Math.round(p * 100) / 100;

/**
 * DEMO prediction-market world. Each market has a latent true probability
 * (logit random walk) and resolves by drawing from it at its end time. The
 * order book is centred on the truth plus independent pricing noise, so
 * complementary asks occasionally sum below 1 by chance — but no strategy is
 * given information it could not have: the "oracle" used by value trading
 * is as noisy as the market itself (no built-in edge).
 */
export function syntheticPredictionMarkets(o: SyntheticPMOptions): DataBundle {
  const rng = new Rng(`synthetic-pm/${o.seed}`);
  interface M {
    id: string;
    question: string;
    outcomes: string[];
    logits: number[];
    endIdx: number;
    resolved: string | null;
  }
  const ms: M[] = [];
  for (let i = 0; i < o.markets; i++) {
    const multi = rng.next() < o.multiOutcomeShare;
    const k = multi ? rng.int(3, 5) : 2;
    const outcomes = multi ? Array.from({ length: k }, (_, j) => `Option ${String.fromCharCode(65 + j)}`) : ['Yes', 'No'];
    ms.push({
      id: `demo-market-${i + 1}`,
      question: multi ? `DEMO: Which option wins event ${i + 1}?` : `DEMO: Will event ${i + 1} happen?`,
      outcomes,
      logits: outcomes.map(() => rng.normal(0, 1)),
      endIdx: rng.int(Math.floor(o.snapshots * 0.3), o.snapshots - 1),
      resolved: null,
    });
  }
  const series: PredictionMarketSnapshot[] = [];
  for (let t = 0; t < o.snapshots; t++) {
    const ts = o.startTs + t * o.intervalMs;
    const snap: PredictionMarketSnapshot = { ts, markets: [], fair: {} };
    for (const m of ms) {
      if (m.resolved !== null && t > m.endIdx + 1) continue;
      if (m.resolved === null) for (let j = 0; j < m.logits.length; j++) m.logits[j] = (m.logits[j] as number) + rng.normal(0, 0.05);
      const exps = m.logits.map(Math.exp);
      const total = exps.reduce((a, b) => a + b, 0);
      let truth = exps.map((e) => e / total);
      if (m.outcomes.length === 2) truth = [truth[0] as number, 1 - (truth[0] as number)];
      if (t === m.endIdx && m.resolved === null) {
        let u = rng.next();
        let w = m.outcomes.length - 1;
        for (let j = 0; j < truth.length; j++) {
          u -= truth[j] as number;
          if (u <= 0) {
            w = j;
            break;
          }
        }
        m.resolved = m.outcomes[w] as string;
      }
      const outcomes: OutcomeBook[] = m.outcomes.map((name, j) => {
        const p = truth[j] as number;
        const mid = clampP(p + rng.normal(0, o.marketNoise));
        const bid = tick(clampP(mid - o.spread / 2));
        const ask = tick(Math.max(bid + 0.01, clampP(mid + o.spread / 2)));
        const tokenId = `${m.id}-${name.toLowerCase().replace(/\s+/g, '-')}`;
        snap.fair![tokenId] = clampP(p + rng.normal(0, o.oracleNoise));
        const book: OrderBook = {
          venue: 'polymarket',
          symbol: tokenId,
          bids: [
            { price: bid, size: Math.round(rng.uniform(50, 400)) },
            { price: tick(Math.max(0.01, bid - 0.01)), size: Math.round(rng.uniform(100, 800)) },
          ],
          asks: [
            { price: ask, size: Math.round(rng.uniform(50, 400)) },
            { price: tick(Math.min(0.99, ask + 0.01)), size: Math.round(rng.uniform(100, 800)) },
          ],
          ts,
          receivedAt: ts,
          tickSize: 0.01,
        };
        return { marketId: m.id, question: m.question, outcome: name, tokenId, book, feeRate: o.feeRate, feeModel: o.feeRate > 0 ? 'polymarket_pq' : 'none', negRisk: m.outcomes.length > 2, endDate: new Date(o.startTs + m.endIdx * o.intervalMs).toISOString() };
      });
      snap.markets.push({ marketId: m.id, question: m.question, negRisk: m.outcomes.length > 2, outcomes, resolvedOutcome: t >= m.endIdx ? m.resolved : null });
    }
    series.push(snap);
  }
  return { provenance: 'DEMO', label: `DEMO synthetic prediction markets (${o.markets} markets, seed ${o.seed})`, pmSeries: series };
}
