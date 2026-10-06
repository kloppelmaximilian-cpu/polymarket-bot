import type { Provenance } from './enums';
import { EVIDENCE_RANK } from './enums';

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  HISTORICAL: 'Backtest on historical data',
  SIMULATED: 'Simulated',
  PAPER: 'Paper (live data, virtual money)',
  ESTIMATED: 'Estimated from assumptions',
  HYPOTHETICAL: 'Hypothetical',
  DEMO: 'DEMO data — not a real result',
};

/** The sentence every result is framed with. Never "will", never "guaranteed". */
export function resultDisclaimer(p: Provenance): string {
  switch (p) {
    case 'HISTORICAL':
      return 'Simulated trades on observed historical data under the tested assumptions. Past results do not predict future results.';
    case 'PAPER':
      return 'Virtual-money results on live data under the tested assumptions. No real orders were placed.';
    case 'SIMULATED':
      return 'Model simulation under the stated assumptions; not observed results.';
    case 'ESTIMATED':
      return 'Estimate derived from assumption ranges; not observed results.';
    case 'HYPOTHETICAL':
      return 'Hypothetical assessment; nothing has been tested yet.';
    case 'DEMO':
      return 'DEMO data for illustration only. Not a real or simulated result of this strategy.';
  }
}

export function strongestEvidence(ps: Iterable<Provenance>): Provenance | null {
  let best: Provenance | null = null;
  for (const p of ps) if (best === null || EVIDENCE_RANK[p] > EVIDENCE_RANK[best]) best = p;
  return best;
}
