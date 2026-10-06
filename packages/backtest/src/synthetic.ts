import { Rng, type Bar } from '@aoc/core';

export type SyntheticRegime = 'random_walk' | 'regime_switching' | 'mean_reverting';

export interface SyntheticBarsOptions {
  seed: string;
  bars: number;
  intervalMs: number;
  startTs: number;
  startPrice: number;
  /** Per-bar volatility of log returns (e.g. 0.006 ≈ hourly BTC). */
  vol: number;
  regime?: SyntheticRegime;
  /** Per-bar drift of log returns. Default 0: no edge is built in. */
  drift?: number;
  /** GARCH-like volatility clustering, 0..0.95. */
  volClustering?: number;
  avgVolume?: number;
}

/**
 * DEMO market data. The default regime is a driftless random walk with
 * volatility clustering: realistic enough to exercise costs, sizing and
 * risk, but with no exploitable pattern by construction. Any profit a
 * strategy shows on it is luck or a bug, which is exactly what makes it a
 * useful control. Results on these bars are always labelled DEMO.
 */
export function syntheticBars(o: SyntheticBarsOptions): Bar[] {
  const rng = new Rng(`synthetic-bars/${o.seed}`);
  const regime = o.regime ?? 'random_walk';
  const drift = o.drift ?? 0;
  const clustering = Math.min(0.95, Math.max(0, o.volClustering ?? 0.85));
  const out: Bar[] = [];
  let logP = Math.log(o.startPrice);
  const anchor = logP;
  let sigma = o.vol;
  let state = 0; // regime_switching: 0 chop, 1 up, −1 down
  for (let i = 0; i < o.bars; i++) {
    if (regime === 'regime_switching' && rng.next() < 0.02) state = rng.choice([-1, 0, 0, 1]);
    const shock = rng.normal();
    sigma = Math.sqrt((1 - clustering) * o.vol * o.vol + clustering * (0.7 * sigma * sigma + 0.3 * o.vol * o.vol * shock * shock));
    let mu = drift;
    if (regime === 'regime_switching') mu += state * o.vol * 0.15;
    if (regime === 'mean_reverting') mu += -0.05 * (logP - anchor);
    const open = Math.exp(logP);
    // Intrabar path with four sub-steps keeps OHLC internally consistent.
    let hi = open;
    let lo = open;
    let x = logP;
    for (let k = 0; k < 4; k++) {
      x += mu / 4 + (sigma / 2) * rng.normal();
      const p = Math.exp(x);
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
    }
    logP = x;
    const close = Math.exp(logP);
    const volume = (o.avgVolume ?? 1000) * Math.exp(rng.normal(0, 0.5)) * (1 + Math.abs(shock));
    out.push({ ts: o.startTs + i * o.intervalMs, open, high: hi, low: lo, close, volume });
  }
  return out;
}

/**
 * Two cointegrated series for pairs trading: y = beta · x · exp(spread), where
 * the spread is an Ornstein–Uhlenbeck process. With `halfLife` set very
 * large the pair is not cointegrated (negative control).
 */
export function syntheticPair(o: SyntheticBarsOptions & { beta: number; halfLifeBars: number; spreadVol: number }): { x: Bar[]; y: Bar[] } {
  const x = syntheticBars(o);
  const rng = new Rng(`synthetic-pair/${o.seed}`);
  const theta = Math.log(2) / Math.max(1, o.halfLifeBars);
  let s = 0;
  const y: Bar[] = x.map((b) => {
    s += -theta * s + o.spreadVol * rng.normal();
    const f = o.beta * Math.exp(s);
    const open = b.open * f;
    const close = b.close * f;
    return { ts: b.ts, open, high: Math.max(b.high * f, open, close), low: Math.min(b.low * f, open, close), close, volume: b.volume };
  });
  return { x, y };
}
