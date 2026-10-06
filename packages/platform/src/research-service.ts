import { EmergencyStopError, NotFoundError, describeError, normalizeTitle, toDb, type IdeaOrigin } from '@aoc/core';
import { experimentSources, experiments, ideaSources, ideas, researchSources, type DbOrTx } from '@aoc/database';
import { SEED_SOURCES, generateCatalogIdeas, generateLlmIdeas, runResearchMonitor, type IdeaDraft, type IdeaFocus, type ResearchItem } from '@aoc/research';
import { scoreIdea } from '@aoc/scoring';
import { and, desc, eq } from 'drizzle-orm';
import { audit, recordEvent, type Actor } from './audit';
import type { PlatformContext } from './context';
import { createExperiment, transition } from './experiments';
import { notify } from './notifications';
import { getEmergencyStop } from './settings';

export async function upsertSource(db: DbOrTx, item: ResearchItem, origin: IdeaOrigin | 'MONITOR' | 'SEED' | 'MANUAL'): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select({ id: researchSources.id }).from(researchSources).where(eq(researchSources.url, item.url));
  if (existing) return { id: existing.id, created: false };
  const [row] = await db
    .insert(researchSources)
    .values({
      sourceType: item.sourceType,
      title: item.title.slice(0, 500),
      url: item.url,
      author: item.author ?? null,
      repository: item.repository ?? null,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      summary: item.summary.slice(0, 4000),
      relevantConcept: item.relevantConcept ?? '',
      advantages: item.advantages ?? [],
      disadvantages: item.disadvantages ?? [],
      risk: item.risk ?? '',
      implementationIdea: item.implementationIdea ?? '',
      license: item.license ?? null,
      termsConcerns: item.termsConcerns ?? '',
      github: item.github ?? null,
      architecture: item.architecture ?? '',
      knownLimitations: item.knownLimitations ?? '',
      monitorCategory: item.monitorCategory ?? null,
      relevance: item.relevance ?? null,
      origin,
      tags: item.tags ?? [],
    })
    .onConflictDoNothing({ target: researchSources.url })
    .returning({ id: researchSources.id });
  if (row) return { id: row.id, created: true };
  const [again] = await db.select({ id: researchSources.id }).from(researchSources).where(eq(researchSources.url, item.url));
  return { id: again!.id, created: false };
}

export async function seedResearchSources(ctx: PlatformContext): Promise<Map<string, string[]>> {
  const byStrategy = new Map<string, string[]>();
  for (const s of SEED_SOURCES) {
    const { id } = await upsertSource(ctx.db, s, 'SEED');
    for (const target of s.informs) byStrategy.set(target, [...(byStrategy.get(target) ?? []), id]);
  }
  return byStrategy;
}

export async function linkSourcesToExperiment(db: DbOrTx, experimentId: string, sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  await db.insert(experimentSources).values(sourceIds.map((sourceId) => ({ experimentId, sourceId }))).onConflictDoNothing();
}

/** Research monitor job: new projects, papers and launches into the research database. */
export async function runMonitor(ctx: PlatformContext, actor: Actor): Promise<{ found: number; added: number; errors: string[] }> {
  if (!ctx.config.RESEARCH_MONITOR_ENABLED) return { found: 0, added: 0, errors: ['research monitor disabled (RESEARCH_MONITOR_ENABLED=false)'] };
  const res = await runResearchMonitor(ctx.marketData.http, { githubToken: ctx.config.GITHUB_TOKEN });
  let added = 0;
  for (const item of res.items) {
    const r = await upsertSource(ctx.db, item, 'MONITOR');
    if (r.created) added++;
  }
  if (added > 0) {
    await audit(ctx.db, actor, 'RESEARCH_ADDED', { type: 'research_source' }, { added, found: res.items.length });
    await notify(ctx, { type: 'IDEA_DISCOVERED', title: `Research monitor: ${added} new item(s)`, body: res.items.slice(0, 3).map((i) => i.title).join(' · ') });
  }
  if (res.errors.length > 0) await recordEvent(ctx.db, 'WARN', 'research', 'MONITOR_ERRORS', `${res.errors.length} research source(s) failed`, { errors: res.errors.slice(0, 10) });
  return { found: res.items.length, added, errors: res.errors };
}

export async function insertIdea(db: DbOrTx, draft: IdeaDraft, actor: Actor): Promise<{ id: string; created: boolean }> {
  const normalizedName = normalizeTitle(draft.name);
  const [existing] = await db.select({ id: ideas.id }).from(ideas).where(eq(ideas.normalizedName, normalizedName));
  if (existing) return { id: existing.id, created: false };
  const assessment = scoreIdea({
    automation: draft.automationScore,
    complexity: draft.complexityScore,
    scalability: draft.scalabilityScore,
    testability: draft.testabilityScore,
    estimatedCapital: draft.estimatedCapital,
    regulatoryRiskCount: draft.regulatoryRisks.length,
  });
  const [row] = await db
    .insert(ideas)
    .values({
      name: draft.name,
      normalizedName,
      category: draft.category,
      description: draft.description,
      origin: draft.origin,
      status: 'NEW',
      estimatedCapital: draft.estimatedCapital !== null ? toDb(draft.estimatedCapital) : null,
      automationScore: draft.automationScore,
      complexityScore: draft.complexityScore,
      scalabilityScore: draft.scalabilityScore,
      testabilityScore: draft.testabilityScore,
      revenueSource: draft.revenueSource,
      risks: draft.risks,
      dependencies: draft.dependencies,
      regulatoryRisks: draft.regulatoryRisks,
      assessment: { ...assessment, notes: [...assessment.notes, ...draft.notes], templateOverrides: draft.templateOverrides ?? null },
      suggestedStrategyId: draft.suggestedStrategyId,
    })
    .onConflictDoNothing({ target: ideas.normalizedName })
    .returning({ id: ideas.id });
  if (!row) return { id: '', created: false };
  for (const s of draft.sources) {
    const src = await upsertSource(db, s, draft.origin);
    await db.insert(ideaSources).values({ ideaId: row.id, sourceId: src.id }).onConflictDoNothing();
  }
  await audit(db, actor, 'IDEA_ADDED', { type: 'idea', id: row.id }, { name: draft.name, origin: draft.origin, suggestedStrategyId: draft.suggestedStrategyId });
  return { id: row.id, created: true };
}

