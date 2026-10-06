import { ideas, users, experiments } from '@aoc/database';
import { normalizeTitle } from '@aoc/core';
import { and, eq } from 'drizzle-orm';
import { SYSTEM, audit } from './audit';
import type { PlatformContext } from './context';
import { createExperiment, syncStrategies, transition } from './experiments';
import { linkSourcesToExperiment, seedResearchSources } from './research-service';

export interface StarterDef {
  strategyId: string;
  name: string;
  capital: number;
  /** Starters begin researching immediately; extras wait for a human. */
  start: boolean;
}

/** The first experiments (requirement 39), plus the other registered modules as ready-to-start ideas. */
export const STARTERS: StarterDef[] = [
  { strategyId: 'business.ai-lead-generation', name: 'AI Lead Generation', capital: 500, start: true },
  { strategyId: 'business.ai-saas', name: 'AI SaaS', capital: 500, start: true },
  { strategyId: 'business.ai-support-agent', name: 'AI Customer Support Agent', capital: 500, start: true },
  { strategyId: 'business.ai-sales-agent', name: 'AI Sales Agent', capital: 500, start: true },
  { strategyId: 'business.digital-products', name: 'Automated Digital Products', capital: 500, start: true },
  { strategyId: 'trading.momentum', name: 'Crypto Momentum Paper Strategy', capital: 1000, start: true },
  { strategyId: 'trading.mean-reversion', name: 'Crypto Mean Reversion Paper Strategy', capital: 1000, start: true },
  { strategyId: 'arb.cross-exchange', name: 'Crypto Arbitrage Simulator', capital: 1000, start: true },
  { strategyId: 'arb.funding-rate', name: 'Funding-Rate Arbitrage Simulator', capital: 1000, start: true },
  { strategyId: 'pm.arbitrage', name: 'Prediction-Market Arbitrage Simulator', capital: 1000, start: true },
  { strategyId: 'pm.market-making', name: 'Prediction-Market Market-Making Simulator', capital: 1000, start: true },
  { strategyId: 'trading.breakout', name: 'Donchian Breakout (BTC)', capital: 1000, start: false },
  { strategyId: 'trading.trend-following', name: 'Vol-Targeted Trend Following (BTC)', capital: 1000, start: false },
  { strategyId: 'trading.volatility-breakout', name: 'Volatility Compression Breakout (BTC)', capital: 1000, start: false },
  { strategyId: 'trading.stat-arb-pairs', name: 'BTC/ETH Statistical Arbitrage', capital: 1000, start: false },
  { strategyId: 'pm.mispricing', name: 'Multi-Outcome Mispricing Detection', capital: 500, start: false },
  { strategyId: 'pm.value', name: 'Prediction-Market Value Trading', capital: 500, start: false },
  { strategyId: 'pm.orderbook-imbalance', name: 'Order-Book Imbalance Signals', capital: 500, start: false },
  { strategyId: 'pm.near-resolution', name: 'Near-Resolution Favourites', capital: 500, start: false },
];

export interface SeedResult {
  strategies: number;
  sources: number;
  created: string[];
  skipped: string[];
}

/** Idempotent: running it twice creates nothing new. */
export async function seed(ctx: PlatformContext, opts: { startStarters?: boolean } = {}): Promise<SeedResult> {
  await ctx.db.insert(users).values({ email: 'owner@localhost', name: 'Owner', role: 'OWNER' }).onConflictDoNothing();
  const n = await syncStrategies(ctx);
  const sourcesByStrategy = await seedResearchSources(ctx);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const s of STARTERS) {
    if (!ctx.registry.has(s.strategyId)) {
      skipped.push(`${s.name} (module missing)`);
      continue;
    }
    const [existing] = await ctx.db.select({ id: experiments.id }).from(experiments).where(and(eq(experiments.strategyId, s.strategyId), eq(experiments.name, s.name)));
    if (existing) {
      skipped.push(s.name);
      continue;
    }
    const m = ctx.registry.get(s.strategyId);
    const [idea] = await ctx.db
      .insert(ideas)
      .values({
        name: s.name,
        normalizedName: normalizeTitle(s.name),
        category: m.meta.category,
        description: m.meta.description,
        origin: 'SEED',
        status: 'CONVERTED',
        automationScore: m.meta.qualitative.automation,
        complexityScore: 100 - m.meta.qualitative.operationalSimplicity,
        scalabilityScore: m.meta.qualitative.scalability,
        testabilityScore: m.meta.capabilities.backtest || m.meta.capabilities.monteCarlo ? 80 : 50,
        revenueSource: m.meta.kind === 'BUSINESS' ? 'Operating revenue (see assumptions)' : 'Trading profits (if an edge exists)',
        risks: m.meta.knownRisks,
        suggestedStrategyId: s.strategyId,
        assessment: { notes: ['Starter experiment defined in the implementation plan.'] },
      })
      .onConflictDoNothing({ target: ideas.normalizedName })
      .returning({ id: ideas.id });
    const exp = await createExperiment(ctx, { strategyId: s.strategyId, name: s.name, capital: s.capital, ideaId: idea?.id ?? null }, SYSTEM);
    if (idea) await ctx.db.update(ideas).set({ experimentId: exp.id }).where(eq(ideas.id, idea.id));
    await linkSourcesToExperiment(ctx.db, exp.id, [...(sourcesByStrategy.get(s.strategyId) ?? []), ...(sourcesByStrategy.get('*') ?? [])]);
    if (s.start && opts.startStarters !== false) {
      await ctx.db.transaction((tx) => transition(ctx, tx, exp, 'RESEARCHING', { actor: SYSTEM, reason: 'starter experiment: research started by seed' }));
    }
    created.push(s.name);
  }
  await audit(ctx.db, SYSTEM, 'SEED_LOADED', { type: 'system' }, { created, skipped, strategies: n });
  return { strategies: n, sources: [...new Set([...sourcesByStrategy.values()].flat())].length, created, skipped };
}