/** Idea generator job: catalogue ideas always, Claude-generated ideas when configured. */
export async function generateIdeas(ctx: PlatformContext, opts: { focus: IdeaFocus; count: number; useLlm?: boolean }, actor: Actor): Promise<{ added: number; origin: string; notes: string[] }> {
  const existing = await ctx.db.select({ n: ideas.normalizedName, name: ideas.name }).from(ideas);
  const exclude = new Set(existing.map((e) => e.n));
  const notes: string[] = [];
  let drafts: IdeaDraft[] = [];
  let origin = 'CATALOG';
  const llmReady = ctx.config.IDEA_GENERATOR_LLM_ENABLED && !!ctx.config.ANTHROPIC_API_KEY;
  if ((opts.useLlm ?? true) && llmReady) {
    try {
      const res = await generateLlmIdeas({ apiKey: ctx.config.ANTHROPIC_API_KEY!, model: ctx.config.LLM_MODEL, focus: opts.focus, count: opts.count, existingNames: existing.map((e) => e.name) });
      drafts = res.ideas;
      origin = `LLM (${res.model})`;
      ctx.marketData.health.success('anthropic.messages', Date.now(), 0);
    } catch (e) {
      ctx.marketData.health.failure('anthropic.messages', Date.now(), describeError(e).message);
      notes.push(`LLM generator failed (${describeError(e).message}); used the catalogue instead`);
    }
  }
  if (drafts.length === 0) drafts = generateCatalogIdeas({ seed: `${ctx.clock.now().toISOString().slice(0, 10)}/${opts.focus}`, count: opts.count, focus: opts.focus, exclude });
  let added = 0;
  for (const dft of drafts) {
    if (exclude.has(normalizeTitle(dft.name))) continue;
    const r = await insertIdea(ctx.db, dft, actor);
    if (r.created) added++;
  }
  if (added > 0) await notify(ctx, { type: 'IDEA_DISCOVERED', title: `${added} new idea(s) (${origin})`, body: drafts.slice(0, 3).map((x) => x.name).join(' · ') });
  return { added, origin, notes };
}

/**
 * Turn new ideas that an existing module can test into experiments
 * (DISCOVERED, waiting for a human to start them); mark the rest TRIAGED.
 */
export async function triageIdeas(ctx: PlatformContext, actor: Actor, maxConvert = 2): Promise<{ converted: number; triaged: number }> {
  const fresh = await ctx.db.select().from(ideas).where(eq(ideas.status, 'NEW')).orderBy(desc(ideas.createdAt)).limit(100);
  const convertible = fresh
    .filter((i) => i.suggestedStrategyId && ctx.registry.has(i.suggestedStrategyId))
    .sort((a, b) => Number((b.assessment as { score?: number }).score ?? 0) - Number((a.assessment as { score?: number }).score ?? 0));
  let converted = 0;
  for (const idea of convertible.slice(0, maxConvert)) {
    const overrides = (idea.assessment as { templateOverrides?: { params?: Record<string, unknown>; assumptions?: Record<string, { low?: number; mode?: number; high?: number }> } | null }).templateOverrides ?? null;
    const exp = await createExperiment(ctx, { strategyId: idea.suggestedStrategyId!, name: idea.name, description: idea.description, ideaId: idea.id, params: overrides?.params, assumptionOverrides: overrides?.assumptions }, actor);
    const srcs = await ctx.db.select({ id: ideaSources.sourceId }).from(ideaSources).where(eq(ideaSources.ideaId, idea.id));
    await linkSourcesToExperiment(ctx.db, exp.id, srcs.map((s) => s.id));
    await ctx.db.update(ideas).set({ status: 'CONVERTED', experimentId: exp.id, updatedAt: new Date() }).where(eq(ideas.id, idea.id));
    await audit(ctx.db, actor, 'IDEA_CONVERTED', { type: 'idea', id: idea.id, experimentId: exp.id }, { strategyId: idea.suggestedStrategyId });
    converted++;
  }
  const rest = fresh.filter((i) => !convertible.slice(0, maxConvert).includes(i));
  for (const i of rest) await ctx.db.update(ideas).set({ status: 'TRIAGED', updatedAt: new Date() }).where(and(eq(ideas.id, i.id), eq(ideas.status, 'NEW')));
  return { converted, triaged: rest.length };
}

/** A human starts testing a DISCOVERED experiment. */
export async function startResearch(ctx: PlatformContext, experimentId: string, actor: Actor): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [exp] = await tx.select().from(experiments).where(eq(experiments.id, experimentId)).for('update');
    if (!exp) throw new NotFoundError('experiment', experimentId);
    if ((await getEmergencyStop(tx)).engaged) throw new EmergencyStopError('the emergency stop is engaged; release it before starting experiments');
    await transition(ctx, tx, exp, 'RESEARCHING', { actor, by: 'USER', reason: 'research started' });
  });
}

